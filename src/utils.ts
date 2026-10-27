import type { PageStage, ReportContext, ReportOptions, ReportPayload, RuntimeLike, NetworkInfoLike } from './types/index'

/**
 * @description 判断输入值是否为普通 JSON 对象。
 * @param {unknown} value - 待校验的上报数据。
 * @return {value is ReportPayload} 当输入值为普通对象时返回 true。
 */
export function isPlainObject(value: unknown): value is ReportPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  return Object.prototype.toString.call(value) === '[object Object]'
}

/**
 * @description 将上报数据序列化为 JSON 字符串，并在失败时抛出明确错误。
 * @param {ReportPayload} payload - 调用方传入的上报对象。
 * @return {string} 返回用于发送的数据字符串。
 */
export function serializePayload(payload: ReportPayload): string {
  try {
    return JSON.stringify(payload)
  } catch (error) {
    throw new Error(`message-reporting 上报数据无法序列化: ${String(error)}`)
  }
}

/**
 * @description 估算字符串的 UTF-8 字节长度，用于发送策略选择。
 * @param {string} content - 待发送的 JSON 字符串。
 * @return {number} 返回估算出的字节大小。
 */
export function estimateByteLength(content: string): number {
  return new TextEncoder().encode(content).length
}

/**
 * @description 根据显式选项与页面可见性状态解析当前页面阶段。
 * @param {PageStage | undefined} stage - 调用方显式指定的页面阶段。
 * @param {Document | undefined} documentRef - 当前运行时 document 引用。
 * @return {PageStage} 返回用于策略判断的页面阶段。
 */
export function resolvePageStage(stage: PageStage | undefined, documentRef: Document | undefined): PageStage {
  if (stage) {
    return stage
  }

  if (documentRef?.visibilityState === 'hidden') {
    return 'hidden'
  }

  return 'normal'
}

/**
 * @description 基于 gif 兜底协议构建图片请求地址。
 * @param {string} endpoint - gif 上报目标地址。
 * @param {string} payloadString - 已序列化的 JSON 数据。
 * @return {string} 返回带查询参数的完整请求地址。
 */
export function buildGifRequestUrl(endpoint: string, payloadString: string): string {
  const hashIndex = endpoint.indexOf('#')
  const fragment = hashIndex === -1 ? '' : endpoint.slice(hashIndex)
  const requestEndpoint = hashIndex === -1 ? endpoint : endpoint.slice(0, hashIndex)
  const queryIndex = requestEndpoint.indexOf('?')
  const pathname = queryIndex === -1 ? requestEndpoint : requestEndpoint.slice(0, queryIndex)
  const query = new URLSearchParams(queryIndex === -1 ? '' : requestEndpoint.slice(queryIndex + 1))
  query.set('data', payloadString)

  query.set('_ts', String(Date.now()))

  return `${pathname}?${query.toString()}${fragment}`
}

/**
 * @description 获取并缓存 traceId，优先复用 localStorage 中已有值。
 * @param {RuntimeLike} runtime - 当前浏览器运行时引用。
 * @param {string} storageKey - traceId 在 localStorage 中的存储 key。
 * @return {string} 返回用于请求追踪的稳定 traceId。
 */
export function getOrCreateTraceId(runtime: RuntimeLike, storageKey: string): string {
  // 非浏览器或无存储能力时，退化为仅本次会话可用的 traceId。
  const localStorageRef = runtime.localStorage
  if (!localStorageRef) return createTraceId()

  try {
    // 页面重复初始化时优先复用已持久化的 traceId，保证同一用户链路稳定。
    const storedTraceId = localStorageRef.getItem(storageKey)
    if (storedTraceId) return storedTraceId

    // 首次初始化生成并持久化，后续页面加载可直接读取。
    const newTraceId = createTraceId()
    localStorageRef.setItem(storageKey, newTraceId)
    return newTraceId
  } catch {
    // localStorage 可能因权限限制抛错，失败时回退到内存 traceId。
    return createTraceId()
  }
}

/**
 * @description 生成 traceId，优先使用 randomUUID，不支持时回退到时间戳+随机串。
 * @return {string} 返回新生成的 traceId。
 */
export function createTraceId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  const randomPart = Math.random().toString(36).slice(2, 10)
  return `${Date.now()}-${randomPart}`
}

/**
 * @description 收集宿主环境信息，帮助后端按设备与网络维度快速定位问题。
 * @param {RuntimeLike} currentRuntime - 当前浏览器运行时引用。
 * @return {ReportPayload} 返回可直接合并进上报 payload 的环境信息对象。
 */
