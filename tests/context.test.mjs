import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { decrypt, envelope, installHost, opts, uninstallHost } from './support/host.mjs'

// 将公开入口和内部发送器构建在同一模块，测试生产源码但不新增公开导出。
const bundle = await build({
  stdin: {
    contents: "export { init, stop } from './src/index.ts'; export { sendInternalEvent } from './src/event.ts'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2019',
})
const sdk = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`)
const event = { kind: 'javascript', occurredAt: 123, message: '测试💥' }
const nativeFetch = globalThis.fetch

/**
 * 安装宿主环境并重置 SDK 状态
 * @param options 宿主选项
 * @returns 宿主状态
 */
function setup(options) {
  sdk.stop()
  return installHost(options)
}

/** 清理宿主与 SDK 状态。 */
function cleanup() {
  sdk.stop()
  uninstallHost()
  globalThis.fetch = nativeFetch
}

/** 记录解密后的明文。 */
function collector() {
  const plains = []
  const handler = async (_url, options) => {
    plains.push(decrypt(JSON.parse(options.body)))
    return envelope(null)
  }
  return { plains, handler }
}

test('自动采集浏览器环境，显式字段优先且缺失 API 时省略', async () => {
  const { plains, handler } = collector()
  const state = setup({ handler })
  try {
    await sdk.init(opts)
    assert.equal(await sdk.sendInternalEvent(event), 'accepted')
    assert.deepEqual(plains[0].environment, { userAgent: 'TestBrowser/1.0', online: true, effectiveType: '4g' })
    assert.equal(await sdk.sendInternalEvent({ ...event, environment: { userAgent: 'Custom/2', online: false } }), 'accepted')
    assert.deepEqual(plains[1].environment, { userAgent: 'Custom/2', online: false, effectiveType: '4g' })
    state.navigator.connection = undefined
    assert.equal(await sdk.sendInternalEvent(event), 'accepted')
    assert.deepEqual(plains[2].environment, { userAgent: 'TestBrowser/1.0', online: true })
    assert.equal('context' in plains[2], false)
  } finally {
    cleanup()
  }
})

test('navigator 属性读取抛错或能力缺失时不影响事件发送', async () => {
  const { plains, handler } = collector()
  const navigator = {}
  for (const key of ['userAgent', 'onLine', 'connection']) {
    Object.defineProperty(navigator, key, {
      get() {
        throw new Error(`denied:${key}`)
      },
    })
  }
  setup({ handler, navigator })
  try {
    await sdk.init(opts)
    assert.equal(await sdk.sendInternalEvent(event), 'accepted')
    assert.equal('environment' in plains[0], false)
  } finally {
    cleanup()
  }
})

test('每个事件调用一次上下文回调，结果作为独立 context 且不覆盖事件字段', async () => {
  const { plains, handler } = collector()
  let route = '/a'
  let calls = 0
  setup({ handler })
  try {
    await sdk.init({
      ...opts,
      getContext: () => {
        calls++
        return { route, eventId: 'fake', kind: 'fake' }
      },
    })
    assert.equal(await sdk.sendInternalEvent(event), 'accepted')
    assert.equal(calls, 1)
    assert.deepEqual(plains[0].context, { route: '/a', eventId: 'fake', kind: 'fake' })
    assert.notEqual(plains[0].eventId, 'fake')
    assert.equal(plains[0].kind, 'javascript')
    route = '/b'
    assert.equal(await sdk.sendInternalEvent(event), 'accepted')
    assert.equal(calls, 2)
    assert.deepEqual(plains[1].context, { route: '/b', eventId: 'fake', kind: 'fake' })
    assert.notEqual(plains[0].eventId, plains[1].eventId)
    await sdk.init({ ...opts, getContext: async () => ({ user: 1 }) })
    assert.equal(await sdk.sendInternalEvent(event), 'accepted')
    assert.deepEqual(plains[2].context, { user: 1 })
  } finally {
    cleanup()
  }
})

test('回调抛错、拒绝、非法值或无法安全归一化时丢弃上下文并继续发送基础事件', async () => {
  const { plains, handler } = collector()
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  let produce = () => ({ ok: true })
  setup({ handler })
  try {
    await sdk.init({ ...opts, getContext: () => produce() })
    const invalid = [
      () => {
        throw new Error('sync')
      },
      () => Promise.reject(new Error('async')),
      () => [],
      () => null,
      () => 'text',
      () => ({ ok: true, bad: undefined }),
      () => ({ date: new Date(0) }),
      () => ({ big: 1n }),
      () => ({ nan: Number.NaN }),
      () => ({ infinite: Number.POSITIVE_INFINITY }),
      () => {
        const value = {}
        value.self = value
        return value
      },
    ]
    for (const factory of invalid) {
      produce = factory
      assert.equal(await sdk.sendInternalEvent(event), 'accepted')
      assert.equal('context' in plains.at(-1), false)
    }
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
    cleanup()
  }
})

test('上下文回调最多等待 1 秒，迟到拒绝不产生未处理异常', async () => {
  const { plains, handler } = collector()
  const timer = globalThis.setTimeout
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  let reject
  setup({ handler })
  // 压缩 1 秒上下文超时，保留其他定时器语义。
  globalThis.setTimeout = (fn, ms) => timer(fn, ms === 1000 ? 0 : ms)
  try {
    await sdk.init({
      ...opts,
      getContext: () =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise
        }),
    })
    assert.equal(await sdk.sendInternalEvent(event), 'accepted')
    assert.equal('context' in plains[0], false)
    reject(new Error('late'))
    await new Promise((resolve) => timer(resolve, 10))
    assert.deepEqual(unhandled, [])
  } finally {
    globalThis.setTimeout = timer
    process.off('unhandledRejection', onUnhandled)
    cleanup()
  }
})

test('最多保留五个未结束的上下文回调，超限跳过回调并发送基础事件', async () => {
  const { plains, handler } = collector()
  const timer = globalThis.setTimeout
  let calls = 0
  const resolvers = []
  setup({ handler })
  globalThis.setTimeout = (fn, ms) => timer(fn, ms === 1000 ? 0 : ms)
  try {
    await sdk.init({
      ...opts,
      getContext: () => {
        calls++
        return new Promise((resolve) => resolvers.push(resolve))
      },
    })
    for (let i = 0; i < 6; i++) assert.equal(await sdk.sendInternalEvent(event), 'accepted')
    assert.equal(calls, 5)
    assert.equal(plains.length, 6)
    for (const plain of plains) assert.equal('context' in plain, false)
    resolvers.forEach((resolve) => resolve({ recovered: true }))
    await new Promise((resolve) => timer(resolve, 10))
  } finally {
    globalThis.setTimeout = timer
    cleanup()
  }
})

test('上下文并发额度按初始化代次独立计算，停止后旧回调不阻塞新一代', async () => {
  const { plains, handler } = collector()
  const timer = globalThis.setTimeout
  const resolvers = []
  let calls = 0
  setup({ handler })
  globalThis.setTimeout = (fn, ms) => timer(fn, ms === 1000 ? 0 : ms)
  try {
    await sdk.init({
      ...opts,
      getContext: () => {
        calls++
        return new Promise((resolve) => resolvers.push(resolve))
      },
    })
    for (let i = 0; i < 6; i++) assert.equal(await sdk.sendInternalEvent(event), 'accepted')
    assert.equal(calls, 5)
    // 旧代次的回调仍未结束，新一代次重新计算额度，不被旧回调永久占用。
    sdk.stop()
    await sdk.init({ ...opts, getContext: () => (calls++, { generation: 'new' }) })
    assert.equal(await sdk.sendInternalEvent(event), 'accepted')
    assert.equal(calls, 6)
    assert.deepEqual(plains.at(-1).context, { generation: 'new' })
  } finally {
    globalThis.setTimeout = timer
    resolvers.forEach((resolve) => resolve({}))
    cleanup()
  }
})

test('明文超限时先移除 context 再移除环境，基础事件与堆栈保留', async () => {
  const { plains, handler } = collector()
  setup({ handler })
  try {
    await sdk.init(opts)
    const stack = 's'.repeat(16384)
    assert.equal(
      await sdk.sendInternalEvent({
        ...event,
        message: 'm'.repeat(8192),
        name: 'n'.repeat(1024),
        pagePath: `/${'p'.repeat(2047)}`,
        source: { url: `https://x.test/${'a'.repeat(2035)}` },
        stack,
        environment: { userAgent: 'u', online: true, effectiveType: '4g' },
        context: { pad: 'c'.repeat(4000) },
      }),
      'accepted',
    )
    const plain = plains[0]
    assert.equal('context' in plain, false)
    assert.deepEqual(plain.environment, { userAgent: 'u', online: true, effectiveType: '4g' })
    assert.equal(plain.stack, stack)
    assert.ok(Buffer.byteLength(JSON.stringify(plain)) <= 32768)
  } finally {
    cleanup()
  }
})

