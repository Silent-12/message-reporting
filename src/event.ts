import { version as sdkVersion } from '../package.json'
import { decodeBase64Url, encodeBase64Url, type ByteArray } from './base64url'
import { createContextSession, readContext, type ContextProvider, type ContextSession } from './context'
import { readEnvironment, type Environment } from './environment'
import { isEnvelope, isRecord, request } from './request'

/** 允许的内部事件类型，与后端协议常量一致。 */
const EVENT_KINDS = ['javascript', 'unhandledrejection', 'img', 'script', 'resource', 'other'] as const
/** 允许的事件级别，与后端协议常量一致。 */
const EVENT_LEVELS = ['debug', 'info', 'warn', 'error'] as const

/**
 * 内部错误事件
 * @description 供浏览器监听器提交的原始事件，字段在准备阶段完成校验与有界裁剪。
 */
export interface InternalEvent {
  // 事件类型，取 EVENT_KINDS 之一
  kind: (typeof EVENT_KINDS)[number]
  // 可选的事件级别，未提供时信封不带该字段
  level?: (typeof EVENT_LEVELS)[number]
  // 原始消息或 Promise 拒绝值，发送前归一化为字符串
  message: unknown
  // 发生时间，Unix 毫秒
  occurredAt: number
  // 可选的事件名称，例如错误构造器名称
  name?: string
  // 可选的错误堆栈
  stack?: string
  // 可选的页面路径，发送前去除查询与片段
  pagePath?: string
  // 可选的来源位置；line 与 column 为非负整数行列号，URL 发送前去除查询与片段
  source?: { url?: string; line?: number; column?: number }
  // 可选的环境信息，发送前与当前 runtime 自动采集值合并，显式字段优先
  environment?: Environment
}

/** 单次内部事件发送结果：accepted 已接收，dropped 未发送或已丢弃，unknown 服务端判定重复，temporary_failure 重试耗尽。 */
type EventSendResult = 'accepted' | 'dropped' | 'unknown' | 'temporary_failure'

/**
 * 当前初始化代次的内部发送目标
 * @description 保存发送事件所需的服务地址、应用标识、CID 与拒绝回调，并提供本代次的停止信号。
 */
interface Target {
  // 保留路径前缀的服务根地址
  serverUrl: string
  // 服务端分配的应用标识
  appId: string
  // 服务端签发的规范 CID
  cid: string
  // 服务端判定 CID 无效或未授权时的回调
  onRejected: (code: string) => void
  // 读取当前初始化配置中最新上下文回调的访问器
  getContext: ContextProvider
  // 本代次的上下文回调并发额度
  contextSession: ContextSession
  // 本代次的停止控制器
  controller: AbortController
}
let target: Target | undefined
// 超时或 stop 不能释放尚未真正结束的底层请求，计数跨初始化代次保留。
let activeRequests = 0
// Web Crypto 无法主动取消，任务实际完成前始终占用准备额度，包括停止后的旧任务。
let activePreparations = 0
/** 同时未结束的事件准备任务与上报请求上限。 */
const MAX_EVENT_CONCURRENCY = 5
/** 明文事件 JSON 的 UTF-8 字节上限。 */
const MAX_PLAINTEXT_BYTES = 32 * 1024
/** 完整加密信封 JSON 的 UTF-8 字节上限。 */
const MAX_ENVELOPE_BYTES = 48 * 1024
/** 服务端接受时间窗口，单位毫秒；重试前按 sentAt 本地复核。 */
const SENT_AT_WINDOW = 5 * 60 * 1000
/** 事件消息的目标 03 裁剪上限，单位字节。 */
const MAX_MESSAGE_BYTES = 8192
/** 错误堆栈的目标 03 裁剪上限，单位字节。 */
const MAX_STACK_BYTES = 16384
/** 事件名称的目标 03 裁剪上限，单位字节。 */
const MAX_NAME_BYTES = 1024
/** 页面路径与来源地址的目标 03 裁剪上限，单位字节。 */
const MAX_URL_BYTES = 2048
/** 环境 userAgent 的目标 03 裁剪上限，单位字节。 */
const MAX_ENVIRONMENT_USER_AGENT_BYTES = 1024
/** 环境 effectiveType 的目标 03 裁剪上限，单位字节。 */
const MAX_ENVIRONMENT_EFFECTIVE_TYPE_BYTES = 64

/**
 * 激活当前初始化代次的内部发送器
 * @description 先停止上一代次，再记录本次发送目标
 * @param serverUrl 保留路径前缀的服务根地址
 * @param appId 服务端分配的应用标识
 * @param cid 服务端签发的规范 CID
 * @param onRejected 服务端判定 CID 无效或未授权时的回调
 * @param getContext 读取当前初始化配置中最新上下文回调的访问器
 */
