/** 事件自定义上下文，只包含可安全序列化的普通 JSON 数据。 */
export type Context = Record<string, unknown>
/** 上下文回调，返回普通对象或其 Promise。 */
export type ContextCallback = () => unknown
/** 读取当前初始化配置中的最新上下文回调。 */
export type ContextProvider = () => ContextCallback | undefined

/** 上下文回调单项最长等待时间，单位毫秒。 */
const CONTEXT_TIMEOUT = 1000
/** 同时未结束的上下文回调上限。 */
const MAX_PENDING_CONTEXTS = 5
/** 归一化后上下文的 JSON UTF-8 字节上限。 */
const MAX_CONTEXT_BYTES = 4096
/** 容器嵌套深度上限，根对象算第 1 层。 */
const MAX_CONTEXT_DEPTH = 3
/** 单个对象允许的键数量上限。 */
const MAX_CONTEXT_KEYS = 20
/** 单个数组允许的项数量上限。 */
const MAX_CONTEXT_ITEMS = 20
/** 单个键的 UTF-8 字节上限。 */
const MAX_CONTEXT_KEY_BYTES = 64
/** 单个字符串值的 UTF-8 字节上限。 */
const MAX_CONTEXT_STRING_BYTES = 512
/** 超时标记，区分回调返回值和等待结果。 */
const TIMEOUT = Symbol('timeout')
/** 无法安全归一化的标记，区分失败与合法的 null。 */
const INVALID = Symbol('invalid')

/**
 * 上下文回调并发额度
 * @description 按初始化代次独立计数；停止或重新初始化后从 0 开始，旧代次回调结束时只归还自己的额度
 */
export interface ContextSession {
  // 本代次仍未结束的回调数量
  pending: number
}

/** 为新的初始化代次创建独立的上下文并发额度。 */
export function createContextSession(): ContextSession {
  return { pending: 0 }
}

/**
 * 校验对象是否为普通 JSON 对象
 * @param value 待校验值
 * @returns 是否为普通对象；数组、null 与其他类型均返回 false
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * 递归归一化单个 JSON 值
 * @description 只接受字符串、有限数字、布尔值、null、普通对象与数组；字符串、键长度与容器规模超出上限，
 * 或遇到函数、Symbol、BigInt、undefined、非有限数字、非普通对象与循环引用时返回失败标记
 * @param value 待归一化值
 * @param depth 当前容器深度，根对象为 1
 * @param seen 当前递归路径上的对象，用于识别循环引用
 * @param encoder UTF-8 编码器
 * @returns 归一化后的独立副本；无法安全归一化时返回 INVALID
 */
function normalizeValue(value: unknown, depth: number, seen: Set<object>, encoder: TextEncoder): unknown {
  if (typeof value === 'string') return encoder.encode(value).length <= MAX_CONTEXT_STRING_BYTES ? value : INVALID
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID
  if (typeof value === 'boolean' || value === null) return value
  if (typeof value !== 'object' || depth > MAX_CONTEXT_DEPTH || seen.has(value)) return INVALID
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_CONTEXT_ITEMS) return INVALID
      const result: unknown[] = []
      for (const item of value) {
        const normalized = normalizeValue(item, depth + 1, seen, encoder)
        if (normalized === INVALID) return INVALID
        result.push(normalized)
      }
      return result
    }
    if (!isPlainObject(value)) return INVALID
    const keys = Object.keys(value)
    if (keys.length > MAX_CONTEXT_KEYS) return INVALID
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      if (encoder.encode(key).length > MAX_CONTEXT_KEY_BYTES) return INVALID
      const normalized = normalizeValue(value[key], depth + 1, seen, encoder)
      if (normalized === INVALID) return INVALID
      // 使用定义属性避免 `__proto__` 等键改写结果对象的原型。
      Object.defineProperty(result, key, { value: normalized, enumerable: true, configurable: true, writable: true })
    }
    return result
  } finally {
    seen.delete(value)
  }
}

/**
 * 归一化上下文回调结果
 * @description 根值必须为普通对象；归一化副本与整体 JSON 体积均在上限内才采用，否则丢弃整段上下文
 * @param value 回调返回值
 * @param encoder UTF-8 编码器
 * @returns 可写入事件的上下文副本；不合法时返回 undefined
 */
function normalizeContext(value: unknown, encoder: TextEncoder): Context | undefined {
  try {
    if (!isPlainObject(value)) return undefined
    const normalized = normalizeValue(value, 1, new Set(), encoder)
    if (normalized === INVALID) return undefined
    const context = normalized as Context
    return encoder.encode(JSON.stringify(context)).length <= MAX_CONTEXT_BYTES ? context : undefined
  } catch {
    return undefined
  }
}

/**
 * 读取本次事件的自定义上下文
 * @description 回调每个待处理事件最多调用一次；最多等待 1 秒，回调抛错、拒绝、超时或结果不合法时忽略上下文，
 * 不阻断基础事件。超时不会取消应用任务，实际未结束的回调继续占用本代次并发额度
 * @param provider 读取当前初始化配置中最新回调的访问器
 * @param session 本代次的上下文并发额度
 * @param encoder UTF-8 编码器
 * @returns 归一化后的上下文；未配置、超限、超时或结果不合法时返回 undefined
 */
export async function readContext(provider: ContextProvider, session: ContextSession, encoder: TextEncoder): Promise<Context | undefined> {
  let callback: ContextCallback | undefined
  try {
    callback = provider()
  } catch {
    return undefined
  }
  if (typeof callback !== 'function' || session.pending >= MAX_PENDING_CONTEXTS) return undefined
  session.pending++
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (): void => {
    if (finished) return
    finished = true
    session.pending--
    if (timer !== undefined) clearTimeout(timer)
  }
  // 先建立超时再调用回调，回调同步执行的耗时才纳入同一秒预算；同步阻塞无法被中断，
  // 定时器在阻塞结束后才执行，此时已完成的合法结果仍然采用。
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), CONTEXT_TIMEOUT)
  })
  let result: unknown
  try {
    result = callback()
  } catch {
    finish()
    return undefined
  }
  const pending = Promise.resolve(result)
  // 超时后回调仍可能拒绝，提前挂接处理避免产生未处理 Promise。
  pending.then(finish, finish)
  try {
    const value = await Promise.race([pending, timeout])
    return value === TIMEOUT ? undefined : normalizeContext(value, encoder)
  } catch {
    return undefined
  }
}
