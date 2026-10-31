import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as sdk from '../dist/index.js'
import { cid, decrypt, defaultConfig, envelope, installHost, opts, uninstallHost } from './support/host.mjs'

const nativeFetch = globalThis.fetch

/**
 * 安装宿主环境并重置 SDK 状态
 * @param options 传给 installHost 的允许状态与事件处理函数
 * @returns 宿主状态
 */
function setup(options) {
  sdk.stop()
  return installHost(options)
}

/**
 * 等待已发送事件请求达到预期数量，用于异步加密与发送
 */
async function settle(state, count) {
  for (let i = 0; i < 200 && state.events().length < count; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  // 多等一轮，确保超出的请求或递归发送也能被观察到。
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function cleanup() {
  sdk.stop()
  uninstallHost()
  globalThis.fetch = nativeFetch
}

/** 构造脚本运行错误事件，字段与浏览器 ErrorEvent 一致 */
function jsErrorEvent(state, overrides = {}) {
  const error = new Error('boom')
  error.name = 'TypeError'
  return {
    type: 'error',
    target: state.win,
    message: 'Uncaught TypeError: boom',
    filename: 'https://app.test/main.js?token=1#x',
    lineno: 10,
    colno: 3,
    error,
    ...overrides,
  }
}

/** 构造资源元素加载错误事件，target 为元素本身 */
function resourceEvent(tagName, fields) {
  return { type: 'error', target: { nodeType: 1, tagName, ...fields } }
}

test('自动捕获的事件携带环境信息与自定义上下文', async () => {
  const state = setup()
  try {
    await sdk.init({ ...opts, getContext: () => ({ route: '/orders' }) })
    state.dispatch('error', jsErrorEvent(state))
    await settle(state, 1)
    const plain = decrypt(state.events()[0])
    assert.deepEqual(plain.context, { route: '/orders' })
    assert.deepEqual(plain.environment, { userAgent: 'TestBrowser/1.0', online: true, effectiveType: '4g' })
  } finally {
    cleanup()
  }
})

test('仅在明确允许后安装监听器，重复初始化不重复注册，停止后只移除自身监听器', async () => {
  const hostHandler = () => {}
  const hostListener = () => {}
  const state = setup({ allowed: false })
  state.win.onerror = hostHandler
  // 宿主通过 addEventListener 自行注册的监听器不属于 SDK，停止后必须保留。
  state.win.addEventListener('error', hostListener, true)
  const sdkListeners = () => state.listeners.filter((item) => item.fn !== hostListener)
  try {
    assert.equal((await sdk.init(opts)).status, 'denied')
    assert.equal(sdkListeners().length, 0)
    assert.equal(state.addCalls.length, 1)
    state.allowed = true
    assert.equal((await sdk.init(opts)).status, 'allowed')
    assert.deepEqual(
      sdkListeners().map((item) => [item.type, item.capture]),
      [
        ['error', true],
        ['unhandledrejection', false],
      ],
    )
    assert.equal(state.win.onerror, hostHandler)
    assert.equal((await sdk.init(opts)).status, 'allowed')
    // 重复初始化重新拉取配置并重装采集，当前仍只有一组监听器。
    assert.equal(state.addCalls.length, 5)
    assert.equal(sdkListeners().length, 2)
    sdk.stop()
    assert.deepEqual(
      state.listeners.map((item) => item.fn),
      [hostListener],
    )
    assert.equal(state.win.onerror, hostHandler)
    state.dispatch('error', jsErrorEvent(state))
    await settle(state, 0)
    assert.equal(state.events().length, 0)
    // 停止后重新初始化会重新安装监听器并恢复捕获。
    assert.equal((await sdk.init(opts)).status, 'allowed')
    assert.equal(state.addCalls.length, 7)
    assert.equal(sdkListeners().length, 2)
    state.dispatch('error', jsErrorEvent(state))
    await settle(state, 1)
    assert.equal(state.events().length, 1)
  } finally {
    cleanup()
  }
})

test('等待上报策略期间不缓存也不上报', async () => {
  const state = setup()
  let resolveAdmission
  globalThis.fetch = (url, options) => {
    if (url.endsWith('/admission')) return new Promise((resolve) => (resolveAdmission = resolve))
    return state.fetch(url, options)
  }
  try {
    const initializing = sdk.init(opts)
    while (!resolveAdmission) await new Promise((resolve) => setTimeout(resolve, 1))
    state.dispatch('error', jsErrorEvent(state))
    resolveAdmission(envelope({ allowed: true }))
    assert.equal((await initializing).status, 'allowed')
    await settle(state, 0)
    assert.equal(state.events().length, 0)
    state.dispatch('error', jsErrorEvent(state))
    await settle(state, 1)
    assert.equal(state.events().length, 1)
  } finally {
    cleanup()
  }
})

test('捕获脚本错误并组装名称、堆栈、页面路径与来源行列号', async () => {
  const state = setup()
  try {
    await sdk.init(opts)
    const event = jsErrorEvent(state)
    state.dispatch('error', event)
    await settle(state, 1)
    const plain = decrypt(state.events()[0])
    assert.equal(plain.kind, 'javascript')
    assert.equal(plain.level, 'error')
    assert.equal(plain.message, 'Uncaught TypeError: boom')
    assert.equal(plain.name, 'TypeError')
    assert.equal(plain.stack, event.error.stack)
    assert.equal(plain.pagePath, 'https://app.test/orders')
    assert.deepEqual(plain.source, { url: 'https://app.test/main.js', line: 10, column: 3 })
  } finally {
    cleanup()
  }
})

test('捕获未处理 Promise 拒绝，拒绝值按可安全描述的字段归一化', async () => {
  const state = setup()
  try {
    await sdk.init(opts)
    const error = new Error('rejected')
    state.dispatch('unhandledrejection', { type: 'unhandledrejection', reason: error })
    await settle(state, 1)
    state.dispatch('unhandledrejection', { type: 'unhandledrejection', reason: 'bad value' })
    await settle(state, 2)
    state.dispatch('unhandledrejection', { type: 'unhandledrejection', reason: { code: 1 } })
    await settle(state, 3)
    const events = state.events()
    assert.equal(events.length, 3)
    const [first, second, third] = events.map(decrypt)
    assert.equal(first.kind, 'unhandledrejection')
    assert.equal(first.message, 'Error: rejected')
    assert.equal(first.name, 'Error')
    assert.equal(first.stack, error.stack)
    assert.equal(first.pagePath, 'https://app.test/orders')
    assert.equal(second.message, 'bad value')
    assert.equal(third.message, '[object]')
  } finally {
    cleanup()
  }
})

test('捕获图片、脚本与其他资源加载错误并区分类型', async () => {
  const state = setup()
  try {
    await sdk.init(opts)
    state.dispatch('error', resourceEvent('IMG', { currentSrc: 'https://cdn.test/a.png?token=1#x', src: 'https://cdn.test/a.png' }))
    await settle(state, 1)
    state.dispatch('error', resourceEvent('SCRIPT', { src: 'https://cdn.test/app.js?token=2' }))
    await settle(state, 2)
    state.dispatch('error', resourceEvent('LINK', { href: 'https://cdn.test/app.css' }))
    await settle(state, 3)
    const events = state.events()
    assert.equal(events.length, 3)
    const [image, script, link] = events.map(decrypt)
    assert.equal(image.kind, 'img')
    assert.equal(image.message, 'Failed to load resource: https://cdn.test/a.png')
    assert.deepEqual(image.source, { url: 'https://cdn.test/a.png' })
    assert.equal(image.name, undefined)
    assert.equal(script.kind, 'script')
    assert.deepEqual(script.source, { url: 'https://cdn.test/app.js' })
    assert.equal(link.kind, 'resource')
    assert.deepEqual(link.source, { url: 'https://cdn.test/app.css' })
  } finally {
    cleanup()
  }
})

test('资源地址读取 data 属性并识别 SVG 图片地址', async () => {
  const state = setup()
  try {
    await sdk.init(opts)
    state.dispatch('error', { type: 'error', target: { nodeType: 1, tagName: 'OBJECT', data: 'https://cdn.test/doc.pdf?token=3#p' } })
    await settle(state, 1)
    // SVG 的 href 是 SVGAnimatedString，实际地址位于 baseVal。
    state.dispatch('error', { type: 'error', target: { nodeType: 1, tagName: 'image', href: { baseVal: 'https://cdn.test/icon.svg?token=4' } } })
    await settle(state, 2)
    const [object, image] = state.events().map(decrypt)
    assert.equal(object.kind, 'resource')
    assert.equal(object.message, 'Failed to load resource: https://cdn.test/doc.pdf')
    assert.deepEqual(object.source, { url: 'https://cdn.test/doc.pdf' })
    assert.equal(image.kind, 'img')
    assert.equal(image.message, 'Failed to load resource: https://cdn.test/icon.svg')
    assert.deepEqual(image.source, { url: 'https://cdn.test/icon.svg' })
  } finally {
    cleanup()
  }
})

test('data 与 blob 地址不进入事件内容', async () => {
  const state = setup()
  try {
    await sdk.init(opts)
    // 失败的 data: 图片会把完整载荷放进 currentSrc，事件内容不得携带该载荷。
    state.dispatch('error', resourceEvent('IMG', { currentSrc: `data:image/png;base64,${'A'.repeat(2_000_000)}` }))
    await settle(state, 1)
    state.dispatch('error', resourceEvent('SCRIPT', { src: 'blob:https://app.test/1234' }))
    await settle(state, 2)
    const [image, script] = state.events().map(decrypt)
    assert.equal(image.message, 'Failed to load resource: IMG')
    assert.equal('source' in image, false)
    assert.equal(script.message, 'Failed to load resource: SCRIPT')
    assert.equal('source' in script, false)
  } finally {
    cleanup()
  }
})

test('跨域受限或缺少堆栈时仍上报可获得的信息', async () => {
  const state = setup()
  try {
    await sdk.init(opts)
    state.dispatch('error', { type: 'error', target: state.win, message: 'Script error.', filename: '', lineno: 0, colno: 0, error: null })
    await settle(state, 1)
    const plain = decrypt(state.events()[0])
    assert.equal(plain.kind, 'javascript')
    assert.equal(plain.message, 'Script error.')
    assert.equal('name' in plain, false)
    assert.equal('stack' in plain, false)
    assert.equal('source' in plain, false)
    assert.equal(plain.pagePath, 'https://app.test/orders')
  } finally {
    cleanup()
  }
})

test('不阻止默认行为、不影响宿主处理器，同一事件对象只处理一次，读取异常不外泄', async () => {
  const hostHandler = () => {}
  const state = setup()
  state.win.onerror = hostHandler
  try {
    await sdk.init(opts)
    let prevented = 0
    const event = jsErrorEvent(state, {
      preventDefault: () => prevented++,
      stopPropagation: () => prevented++,
    })
    state.dispatch('error', event)
    state.dispatch('error', event)
    await settle(state, 1)
    const hostile = {
      type: 'error',
      target: {},
      get message() {
        throw new Error('message')
      },
      get error() {
        throw new Error('error')
      },
      get filename() {
        throw new Error('filename')
      },
      get lineno() {
        throw new Error('lineno')
      },
      get colno() {
        throw new Error('colno')
      },
    }
    state.dispatch('error', hostile)
    await settle(state, 2)
    assert.equal(state.events().length, 2)
    assert.equal(decrypt(state.events()[0]).kind, 'javascript')
    assert.equal(decrypt(state.events()[1]).message, 'Script error.')
    assert.equal(prevented, 0)
    assert.equal(state.win.onerror, hostHandler)
  } finally {
    cleanup()
  }
})

test('事件风暴受并发上限约束且不产生未处理拒绝', async () => {
  const state = setup()
  const pending = []
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  globalThis.fetch = (url, options) => {
    if (url.endsWith('/cids')) return Promise.resolve(envelope({ cid }))
    if (url.endsWith('/admission')) return Promise.resolve(envelope({ allowed: true }))
    if (url.endsWith('/config')) return Promise.resolve(envelope(defaultConfig()))
    state.requests.push({ url, options })
    return new Promise((resolve) => pending.push(resolve))
  }
  try {
    await sdk.init(opts)
    for (let i = 0; i < 20; i++) state.dispatch('error', jsErrorEvent(state))
    for (let i = 0; i < 200 && state.events().length < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    // 准备任务与请求各有 5 个额度，超出的事件直接丢弃。
    assert.equal(state.events().length, 5)
    for (const resolve of pending) resolve(envelope(null))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(state.events().length, 5)
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
    cleanup()
  }
})

test('超出并发额度的事件在组装前丢弃', async () => {
  const state = setup()
  let reads = 0
  state.win.location = {
    get href() {
      reads++
      return 'https://app.test/orders'
    },
  }
  try {
    await sdk.init(opts)
    for (let i = 0; i < 20; i++) state.dispatch('error', jsErrorEvent(state))
    await settle(state, 5)
    // 组装阶段会读取页面地址；只有实际进入发送队列的前五个事件允许组装。
    assert.equal(reads, 5)
  } finally {
    cleanup()
  }
})

test('事件发送网络失败按既有重试处理，不产生递归上报或未处理拒绝', async () => {
  const state = setup()
  const timer = globalThis.setTimeout
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  let eventCalls = 0
  globalThis.fetch = (url, options) => {
    if (url.endsWith('/cids')) return Promise.resolve(envelope({ cid }))
    if (url.endsWith('/admission')) return Promise.resolve(envelope({ allowed: true }))
    if (url.endsWith('/config')) return Promise.resolve(envelope(defaultConfig()))
    state.requests.push({ url, options })
    eventCalls++
    return Promise.reject(new TypeError('network'))
  }
  // 压缩 1、2、4 秒退避，保留 5 秒超时语义。
  globalThis.setTimeout = (fn, ms) => timer(fn, ms === 5000 ? 5000 : 0)
  try {
    await sdk.init(opts)
    state.dispatch('error', jsErrorEvent(state))
    for (let i = 0; i < 200 && eventCalls < 4; i++) await new Promise((resolve) => timer(resolve, 5))
    assert.equal(eventCalls, 4)
    await new Promise((resolve) => timer(resolve, 20))
    assert.equal(eventCalls, 4)
    assert.deepEqual(unhandled, [])
  } finally {
    globalThis.setTimeout = timer
    process.off('unhandledRejection', onUnhandled)
    cleanup()
  }
})

test('缺少监听能力或不支持 unhandledrejection 时配置拉取后返回不可用', async () => {
  const state = setup()
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
    assert.deepEqual(await sdk.init(opts), { status: 'unavailable' })
    assert.equal(state.requests.length, 3)
    Reflect.deleteProperty(globalThis, 'window')
    assert.deepEqual(await sdk.init(opts), { status: 'unavailable' })
    assert.equal(state.requests.length, 5)
    // 浏览器对未知事件类型的 addEventListener 不会报错，配置需要浏览器采集时必须判定不可用。
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { addEventListener() {}, removeEventListener() {} },
    })
    assert.deepEqual(await sdk.init(opts), { status: 'unavailable' })
    assert.equal(state.requests.length, 7)
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        onunhandledrejection: null,
        addEventListener() {
          throw new Error('blocked')
        },
        removeEventListener() {},
      },
    })
    // 探测通过但注册抛错时仍须以可观察状态表明无法监控；恢复可安装窗口后重新初始化即可捕获。
    assert.deepEqual(await sdk.init(opts), { status: 'unavailable' })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: state.win })
    assert.equal((await sdk.init(opts)).status, 'allowed')
    state.dispatch('error', jsErrorEvent(state))
    await settle(state, 1)
    assert.equal(state.events().length, 1)
  } finally {
    cleanup()
  }
})