export function activateEvents(serverUrl: string, appId: string, cid: string, onRejected: (code: string) => void, getContext: ContextProvider): void {
  stopEvents()
  target = { serverUrl, appId, cid, onRejected, getContext, contextSession: createContextSession(), controller: new AbortController() }
}

/** 停止当前发送器及其等待中的操作。 */
export function stopEvents(): void {
  target?.controller.abort()
  target = undefined
}

/**
 * 按 UTF-8 字节上限截断字符串
 * @description 按码点累加编码字节，超出上限前停止，不拆分代理对
 * @param value 待截断字符串
 * @param max 字节上限
 * @param encoder UTF-8 编码器
 * @returns 不超过上限的前缀
 */
function truncate(value: string, max: number, encoder: TextEncoder): string {
  let result = ''
  let bytes = 0
  for (const char of value) {
    bytes += encoder.encode(char).length
    if (bytes > max) break
    result += char
  }
  return result
}

/**
 * 按 JSON 编码字节上限截断字符串
 * @description 逐码点累加 JSON 转义后的 UTF-8 字节，保证拼接回明文后不超出剩余预算
 * @param value 待截断字符串
 * @param max 剩余预算，单位字节
 * @param encoder UTF-8 编码器
 * @returns 不超过预算的前缀
 */
function truncateJsonString(value: string, max: number, encoder: TextEncoder): string {
  let result = ''
  let bytes = 0
  for (const char of value) {
    bytes += encoder.encode(JSON.stringify(char)).length - 2
    if (bytes > max) break
    result += char
  }
  return result
}

/**
 * 去除 URL 的查询与片段后按字节上限截断
 * @description 超长地址先按字符上限截取，避免在错误处理路径上复制整个字符串；UTF-8 每个码元至少占一个字节，
 * 因此不会截掉仍在字节上限内的内容
 * @param value 页面路径或来源地址
 * @param encoder UTF-8 编码器，省略时按需创建
 * @returns 不含查询与片段的前缀
 */
export function cleanUrl(value: string, encoder: TextEncoder = new TextEncoder()): string {
  const bounded = value.length > MAX_URL_BYTES ? value.slice(0, MAX_URL_BYTES).replace(/[\uD800-\uDBFF]$/, '') : value
  return truncate(bounded.split(/[?#]/, 1)[0], MAX_URL_BYTES, encoder)
}

/**
 * 把事件消息或拒绝值归一化为可安全描述的字符串
 * @description 错误对象取名称与消息，其他对象统一为 `[object]`，不做递归序列化
 * @param value 原始消息或 Promise 拒绝值
 * @returns 可安全发送的字符串
 */
function describe(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) {
    try {
      return `${value.name}: ${value.message}`
    } catch {
      return '[error]'
    }
  }
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return typeof value === 'object' ? '[object]' : `[${typeof value}]`
}

/**
 * 合并自动采集与显式传入的环境信息
 * @description 当前 runtime 可读取的字段作为基础，显式传入且类型正确的字段优先；全部缺失时返回 undefined
 * @param explicit 内部调用方传入的环境信息
 * @returns 待裁剪的环境信息；无可用字段时返回 undefined
 */
function collectEnvironment(explicit: InternalEvent['environment']): Environment | undefined {
  const collected = readEnvironment()
  const environment: Environment = {}
  if (collected?.userAgent !== undefined) environment.userAgent = collected.userAgent
  if (collected?.online !== undefined) environment.online = collected.online
  if (collected?.effectiveType !== undefined) environment.effectiveType = collected.effectiveType
  if (typeof explicit?.userAgent === 'string') environment.userAgent = explicit.userAgent
  if (typeof explicit?.online === 'boolean') environment.online = explicit.online
  if (typeof explicit?.effectiveType === 'string') environment.effectiveType = explicit.effectiveType
  return Object.keys(environment).length ? environment : undefined
}

/**
 * 校验内部事件入参
 * @description 事件类型与级别须为协议允许值，发生时间须为安全整数
 * @param input 内部事件输入
 * @returns 是否可进入整理阶段
 */
function validInput(input: InternalEvent): boolean {
  if (!EVENT_KINDS.includes(input.kind) || !Number.isSafeInteger(input.occurredAt)) return false
  return input.level === undefined || EVENT_LEVELS.includes(input.level)
}

/**
 * 构建事件明文并按字段上限裁剪
 * @description 可选字段仅在实际为对应类型时写入，页面路径与来源地址去除查询和片段，超长值按各自字节上限保留前部
 * @param input 内部事件输入
 * @param appId 服务端分配的应用标识
 * @param eventId 本条事件标识
 * @param context 本次事件的自定义上下文
 * @param environment 本次事件的环境信息
 * @param encoder UTF-8 编码器
 * @returns 待加密的明文对象
 */
function buildPlaintext(
  input: InternalEvent,
  appId: string,
  eventId: string,
  context: Record<string, unknown> | undefined,
  environment: Environment | undefined,
  encoder: TextEncoder,
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    schemaVersion: 1,
    eventId,
    appId,
    sdkVersion,
    occurredAt: input.occurredAt,
    kind: input.kind,
    message: truncate(describe(input.message), MAX_MESSAGE_BYTES, encoder),
  }
  if (input.level !== undefined) event.level = input.level
  if (typeof input.name === 'string') event.name = truncate(input.name, MAX_NAME_BYTES, encoder)
  if (typeof input.stack === 'string') event.stack = truncate(input.stack, MAX_STACK_BYTES, encoder)
  if (typeof input.pagePath === 'string') event.pagePath = cleanUrl(input.pagePath, encoder)
  if (input.source) {
    const source: Record<string, unknown> = {}
    if (typeof input.source.url === 'string') source.url = cleanUrl(input.source.url, encoder)
    for (const field of ['line', 'column'] as const) {
      const value = input.source[field]
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) source[field] = value
    }
    if (Object.keys(source).length) event.source = source
  }
  if (environment) {
    const fields: Record<string, unknown> = {}
    if (typeof environment.userAgent === 'string') fields.userAgent = truncate(environment.userAgent, MAX_ENVIRONMENT_USER_AGENT_BYTES, encoder)
    if (typeof environment.online === 'boolean') fields.online = environment.online
    if (typeof environment.effectiveType === 'string') fields.effectiveType = truncate(environment.effectiveType, MAX_ENVIRONMENT_EFFECTIVE_TYPE_BYTES, encoder)
    if (Object.keys(fields).length) event.environment = fields
  }
  if (context !== undefined) event.context = context
  return event
}

