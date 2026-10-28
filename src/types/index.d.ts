/**
 * 初始化选项
 * @description 配置接收服务、应用标识及后续事件上下文。
 */
export interface InitOptions {
  // 保留 API 路径前缀的服务根地址
  serverUrl: string
  // 服务端分配的应用标识
  appId: string
  // 可选的事件上下文回调，在后续目标中使用；重复初始化时以最新传入为准
  getContext?: () => Record<string, unknown> | Promise<Record<string, unknown>>
}

/**
 * 初始化结果
 * @description 表示根据上报策略判定的允许状态或初始化失败原因，不包含 CID。
 */
export interface InitResult {
  // allowed、denied、invalid_config、unavailable、failed、conflict 或 stopped
  status: 'allowed' | 'denied' | 'invalid_config' | 'unavailable' | 'failed' | 'conflict' | 'stopped'
  // 可选的协议错误码或临时故障标识
  errorCode?: string
}