test('上下文按字段长度、对象规模、嵌套深度与整体体积限制，超限整体丢弃', async () => {
  const { plains, handler } = collector()
  let produce
  setup({ handler })
  try {
    await sdk.init({ ...opts, getContext: () => produce() })
    const invalid = [
      { value: 'x'.repeat(513) },
      Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`k${index}`, index])),
      { list: Array.from({ length: 21 }, () => 1) },
      { a: { b: { c: { d: 1 } } } },
      { ['k'.repeat(65)]: 1 },
      Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`k${index}`, 'x'.repeat(512)])),
    ]
    for (const value of invalid) {
      produce = () => value
      assert.equal(await sdk.sendInternalEvent(event), 'accepted')
      assert.equal('context' in plains.at(-1), false)
    }
    const valid = [
      { value: 'x'.repeat(512) },
      Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, index])),
      { list: Array.from({ length: 20 }, () => 1) },
      { a: { b: { c: 1 } } },
      { ['k'.repeat(64)]: 1 },
    ]
    for (const value of valid) {
      produce = () => value
      assert.equal(await sdk.sendInternalEvent(event), 'accepted')
      assert.deepEqual(plains.at(-1).context, value)
    }
  } finally {
    cleanup()
  }
})

test('未允许或停止后不调用上下文回调', async () => {
  const { handler } = collector()
  let calls = 0
  setup({ allowed: false, handler })
  try {
    await sdk.init({ ...opts, getContext: () => (calls++, {}) })
    assert.equal(await sdk.sendInternalEvent(event), 'dropped')
    assert.equal(calls, 0)
  } finally {
    cleanup()
  }
  setup({ handler })
  try {
    await sdk.init({ ...opts, getContext: () => (calls++, {}) })
    sdk.stop()
    assert.equal(await sdk.sendInternalEvent(event), 'dropped')
    assert.equal(calls, 0)
  } finally {
    cleanup()
  }
})
