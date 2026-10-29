import assert from 'node:assert/strict'
import { webcrypto, createCipheriv } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { cid, decrypt, envelope, installHost, opts } from './support/host.mjs'

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
// sdkVersion 的唯一真源是 package.json，避免测试与源码出现双源。
const { version: sdkVersion } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const event = { kind: 'javascript', occurredAt: 123, message: '测试💥' }
const originalFetch = globalThis.fetch

/**
 * 安装宿主环境并重置 SDK 状态
 * @param handler 事件请求的处理函数
 * @returns 模拟存储内容
 */
function setup(handler) {
  sdk.stop()
  return installHost({ handler }).entries
}

test('内部事件加密后发送，按字节限制并清理 URL', async () => {
  const sent = []
  setup(async (url, options) => {
    sent.push({ url, ...options })
    return envelope(null)
  })
  assert.equal(await sdk.sendInternalEvent(event), 'dropped')
  assert.equal((await sdk.init(opts)).status, 'allowed')
  assert.equal(
    await sdk.sendInternalEvent({
      ...event,
      message: '💥'.repeat(5000),
      stack: '错'.repeat(10000),
      pagePath: '/abc?secret=1#x',
      source: { url: 'https://x.test/a?token=x#b', line: 10 },
    }),
    'accepted',
  )
  assert.equal(await sdk.sendInternalEvent({ ...event, message: { circular: true } }), 'accepted')
  assert.equal(await sdk.sendInternalEvent({ ...event, message: new Error('boom') }), 'accepted')
  const first = JSON.parse(sent[0].body)
  const second = JSON.parse(sent[1].body)
  const plaintext = decrypt(first)
  assert.notEqual(first.eventId, second.eventId)
  assert.equal(plaintext.eventId, first.eventId)
  assert.equal(plaintext.sdkVersion, sdkVersion)
  assert.equal(plaintext.pagePath, '/abc')
  assert.equal(plaintext.source.url, 'https://x.test/a')
  assert.ok(Buffer.byteLength(JSON.stringify(plaintext)) <= 32768)
  assert.equal(decrypt(second).message, '[object]')
  assert.equal(decrypt(JSON.parse(sent[2].body)).message, 'Error: boom')
  assert.equal(sent[0].credentials, 'omit')
  assert.equal(sent[0].referrerPolicy, 'no-referrer')
  sdk.stop()
})

test('生产发送器按公开向量固定参数生成互通密文', async () => {
  const vector = JSON.parse(await readFile(new URL('./fixtures/protocol-v1.json', import.meta.url), 'utf8')).vectors[0]
  let sent
  // 该用例需要按向量固定 CID 与事件标识，因此自行替换 setup 安装的 fetch。
  setup()
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/cids')) return envelope({ cid: vector.cid })
    if (url.endsWith('/admission')) return envelope({ allowed: true })
    sent = JSON.parse(options.body)
    return envelope(null)
  }
  const oldNow = Date.now
  try {
    await sdk.init({ ...opts, appId: vector.appId })
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        subtle: webcrypto.subtle,
        getRandomValues: (bytes) => {
          bytes.set(Buffer.from(bytes.length === 16 ? vector.eventId : vector.iv, 'base64url'))
          return bytes
        },
      },
    })
    Date.now = () => vector.sentAt
    const plain = JSON.parse(vector.plaintextJson)
    assert.equal(await sdk.sendInternalEvent({ kind: plain.kind, occurredAt: plain.occurredAt, message: plain.message, source: plain.source }), 'accepted')
    assert.equal(sent.eventId, vector.eventId)
    assert.equal(sent.iv, vector.iv)
    const expectedPlain = { ...plain, sdkVersion }
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(vector.keyHex, 'hex'), Buffer.from(vector.iv, 'base64url'))
    cipher.setAAD(Buffer.from(vector.aadUtf8))
    const expected = Buffer.concat([cipher.update(JSON.stringify(expectedPlain)), cipher.final(), cipher.getAuthTag()]).toString('base64url')
    assert.equal(sent.ciphertext, expected)
  } finally {
    Date.now = oldNow
    sdk.stop()
    globalThis.fetch = originalFetch
  }
})

