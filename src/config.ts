import type { InitOptions, ResolvedInitOptions } from './types/index'

const DEFAULT_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
}

// Beacon 发送方式的最大 payload 体积上限（60KB）
const DEFAULT_BEACON_MAX_PAYLOAD_BYTES = 60 * 1024

// GIF 发送方式的最大 payload 体积上限（1.5KB，受 URL 长度限制）
const DEFAULT_GIF_MAX_PAYLOAD_BYTES = 1500

let currentConfig: ResolvedInitOptions | null = null

/**
 * @description 校验并标准化 SDK 初始化配置。
 * @param {InitOptions} options - 调用方传入的初始化配置。
 * @return {ResolvedInitOptions} 返回可直接用于发送流程的标准化配置。
 * @throws {Error} 当 endpoint 缺失或参数类型错误时抛出异常。
 */
export function normalizeInitOptions(options: InitOptions): ResolvedInitOptions {
  if (!options || typeof options !== 'object') {
    throw new Error('message-reporting init 配置必须为对象。')
  }

  if (typeof options.endpoint !== 'string' || options.endpoint.trim() === '') {
    throw new Error('message-reporting init 需要提供非空的 endpoint。')
  }

  if (options.headers !== undefined && (typeof options.headers !== 'object' || options.headers === null || Array.isArray(options.headers))) {
    throw new Error('message-reporting headers 必须为键值对象。')
  }

  if (options.beaconMaxPayloadBytes !== undefined && options.beaconMaxPayloadBytes <= 0) {
    throw new Error('message-reporting beaconMaxPayloadBytes 必须大于 0。')
  }

  if (options.gifMaxPayloadBytes !== undefined && options.gifMaxPayloadBytes <= 0) {
    throw new Error('message-reporting gifMaxPayloadBytes 必须大于 0。')
  }

  if (options.includeRuntimeInfo !== undefined && typeof options.includeRuntimeInfo !== 'boolean') {
    throw new Error('message-reporting includeRuntimeInfo 必须为布尔值。')
  }

  const resolvedGifMaxPayloadBytes = options.gifMaxPayloadBytes ?? DEFAULT_GIF_MAX_PAYLOAD_BYTES

  return {
    // 标准化后的主上报地址。
    endpoint: options.endpoint.trim(),
    // 标准化后的 gif 兜底上报地址，未单独配置时复用 endpoint。
    gifEndpoint: options.gifEndpoint?.trim() || options.endpoint.trim(),
    // 合并默认与业务自定义的请求头配置。
    headers: {
      ...DEFAULT_HEADERS,
      ...(options.headers ?? {}),
    },
    // fetch 请求的凭据模式，默认 same-origin。
    fetchCredentials: options.fetchCredentials ?? 'same-origin',
    // beacon 发送允许的最大 payload 字节数。
    beaconMaxPayloadBytes: options.beaconMaxPayloadBytes ?? DEFAULT_BEACON_MAX_PAYLOAD_BYTES,
    // gif 发送允许的最大 payload 字节数。
    gifMaxPayloadBytes: resolvedGifMaxPayloadBytes,
    // 小包场景下是否优先尝试 gif 通道。
    preferGifForSmallPayload: options.preferGifForSmallPayload ?? true,
    // 是否自动携带运行时环境信息，开启后因数据包体积限制，gif上报可能会失效, 默认关闭。
    includeRuntimeInfo: options.includeRuntimeInfo ?? false,
  }
}

/**
 * @description 保存标准化后的 SDK 配置。
 * @param {ResolvedInitOptions} options - 已通过校验的初始化配置。
 * @return {ResolvedInitOptions} 返回保存后的配置快照。
 */
export function setConfig(options: ResolvedInitOptions): ResolvedInitOptions {
  currentConfig = {
    ...options,
    headers: { ...options.headers },
  }

  return {
    ...currentConfig,
    headers: { ...currentConfig.headers },
  }
}

/**
 * @description 读取当前 SDK 配置，并在 strict 为 true 时返回非空配置。
 * @param {true} strict - 传入 true 时若配置不存在立即抛错。
 * @return {ResolvedInitOptions} 返回当前配置快照。
 */
export function getConfig(strict: true): ResolvedInitOptions

/**
 * @description 读取当前 SDK 配置，并允许在未初始化时返回空值。
 * @param {false} strict - 传入 false 时未初始化不会抛错。
 * @return {ResolvedInitOptions | null} 返回当前配置快照，未初始化时返回 null。
 */
export function getConfig(strict: false): ResolvedInitOptions | null

/**
 * @description 读取当前 SDK 配置，并可按需在未初始化时抛错。
 * @param {boolean} strict - 为 true 时若配置不存在立即抛错。
 * @return {ResolvedInitOptions | null} 返回当前配置快照，未初始化且 strict 为 false 时返回 null。
 */
export function getConfig(strict: boolean): ResolvedInitOptions | null {
  if (!currentConfig && strict) {
    throw new Error('message-reporting 尚未初始化，请先调用 init。')
  }

  if (!currentConfig) {
    return null
  }

  return {
    ...currentConfig,
    headers: { ...currentConfig.headers },
  }
}
