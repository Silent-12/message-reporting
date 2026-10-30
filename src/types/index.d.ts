import type { EVENT_LEVELS } from '../event'

/**
 * 可监听的事件与控制台级别
 * @description 对应当前窗口的 console.debug、info、warn 与 error 方法；由发送器的级别常量派生，
 * 避免协议级别在多处独立维护
 */
export type ConsoleLevel = (typeof EVENT_LEVELS)[number]

/**
 * 初始化选项
 * @description 配置接收服务、应用标识、控制台监听及后续事件上下文。
 */
export interface InitOptions {
  // 保留 API 路径前缀的服务根地址
  serverUrl: string
  // 服务端分配的应用标识
  appId: string
  // 可选的浏览器错误上下文回调；控制台事件跳过；重复初始化时以最新传入为准
  getContext?: () => Record<string, unknown> | Promise<Record<string, unknown>>
  // 可选的控制台监听：默认或 false 为关闭，true 监听全部四级，数组只监听指定级别
  captureConsole?: boolean | readonly ConsoleLevel[]
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
