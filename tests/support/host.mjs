import { createDecipheriv, hkdfSync, webcrypto } from 'node:crypto'

/** 测试使用的规范 CID：32 字节固定内容，便于解密断言。 */
export const cid = Buffer.alloc(32, 42).toString('base64url')

/** 测试使用的初始化配置。 */
export const opts = { serverUrl: 'https://example.test/prefix', appId: 'project1' }

/**
 * 构造统一响应
 * @param data 响应 data 字段
 * @param status HTTP 状态码
 * @returns 具有 text() 的最小响应对象
 */
export const envelope = (data, status = 200) => ({
  status,
  text: async () => JSON.stringify({ code: status, message: 'ok', timestamp: 'now', data }),
})

/**
 * 安装测试宿主环境
 * @description 提供 Web Crypto、可读写存储、记录监听器的窗口和可替换的 fetch。窗口声明 onunhandledrejection，
 * 因为初始化会显式探测该能力；缺少时无法进入允许状态
 * @param options.allowed 上报策略判定结果，可在测试运行中修改
 * @param options.handler 事件请求的处理函数，默认接受全部事件
 * @returns 宿主状态：entries、requests、listeners、addCalls、removeCalls、win、dispatch 与 events
 */
export function installHost({ allowed = true, handler } = {}) {
  const state = {
    allowed,
    handler: handler ?? (() => envelope(null)),
    entries: new Map(),
    requests: [],
    listeners: [],
    addCalls: [],
    removeCalls: [],
    win: undefined,
  }
  const { entries } = state
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => entries.set(key, value),
      removeItem: (key) => entries.delete(key),
    },
  })
  state.win = {
    onerror: undefined,
    onunhandledrejection: null,
    location: { href: 'https://app.test/orders?token=1#top' },
    addEventListener(type, fn, options) {
      state.addCalls.push({ type, fn, capture: options === true })
      state.listeners.push({ type, fn, capture: options === true })
    },
    removeEventListener(type, fn, options) {
      state.removeCalls.push({ type, fn, capture: options === true })
      const index = state.listeners.findIndex((item) => item.type === type && item.fn === fn && item.capture === (options === true))
      if (index >= 0) state.listeners.splice(index, 1)
    },
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: state.win })
  state.fetch = (url, options) => {
    state.requests.push({ url, options })
    if (url.endsWith('/cids')) return Promise.resolve(envelope({ cid }))
    if (url.endsWith('/admission')) return Promise.resolve(envelope({ allowed: state.allowed }))
    return Promise.resolve(state.handler(url, options))
  }
  globalThis.fetch = (url, options) => state.fetch(url, options)
  state.events = () => state.requests.filter((request) => request.url.endsWith('/events'))
  state.dispatch = (type, event) => {
    for (const item of [...state.listeners]) if (item.type === type) item.fn(event)
  }
  return state
}

/** 移除模拟窗口与存储，避免影响后续用例。 */
export function uninstallHost() {
  Reflect.deleteProperty(globalThis, 'window')
  Reflect.deleteProperty(globalThis, 'localStorage')
  Reflect.deleteProperty(globalThis, 'crypto')
}

/**
 * 解密事件请求或信封对象
 * @param value 记录下来的事件请求，或已解析的信封对象
 * @returns 事件的明文对象
 */
export function decrypt(value) {
  const sent = value.options ? JSON.parse(value.options.body) : value
  const key = hkdfSync(
    'sha256',
    Buffer.from(cid, 'base64url'),
    Buffer.from('message-reporting/v1'),
    Buffer.from(`aes-256-gcm:${sent.appId}:${sent.eventId}`),
    32,
  )
  const encrypted = Buffer.from(sent.ciphertext, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(sent.iv, 'base64url'))
  decipher.setAAD(Buffer.from(JSON.stringify([1, sent.appId, cid, sent.eventId, sent.sentAt])))
  decipher.setAuthTag(encrypted.subarray(-16))
  return JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString())
}