test('内部事件携带级别、错误类型与有界环境信息', async () => {
  let plaintext
  setup(async (_url, options) => {
    plaintext = decrypt(JSON.parse(options.body))
    return envelope(null)
  })
  try {
    await sdk.init(opts)
    assert.equal(
      await sdk.sendInternalEvent({
        ...event,
        kind: 'img',
        level: 'info',
        environment: { userAgent: '测'.repeat(400), online: false, effectiveType: '4g' },
      }),
      'accepted',
    )
    assert.equal(plaintext.level, 'info')
    assert.equal(plaintext.kind, 'img')
    assert.equal('errorType' in plaintext, false)
    assert.equal(plaintext.environment.online, false)
    assert.equal(plaintext.environment.effectiveType, '4g')
    assert.ok(Buffer.byteLength(plaintext.environment.userAgent) <= 1024)
    assert.equal(await sdk.sendInternalEvent({ ...event, level: 'invalid' }), 'dropped')
    for (const kind of ['javascript', 'unhandledrejection', 'script', 'resource', 'other']) {
      assert.equal(await sdk.sendInternalEvent({ ...event, kind }), 'accepted')
      assert.equal(plaintext.kind, kind)
    }
    assert.equal(await sdk.sendInternalEvent({ ...event, kind: 'invalid' }), 'dropped')
  } finally {
    sdk.stop()
    globalThis.fetch = originalFetch
  }
})

test('环境信息导致超限时优先移除环境并完整保留基础事件', async () => {
  const sent = []
  setup(async (_url, options) => {
    sent.push(JSON.parse(options.body))
    return envelope(null)
  })
  try {
    await sdk.init(opts)
    const message = '\n'.repeat(8192)
    const template = {
      schemaVersion: 1,
      eventId: 'a'.repeat(22),
      appId: opts.appId,
      sdkVersion,
      occurredAt: event.occurredAt,
      kind: event.kind,
      message,
      stack: '',
    }
    const stack = 'x'.repeat(32768 - Buffer.byteLength(JSON.stringify(template)))
    assert.ok(stack.length <= 16384)
    assert.equal(await sdk.sendInternalEvent({ ...event, message, stack }), 'accepted')
    assert.equal(await sdk.sendInternalEvent({ ...event, message, stack, environment: { userAgent: 'test', online: false } }), 'accepted')
    const first = decrypt(sent[0])
    const second = decrypt(sent[1])
    assert.equal(Buffer.byteLength(JSON.stringify(first)), 32768)
    assert.equal(Buffer.byteLength(JSON.stringify(second)), 32768)
    assert.equal(second.message, message)
    assert.equal(second.stack, stack)
    assert.equal('environment' in second, false)
    assert.ok(Buffer.byteLength(JSON.stringify(sent[1])) <= 48 * 1024)
  } finally {
    sdk.stop()
    globalThis.fetch = originalFetch
  }
})

test('基础事件超限时按 JSON 字节缩短堆栈且不拆分多字节字符', async () => {
  let sent
  setup(async (_url, options) => {
    sent = JSON.parse(options.body)
    return envelope(null)
  })
  try {
    await sdk.init(opts)
    const message = '错误'.repeat(1000)
    const stack = '\u0000💥'.repeat(4000)
    assert.equal(await sdk.sendInternalEvent({ ...event, message, stack, environment: { userAgent: 'test' } }), 'accepted')
    const plaintext = decrypt(sent)
    assert.equal(plaintext.message, message)
    assert.equal('environment' in plaintext, false)
    assert.ok(stack.startsWith(plaintext.stack))
    assert.ok(plaintext.stack.length < stack.length)
    assert.ok(Buffer.byteLength(JSON.stringify(plaintext)) <= 32768)
    const next = Array.from(stack).slice(Array.from(plaintext.stack).length)[0]
    assert.ok(Buffer.byteLength(JSON.stringify({ ...plaintext, stack: plaintext.stack + next })) > 32768)
  } finally {
    sdk.stop()
    globalThis.fetch = originalFetch
  }
})

test('移除环境并缩短堆栈后基础事件仍超限时丢弃', async () => {
  let count = 0
  setup(async () => {
    count++
    return envelope(null)
  })
  try {
    await sdk.init(opts)
    assert.equal(await sdk.sendInternalEvent({ ...event, message: '\u0000'.repeat(8192), stack: 'stack', environment: { online: true } }), 'dropped')
    assert.equal(count, 0)
  } finally {
    sdk.stop()
    globalThis.fetch = originalFetch
  }
})

