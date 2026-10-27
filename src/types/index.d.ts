/**
 * @description 定义 SDK 支持的发送通道类型。
 */
export type TransportMode = 'beacon' | 'fetch' | 'gif'

/**
 * @description 定义当前页面所处的生命周期阶段。
 */
export type PageStage = 'normal' | 'hidden' | 'unload'

/**
 * @description 定义业务侧传入的手动上报 JSON 对象结构。
 */
export type ReportPayload = Record<string, unknown>

/**
 * @description 定义 SDK 初始化时可传入的配置项。
 */
export interface InitOptions {
  // 必填的主上报地址
  endpoint: string
  // 可选的 gif 兜底上报地址
  gifEndpoint?: string
  // 可选的 fetch 请求头配置
  headers?: Record<string, string>
  // 可选的 fetch 凭据模式
  fetchCredentials?: RequestCredentials
  // 可选的 beacon 体积上限
  beaconMaxPayloadBytes?: number
  // 可选的 gif 体积上限
  gifMaxPayloadBytes?: number
  // 可选的小包优先 gif 开关
  preferGifForSmallPayload?: boolean
  // 可选的运行时环境信息上报开关（默认开启）, 默认关闭。开启后因数据包体积限制，gif上报可能会失效。
  includeRuntimeInfo?: boolean
}

/**
 * @description 定义单次上报时允许覆盖的可选参数。
 */
export interface ReportOptions {
  // 可选的页面阶段覆盖值
  stage?: PageStage
  // 可选的强制发送通道
  transport?: TransportMode
}

/**
 * @description 定义经过标准化处理后内部实际使用的初始化配置。
 */
export interface ResolvedInitOptions {
  // 标准化后的主上报地址
  endpoint: string
  // 标准化后的 gif 兜底地址
  gifEndpoint: string
  // 标准化后的请求头配置
  headers: Record<string, string>
  // 标准化后的 fetch 凭据模式
  fetchCredentials: RequestCredentials
  // 标准化后的 beacon 体积上限
  beaconMaxPayloadBytes: number
  // 标准化后的 gif 体积上限
  gifMaxPayloadBytes: number
  // 标准化后的小包优先 gif 开关
  preferGifForSmallPayload: boolean
  // 标准化后的运行时环境信息上报开关, 默认关闭。开启后因数据包体积限制，gif上报可能会失效。
  includeRuntimeInfo: boolean
}

/**
 * @description 定义一次发送流程中策略判断所需的上下文信息。
 */
export interface ReportContext {
  // 已序列化的上报 JSON 字符串
  payloadString: string
  // 当前上报内容的字节体积
  payloadSize: number
  // 可选的 gif 精简上报 JSON 字符串
  gifPayloadString?: string
  // 可选的 gif 精简上报字节体积
  gifPayloadSize?: number
  // 当前页面阶段
  stage: PageStage
  // 当前是否为即时上报
  immediate: boolean
}

/**
 * @description 定义一次上报执行完成后返回的结果结构。
 */
export interface ReportResult {
  // 当前发送是否成功
  ok: boolean
  // 实际结束时对应的发送通道
  transport: TransportMode
  // 本次上报内容的字节体积
  payloadSize: number
  // 本次尝试过的发送通道列表
  attemptedTransports: TransportMode[]
}

/**
 * @description 定义 SDK 运行时依赖的浏览器能力集合。
 */
export interface RuntimeLike {
  // 可选的 document 引用
  document?: Document
  // 可选的 navigator 引用
  navigator?: Navigator
  // 可选的 localStorage 引用
  localStorage?: Storage
  // 可选的 fetch 实现
  fetch?: typeof fetch
  // 可选的 Image 构造函数
  Image?: typeof Image
  // 可选的 Blob 构造函数
  Blob?: typeof Blob
}

/**
 * @description 定义 Network Information API 的网络状态信息结构。
 */
export interface NetworkInfoLike {
  // 可选的网络有效类型（如 4g、3g）。
  effectiveType?: string
  // 可选的预估下行带宽（Mbps）。
  downlink?: number
  // 可选的预估往返时延（ms）。
  rtt?: number
  // 可选的省流量模式开关状态。
  saveData?: boolean
}