export function collectRuntimeInfo(currentRuntime: RuntimeLike): ReportPayload {
  const navigatorRef = currentRuntime.navigator
  const userAgent = navigatorRef?.userAgent ?? ''
  const uaLower = userAgent.toLowerCase()
  const network = (navigatorRef as (Navigator & { connection?: NetworkInfoLike }) | undefined)?.connection
  const hostApp = resolveHostApp(uaLower)

  return {
    // 浏览器完整 UA 字符串，用于精细化终端识别。
    ua: userAgent,
    // 当前浏览器首选语言（如 zh-CN）。
    language: navigatorRef?.language,
    // 当前浏览器声明支持的语言列表。
    languages: navigatorRef?.languages,
    // 浏览器上报的平台信息（如 Win32、iPhone）。
    platform: navigatorRef?.platform,
    // 当前网络连通状态，true 表示在线。
    onLine: navigatorRef?.onLine,
    // 由 UA 解析出的主浏览器名称。
    browser: resolveBrowserName(uaLower),
    // 当前宿主容器：wechat / alipay / browser。
    hostApp,
    // 是否在微信 H5 容器内运行。
    isWechat: hostApp === 'wechat',
    // 是否在支付宝 H5 容器内运行。
    isAlipay: hostApp === 'alipay',
    // 由 UA 解析出的操作系统名称。
    os: resolveOsName(uaLower),
    // 网络环境信息（部分浏览器可能不支持）。
    network: {
      // 网络有效类型（如 4g、3g）。
      effectiveType: network?.effectiveType,
      // 预估下行带宽（Mbps）。
      downlink: network?.downlink,
      // 预估往返时延（ms）。
      rtt: network?.rtt,
      // 是否启用节省流量模式。
      saveData: network?.saveData,
    },
  }
}

/**
 * @description 收集 gif 场景下的精简运行时信息，控制 URL 体积以提升 gif 可用性。
 * @param {RuntimeLike} currentRuntime - 当前浏览器运行时引用。
 * @return {ReportPayload} 返回 gif 上报使用的精简环境信息对象。
 */
export function collectGifRuntimeInfo(currentRuntime: RuntimeLike): ReportPayload {
  const navigatorRef = currentRuntime.navigator
  const userAgent = navigatorRef?.userAgent ?? ''
  const uaLower = userAgent.toLowerCase()
  const network = (navigatorRef as (Navigator & { connection?: NetworkInfoLike }) | undefined)?.connection
  const hostApp = resolveHostApp(uaLower)

  return {
    browser: resolveBrowserName(uaLower),
    hostApp,
    os: resolveOsName(uaLower),
    onLine: navigatorRef?.onLine,
    network: {
      effectiveType: network?.effectiveType,
    },
  }
}

/**
 * @description 将序列化结果补充为完整的发送上下文。
 * @param {string} payloadString - 已序列化的 JSON 字符串。
 * @param {ReportOptions | undefined} options - 可选的页面阶段与发送策略覆盖项。
 * @param {boolean} immediate - 是否按即时上报模式处理。
 * @param {RuntimeLike} currentRuntime - 当前浏览器运行时引用。
 * @param {string | undefined} gifPayloadString - gif 通道可选的精简 payload。
 * @return {ReportContext} 返回策略选择所需的完整上下文。
 */
export function createReportContext(
  payloadString: string,
  options: ReportOptions | undefined,
  immediate: boolean,
  currentRuntime: RuntimeLike,
  gifPayloadString?: string,
): ReportContext {
  return {
    payloadString,
    payloadSize: estimateByteLength(payloadString),
    gifPayloadString,
    gifPayloadSize: gifPayloadString ? estimateByteLength(gifPayloadString) : undefined,
    stage: resolvePageStage(options?.stage, currentRuntime.document),
    immediate,
  }
}

function resolveBrowserName(uaLower: string): string {
  if (!uaLower) return 'unknown'
  if (uaLower.includes('edg/')) return 'edge'
  if (uaLower.includes('opr/') || uaLower.includes('opera')) return 'opera'
  if (uaLower.includes('firefox/')) return 'firefox'
  if (uaLower.includes('chrome/') && !uaLower.includes('edg/')) return 'chrome'
  if (uaLower.includes('safari/') && !uaLower.includes('chrome/')) return 'safari'
  return 'unknown'
}

function resolveHostApp(uaLower: string): string {
  if (!uaLower) return 'browser'
  if (uaLower.includes('micromessenger')) return 'wechat'
  if (uaLower.includes('alipayclient')) return 'alipay'
  return 'browser'
}

function resolveOsName(uaLower: string): string {
  if (!uaLower) return 'unknown'
  if (uaLower.includes('iphone') || uaLower.includes('ipad') || uaLower.includes('ipod')) return 'ios'
  if (uaLower.includes('android')) return 'android'
  if (uaLower.includes('windows')) return 'windows'
  if (uaLower.includes('mac os')) return 'macos'
  if (uaLower.includes('linux')) return 'linux'
  return 'unknown'
}