test('网络失败重试复用信封，409 表示结果未知，明确拒绝停止并按需清理 CID', async () => {
  const nativeTimer = globalThis.setTimeout
  const delays = []
  const bodies = []
  const storage = setup(async (_url, options) => {
    bodies.push(options.body)
    if (bodies.length === 1) throw new Error('response lost')
    return envelope({ errorCode: 'REPLAYED' }, 409)
  })
  globalThis.setTimeout = (fn, ms) => {
    delays.push(ms)
    return nativeTimer(fn, ms === 5000 ? 5000 : 0)
  }
  try {
    await sdk.init(opts)
    assert.equal(await sdk.sendInternalEvent(event), 'unknown')
    assert.equal(bodies.length, 2)
    assert.equal(bodies[0], bodies[1])
    assert.ok(delays.includes(1000))
    globalThis.fetch = async () => envelope({ errorCode: 'CID_INVALID' }, 401)
    assert.equal(await sdk.sendInternalEvent(event), 'dropped')
    assert.equal(storage.size, 0)
    assert.equal(await sdk.sendInternalEvent(event), 'dropped')
  } finally {
    globalThis.setTimeout = nativeTimer
    sdk.stop()
    globalThis.fetch = originalFetch
  }
})

test('响应头收到后正文读取中断会重试原信封，非法 JSON 与 4xx 正文故障不会重试', async () => {
  const timer = globalThis.setTimeout
  const bodies = []
  let phase = 'network'
  let resolveText
  setup(async (_url, options) => {
    bodies.push(options.body)
    if (phase === 'network' && bodies.length === 1)
      return {
        status: 200,
        text: async () => {
          throw new TypeError('connection lost')
        },
      }
    if (phase === 'network') return envelope({ errorCode: 'REPLAYED' }, 409)
    if (phase === 'invalid') return { status: 200, text: async () => '{invalid' }
    if (phase === 'rate-timeout')
      return {
        status: 429,
        text: () =>
          new Promise((resolve) => {
            resolveText = resolve
          }),
      }
    return {
      status: 429,
      text: async () => {
        throw new TypeError('connection lost')
      },
    }
  })
  globalThis.setTimeout = (fn, ms) => timer(fn, ms === 5000 && phase !== 'rate-timeout' ? 5000 : 0)
  try {
    await sdk.init(opts)
    assert.equal(await sdk.sendInternalEvent(event), 'unknown')
    assert.equal(bodies.length, 2)
    assert.equal(bodies[0], bodies[1])
    phase = 'invalid'
    assert.equal(await sdk.sendInternalEvent(event), 'dropped')
    phase = 'rate-limit'
    assert.equal(await sdk.sendInternalEvent(event), 'dropped')
    phase = 'rate-timeout'
    assert.equal(await sdk.sendInternalEvent(event), 'dropped')
    assert.equal(bodies.length, 5)
  } finally {
    resolveText?.('')
    globalThis.setTimeout = timer
    sdk.stop()
    globalThis.fetch = originalFetch
  }
})

test('加密准备最多五个，停止后仍占额度直到旧加密任务真正结束', async () => {
  let sent = 0
  setup(async () => {
    sent++
    return envelope(null)
  })
  await sdk.init(opts)
  const pending = []
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
      subtle: {
        importKey: (...args) => new Promise((resolve, reject) => pending.push(() => webcrypto.subtle.importKey(...args).then(resolve, reject))),
        deriveKey: webcrypto.subtle.deriveKey.bind(webcrypto.subtle),
        encrypt: webcrypto.subtle.encrypt.bind(webcrypto.subtle),
      },
    },
  })
  try {
    const first = Array.from({ length: 5 }, () => sdk.sendInternalEvent(event))
    assert.equal(pending.length, 5)
    assert.deepEqual(await Promise.all(Array.from({ length: 50 }, () => sdk.sendInternalEvent(event))), Array(50).fill('dropped'))
    sdk.stop()
    await sdk.init(opts)
    assert.equal(await sdk.sendInternalEvent(event), 'dropped')
    assert.equal(pending.length, 5)
    pending.forEach((resolve) => resolve())
    assert.deepEqual(await Promise.all(first), Array(5).fill('dropped'))
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
    assert.equal(await sdk.sendInternalEvent(event), 'accepted')
    assert.equal(sent, 1)
  } finally {
    sdk.stop()
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  }
})

test('Fetch 同步抛错后释放请求额度并按原信封重试', async () => {
  const timer = globalThis.setTimeout
  const bodies = []
  setup((_url, options) => {
    bodies.push(options.body)
    if (bodies.length === 1) throw new TypeError('fetch failed')
    return Promise.resolve(envelope(null))
  })
  globalThis.setTimeout = (fn, ms) => timer(fn, ms === 5000 ? 5000 : 0)
  try {
    await sdk.init(opts)
    assert.equal(await sdk.sendInternalEvent(event), 'accepted')
    assert.equal(bodies[0], bodies[1])
    assert.equal(await sdk.sendInternalEvent(event), 'accepted')
    assert.equal(bodies.length, 3)
  } finally {
    globalThis.setTimeout = timer
    sdk.stop()
    globalThis.fetch = originalFetch
  }
})