/**
 * 按明文上限降级事件体积
 * @description 超出上限时先移除自定义上下文，再移除环境信息，最后按 JSON 编码字节缩短堆栈并保留其前部，仍超限则整条丢弃
 * @param event 明文对象，降级时就地修改
 * @param encoder UTF-8 编码器
 * @returns 不超过上限的明文编码；无法满足时返回 undefined
 */
function fitPlaintext(event: Record<string, unknown>, encoder: TextEncoder): ByteArray | undefined {
  let plain = encoder.encode(JSON.stringify(event))
  if (plain.length > MAX_PLAINTEXT_BYTES && event.context !== undefined) {
    delete event.context
    plain = encoder.encode(JSON.stringify(event))
  }
  if (plain.length > MAX_PLAINTEXT_BYTES && event.environment !== undefined) {
    delete event.environment
    plain = encoder.encode(JSON.stringify(event))
  }
  if (plain.length > MAX_PLAINTEXT_BYTES && typeof event.stack === 'string') {
    const stack = event.stack
    event.stack = ''
    plain = encoder.encode(JSON.stringify(event))
    if (plain.length <= MAX_PLAINTEXT_BYTES) {
      event.stack = truncateJsonString(stack, MAX_PLAINTEXT_BYTES - plain.length, encoder)
    } else {
      delete event.stack
    }
    plain = encoder.encode(JSON.stringify(event))
  }
  return plain.length > MAX_PLAINTEXT_BYTES ? undefined : plain
}

/**
 * 派生密钥、加密明文并组装信封
 * @description 每条事件按 HKDF-SHA-256 独立派生 AES-256-GCM 子密钥；每个加密步骤后检查停止信号，停止后不再继续
 * @param current 当前初始化代次的发送目标
 * @param eventId 本条事件标识
 * @param iv 本条事件的 12 字节随机 IV
 * @param plain 已定稿的明文编码
 * @param sentAt 信封发送时间，Unix 毫秒
 * @param signal 当前代次的停止信号
 * @param encoder UTF-8 编码器
 * @returns 不超过信封上限的加密信封 JSON；已停止或超出上限时返回 undefined
 */
