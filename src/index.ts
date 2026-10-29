import type { InitOptions, InitResult } from './types/index'
import { decodeBase64Url, encodeBase64Url } from './base64url'
import { activateEvents, stopEvents } from './event'
import { isEnvelope, isRecord, request, type HttpReply } from './request'

/**
 * 规范化后的初始化目标
 * @description 只保留发起请求与后续事件上下文所需字段，`serverUrl` 已去除末尾斜杠。
 */
interface Config {
  serverUrl: string
  appId: string
  getContext: InitOptions['getContext']
}

/** 应用标识格式：2 至 64 位小写字母与数字且两者混合，与后端协议常量一致。 */
const APP_ID_PATTERN = /^(?=.*[a-z])(?=.*[0-9])[a-z0-9]{2,64}$/
/** 规范 CID 格式：32 字节无填充 base64url，与后端协议常量一致。 */
const CID_PATTERN = /^[A-Za-z0-9_-]{43}$/
// 已确认的初始化目标（规范化后的 serverUrl 与 appId）。
let current: Config | undefined
// 进行中的初始化过程；同一监控目标的并发调用直接复用。
let operation: Promise<InitResult> | undefined
// 当前初始化过程的取消控制器。
let controller: AbortController | undefined
// 初始化代次；新初始化与 stop 递增，用于丢弃迟到响应。
let generation = 0
// 上报策略是否已明确允许上报；仅该值为 true 时可上报事件。
let allowed = false

/**
 * 校验并规范化初始化选项
 * @description 只接受 HTTPS（loopback 允许 HTTP）且不含凭据、查询与片段的绝对地址，规范化协议、主机与默认端口后去除末尾斜杠，
 * 保留路径前缀及其大小写；应用标识须符合协议格式
 * @param options 接入方传入的初始化选项
 * @returns 规范化后的初始化目标；不合法时返回 undefined
 */
function normalize(options: InitOptions): Config | undefined {
  if (!options || typeof options.serverUrl !== 'string' || typeof options.appId !== 'string' || !APP_ID_PATTERN.test(options.appId)) return undefined
  if (options.getContext !== undefined && typeof options.getContext !== 'function') return undefined
  if (options.serverUrl.includes('?') || options.serverUrl.includes('#')) return undefined
  try {
    const url = new URL(options.serverUrl)
    if (url.username || url.password || url.search || url.hash) return undefined
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return undefined
    return { serverUrl: url.href.replace(/\/+$/, ''), appId: options.appId, getContext: options.getContext }
  } catch {
    return undefined
  }
}

/**
 * 判断两个初始化目标是否指向同一服务端与应用
 * @param a 规范化后的初始化目标
 * @param b 规范化后的初始化目标
 * @returns 服务地址与应用标识是否都相同
 */
function sameTarget(a: Config, b: Config): boolean {
  return a.serverUrl === b.serverUrl && a.appId === b.appId
}

/**
 * 校验服务端签发的 CID
 * @description 严格检查无填充 base64url 格式，并用重编码结果排除非规范编码
 * @param value 待校验值
 * @returns 是否为规范 CID
 */
function validCid(value: unknown): value is string {
  if (typeof value !== 'string' || !CID_PATTERN.test(value)) return false
  try {
    const bytes = decodeBase64Url(value)
    return bytes.length === 32 && encodeBase64Url(bytes) === value
  } catch {
    return false
  }
}

/**
 * 把响应转换为初始化失败结果
 * @description 仅当响应符合统一结构且 `data.errorCode` 为字符串时透传协议错误码
 * @param reply HTTP 响应快照
 * @returns 失败状态与可选的协议错误码
 */
function toFailureResult(reply: HttpReply): InitResult {
  if (isEnvelope(reply) && isRecord(reply.body.data) && typeof reply.body.data.errorCode === 'string') {
    return { status: 'failed', errorCode: reply.body.data.errorCode }
  }
  return { status: 'failed' }
}

/**
 * 检查运行环境并完成 CID 签发与上报策略查询
 * @description 先确认协议所需能力与可读写持久存储，再按服务地址与应用隔离读取或签发 CID，
 * 写入后可重新读取才继续查询上报策略；停止信号或代次变化时返回 stopped，且不写入任何状态
 * @param config 规范化后的初始化目标
 * @param signal 本次初始化的停止信号
 * @param id 本次初始化的代次
 * @returns 初始化结果
 */