test('移除监听器抛错时保留跟踪，重新初始化不会重复注册', async () => {
  const state = setup()
  const remove = state.win.removeEventListener
  try {
    assert.equal((await sdk.init(opts)).status, 'allowed')
    assert.equal(state.listeners.length, 2)
    state.win.removeEventListener = (type, fn, options) => {
      if (type === 'error') throw new Error('blocked')
      remove.call(state.win, type, fn, options)
    }
    sdk.stop()
    // 另一个监听器仍被移除；未能移除的 error 监听器保留在跟踪状态中等待重试。
    assert.deepEqual(
      state.listeners.map((item) => item.type),
      ['error'],
    )
    // 无法清理上一次安装时不得再注册，否则同一错误会被上报两次。
    assert.deepEqual(await sdk.init(opts), { status: 'unavailable' })
    assert.equal(state.listeners.length, 1)
    state.win.removeEventListener = remove
    assert.equal((await sdk.init(opts)).status, 'allowed')
    assert.equal(state.listeners.length, 2)
    state.dispatch('error', jsErrorEvent(state))
    await settle(state, 1)
    assert.equal(state.events().length, 1)
  } finally {
    state.win.removeEventListener = remove
    cleanup()
  }
})

test('第二个监听器注册失败时回滚第一个，避免泄漏和重复注册', async () => {
  const state = setup()
  const add = state.win.addEventListener
  const remove = state.win.removeEventListener
  try {
    // 第一个监听器注册成功，第二个失败，且回滚移除也失败：监听器必须被记录以便后续移除。
    state.win.addEventListener = (type, fn, options) => {
      if (type === 'unhandledrejection') throw new Error('blocked add')
      add.call(state.win, type, fn, options)
    }
    state.win.removeEventListener = (type, fn, options) => {
      if (type === 'error') throw new Error('blocked remove')
      remove.call(state.win, type, fn, options)
    }
    assert.deepEqual(await sdk.init(opts), { status: 'unavailable' })
    assert.deepEqual(
      state.listeners.map((item) => item.type),
      ['error'],
    )
    state.win.addEventListener = add
    state.win.removeEventListener = remove
    // 恢复后重新初始化会先移除残留监听器，因此只存在 SDK 自己的一对监听器。
    assert.equal((await sdk.init(opts)).status, 'allowed')
    assert.equal(state.listeners.length, 2)
    state.dispatch('error', jsErrorEvent(state))
    await settle(state, 1)
    assert.equal(state.events().length, 1)
  } finally {
    state.win.addEventListener = add
    state.win.removeEventListener = remove
    cleanup()
  }
})