async function sealEnvelope(
  current: Target,
  eventId: string,
  iv: ByteArray,
  plain: ByteArray,
  sentAt: number,
  signal: AbortSignal,
  encoder: TextEncoder,
): Promise<string | undefined> {
  const ikm = await crypto.subtle.importKey('raw', decodeBase64Url(current.cid), 'HKDF', false, ['deriveKey'])
  if (signal.aborted) return undefined
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('message-reporting/v1'), info: encoder.encode(`aes-256-gcm:${current.appId}:${eventId}`) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )
  if (signal.aborted) return undefined
  const aad = encoder.encode(JSON.stringify([1, current.appId, current.cid, eventId, sentAt]))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plain)
  if (signal.aborted) return undefined
  const body = JSON.stringify({
    version: 1,
    appId: current.appId,
    cid: current.cid,
    eventId,
    sentAt,
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(new Uint8Array(encrypted)),
  })
  return encoder.encode(body).length <= MAX_ENVELOPE_BYTES ? body : undefined
}

/**
 * 整理和加密内部事件
 * @description 在准备额度内调用一次上下文回调，完成字段校验、有界整理与加密；停止后不继续后续加密步骤
 * @param input 内部事件输入
 * @param current 当前初始化代次的发送目标
 * @returns 加密信封正文与发送时间；参数非法、超出体积上限或已停止时返回 undefined
 */
async function prepareEvent(input: InternalEvent, current: Target): Promise<{ body: string; sentAt: number } | undefined> {
  const signal = current.controller.signal
  const encoder = new TextEncoder()
  if (!validInput(input)) return undefined
  // 环境信息在等待上下文回调前采集，避免反映回调等待期间的状态变化。
  const environment = collectEnvironment(input.environment)
  const context = await readContext(current.getContext, current.contextSession, encoder)
  if (signal.aborted) return undefined
  const eventId = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = fitPlaintext(buildPlaintext(input, current.appId, eventId, context, environment, encoder), encoder)
  if (plain === undefined) return undefined
  const sentAt = Date.now()
  const body = await sealEnvelope(current, eventId, iv, plain, sentAt, signal, encoder)
  return body === undefined ? undefined : { body, sentAt }
}

/**
 * 判断内部发送器是否还有事件额度
 * @description 供采集模块在组装事件前检查，避免为必然丢弃的事件读取字段或拼接字符串
 * @returns 是否还可以提交一条事件
 */
export function canSendEvent(): boolean {
  const current = target
  return current !== undefined && !current.controller.signal.aborted && activePreparations < MAX_EVENT_CONCURRENCY && activeRequests < MAX_EVENT_CONCURRENCY
}

/**
 * 整理、加密和发送内部事件
 * @description 准备任务和实际请求各自有界，重试复用同一信封；结果仅供内部测试和后续采集模块使用，异常均被吸收
 * @param input 内部事件输入
 * @returns accepted 为 200 且 `data` 为 null；dropped 为未允许、超限、已停止、4xx 或响应非法；
 * temporary_failure 为重试耗尽；unknown 为 409 `REPLAYED`
 */
export async function sendInternalEvent(input: InternalEvent): Promise<EventSendResult> {
  const current = target
  if (!current || current.controller.signal.aborted || activePreparations >= MAX_EVENT_CONCURRENCY) return 'dropped'
  const signal = current.controller.signal
  let prepared: { body: string; sentAt: number } | undefined
  activePreparations++
  try {
    prepared = await prepareEvent(input, current)
  } catch {
    // 整理或加密失败按丢弃处理，异常不得穿透到宿主应用。
    return 'dropped'
  } finally {
    activePreparations--
  }
  if (!prepared || signal.aborted) return 'dropped'
  let blocked = false
  try {
    const reply = await request(`${current.serverUrl}/v1/events`, prepared.body, signal, {
      beforeAttempt: () => {
        if (Math.abs(Date.now() - prepared.sentAt) > SENT_AT_WINDOW || activeRequests >= MAX_EVENT_CONCURRENCY) {
          blocked = true
          return false
        }
        activeRequests++
        return true
      },
      onSettled: () => {
        activeRequests--
      },
    })
    if (signal.aborted || blocked) return 'dropped'
    if (!reply) return 'temporary_failure'
    if (!isEnvelope(reply)) return 'dropped'
    if (reply.status === 200) return reply.body.data === null ? 'accepted' : 'dropped'
    if (isRecord(reply.body.data)) {
      const code = reply.body.data.errorCode
      if ((reply.status === 401 && code === 'CID_INVALID') || (reply.status === 403 && code === 'NOT_ALLOWED')) current.onRejected(code)
      if (reply.status === 409 && code === 'REPLAYED') return 'unknown'
    }
  } catch {
    // 事件及内部异步任务的异常不能影响宿主应用。
  }
  return 'dropped'
}