test('实际未结束请求超过五个时丢弃，停止后的迟到响应不改变新代次', async () => {
  const pending = []
  let release = false
  const storage = setup(() => (release ? Promise.resolve(envelope(null)) : new Promise((resolve) => pending.push(resolve))))
  // 统计全部请求，用于判断重新初始化是否真的重新签发 CID 或查询上报策略。
  const requests = []
  const setupFetch = globalThis.fetch
  globalThis.fetch = (url, options) => {
    requests.push(url)
    return setupFetch(url, options)
  }
  try {
    await sdk.init(opts)
    const calls = Array.from({ length: 5 }, () => sdk.sendInternalEvent(event))
    while (pending.length < 5) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.equal(await sdk.sendInternalEvent(event), 'dropped')
    sdk.stop()
    assert.deepEqual(await Promise.all(calls), Array(5).fill('dropped'))
    await sdk.init(opts)
    assert.equal(await sdk.sendInternalEvent(event), 'dropped')
    for (const resolve of pending) resolve(envelope({ errorCode: 'CID_INVALID' }, 401))
    await new Promise((resolve) => setTimeout(resolve, 5))
    const counted = requests.length
    assert.deepEqual(await sdk.init(opts), { status: 'allowed' })
    // 旧代次的迟到 401 不得清理当前 CID 或停止发送器，因此既不再签发也不重新查询。
    assert.equal(requests.length, counted)
    assert.equal(storage.size, 1)
    release = true
    assert.equal(await sdk.sendInternalEvent(event), 'accepted')
  } finally {
    sdk.stop()
    globalThis.fetch = originalFetch
  }
})

test('事件超时后按 1、2、4 秒退避，最多四次并保留完全相同的信封', async () => {
  const timer = globalThis.setTimeout
  const delays = []
  const bodies = []
  const pending = []
  setup((_url, options) => {
    bodies.push(options.body)
    return new Promise((resolve) => pending.push(resolve))
  })
  globalThis.setTimeout = (fn, ms) => {
    delays.push(ms)
    return timer(fn, 0)
  }
  try {
    await sdk.init(opts)
    delays.length = 0
    assert.equal(await sdk.sendInternalEvent(event), 'temporary_failure')
    assert.equal(bodies.length, 4)
    assert.equal(new Set(bodies).size, 1)
    assert.deepEqual(
      delays.filter((ms) => ms !== 5000),
      [1000, 2000, 4000],
    )
    assert.equal(delays.filter((ms) => ms === 5000).length, 4)
  } finally {
    for (const resolve of pending) resolve(envelope(null))
    globalThis.setTimeout = timer
    sdk.stop()
    globalThis.fetch = originalFetch
  }
})

test('拒绝上报保留 CID，普通 401 和无效响应不会终止状态或重试', async () => {
  let reply = envelope(null, 401)
  let count = 0
  const storage = setup(async () => {
    count++
    return reply
  })
  try {
    await sdk.init(opts)
    assert.equal(await sdk.sendInternalEvent(event), 'dropped')
    reply = {
      status: 200,
      text: async () => '{invalid JSON',
    }
    assert.equal(await sdk.sendInternalEvent(event), 'dropped')
    reply = envelope({ errorCode: 'NOT_ALLOWED' }, 403)
    assert.equal(await sdk.sendInternalEvent(event), 'dropped')
    assert.equal(await sdk.sendInternalEvent(event), 'dropped')
    assert.equal(count, 3)
    assert.equal(storage.size, 1)
  } finally {
    sdk.stop()
    globalThis.fetch = originalFetch
  }
})

test('加密失败及循环拒绝值不会产生未处理异常', async () => {
  let count = 0
  setup(async () => {
    count++
    return envelope(null)
  })
  try {
    await sdk.init(opts)
    const cyclic = {}
    cyclic.self = cyclic
    assert.equal(await sdk.sendInternalEvent({ ...event, kind: 'unhandledrejection', message: cyclic }), 'accepted')
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        getRandomValues: () => {
          throw Error('random unavailable')
        },
      },
    })
    assert.equal(await sdk.sendInternalEvent(event), 'dropped')
    assert.equal(count, 1)
  } finally {
    sdk.stop()
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  }
})