async function initialize(config: Config, signal: AbortSignal, id: number): Promise<InitResult> {
  let storage: Storage
  try {
    // 目标 01 要求缺失安全随机源、Web Crypto、UTF-8 编解码或 Fetch 时返回明确不可用状态。
    if (
      typeof fetch !== 'function' ||
      typeof atob !== 'function' ||
      typeof btoa !== 'function' ||
      typeof TextEncoder !== 'function' ||
      typeof TextDecoder !== 'function' ||
      !globalThis.crypto?.subtle ||
      !globalThis.crypto?.getRandomValues
    )
      return { status: 'unavailable' }
    storage = globalThis.localStorage
    if (!storage) return { status: 'unavailable' }
    const probe = `__message_reporting_probe__:${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).join('-')}`
    try {
      storage.setItem(probe, '1')
      if (storage.getItem(probe) !== '1') return { status: 'unavailable' }
    } finally {
      storage.removeItem(probe)
    }
  } catch {
    return { status: 'unavailable' }
  }
  const key = `__message_reporting_cid__:${encodeURIComponent(config.serverUrl)}:${config.appId}`
  try {
    let cid = storage.getItem(key)
    if (!validCid(cid)) {
      const issued = await request(`${config.serverUrl}/v1/cids`, JSON.stringify({ appId: config.appId }), signal)
      if (signal.aborted || id !== generation) return { status: 'stopped' }
      if (!issued) return { status: 'failed', errorCode: 'TEMPORARY_FAILURE' }
      if (issued.status !== 200 || !isEnvelope(issued) || !isRecord(issued.body.data) || !validCid(issued.body.data.cid)) return toFailureResult(issued)
      cid = issued.body.data.cid
      storage.setItem(key, cid)
      if (storage.getItem(key) !== cid) return { status: 'unavailable' }
    }
    // 只清除仍与本次 CID 一致的存储值。
    const forgetCid = (): void => {
      if (storage.getItem(key) === cid) storage.removeItem(key)
    }
    const result = await request(`${config.serverUrl}/v1/admission`, JSON.stringify({ appId: config.appId, cid }), signal)
    if (signal.aborted || id !== generation) return { status: 'stopped' }
    if (!result) return { status: 'failed', errorCode: 'TEMPORARY_FAILURE' }
    if (isEnvelope(result) && result.status === 401 && isRecord(result.body.data) && result.body.data.errorCode === 'CID_INVALID') {
      forgetCid()
      return { status: 'failed', errorCode: 'CID_INVALID' }
    }
    if (result.status !== 200 || !isEnvelope(result) || !isRecord(result.body.data) || typeof result.body.data.allowed !== 'boolean') {
      return toFailureResult(result)
    }
    if (result.body.data.allowed) {
      activateEvents(config.serverUrl, config.appId, cid, (code) => {
        if (id !== generation) return
        if (code === 'CID_INVALID') {
          try {
            forgetCid()
          } catch {
            // 存储不可用时仍停止发送。
          }
        }
        stop()
      })
    }
    return { status: result.body.data.allowed ? 'allowed' : 'denied' }
  } catch {
    return { status: 'unavailable' }
  }
}

/**
 * 初始化 SDK
 * @description 校验配置后签发或复用 CID 并查询上报策略；同一监控目标的并发调用共用一次初始化，
 * 已允许后的重复调用复用允许状态并更新上下文回调，不同监控目标返回冲突
 * @param options 上报服务地址、应用标识与可选的上下文回调
 * @returns 根据上报策略判定的允许状态或失败原因
 */
export function init(options: InitOptions): Promise<InitResult> {
  const config = normalize(options)
  if (!config) return Promise.resolve({ status: 'invalid_config' })
  if (operation) {
    if (!current || !sameTarget(current, config)) return Promise.resolve({ status: 'conflict' })
    // 初始化进行中的同目标重复调用：共用同一过程，并以最新传入的上下文回调为准。
    current = config
    return operation
  }
  if (allowed) {
    if (!current || !sameTarget(current, config)) return Promise.resolve({ status: 'conflict' })
    // 同一监控目标重复初始化：复用允许状态，仅更新上下文回调。
    current = config
    return Promise.resolve({ status: 'allowed' })
  }
  // 需要构造取消控制器，缺少时按不可用处理。
  if (typeof AbortController !== 'function') return Promise.resolve({ status: 'unavailable' })
  current = config
  controller = new AbortController()
  const id = ++generation
  operation = initialize(config, controller.signal, id).then((result) => {
    if (id === generation) {
      allowed = result.status === 'allowed'
      operation = undefined
      controller = undefined
    }
    return result
  })
  return operation
}

/**
 * 停止初始化
 * @description 递增代次并中止进行中的请求，丢弃迟到的响应结果，同时清除上报允许状态
 */
export function stop(): void {
  generation++
  stopEvents()
  controller?.abort()
  controller = undefined
  operation = undefined
  current = undefined
  allowed = false
}

export type { InitOptions, InitResult } from './types/index'
export default { init, stop }
