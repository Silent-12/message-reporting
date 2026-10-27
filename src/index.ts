import { getConfig, normalizeInitOptions, setConfig } from './config'
import { executeTransport } from './transports'
import type { InitOptions, ReportOptions, ReportPayload, ReportResult, RuntimeLike } from './types/index'
import { collectGifRuntimeInfo, collectRuntimeInfo, createReportContext, getOrCreateTraceId, isPlainObject, serializePayload } from './utils'

// 当前宿主运行时（浏览器环境下通常为 window）。
const runtime: RuntimeLike = globalThis
const SDK_NAME = '@hulihan97/message-reporting'
// traceId 的本地持久化 key，用于跨页面复用同一追踪标识。
const TRACE_ID_STORAGE_KEY = '__message_reporting_trace_id__'
// 自动注入到每次上报 payload 的 traceId 字段名。
const TRACE_ID_PAYLOAD_KEY = 'traceId'
// 自动注入到每次上报 payload 的运行时环境字段名。
const RUNTIME_INFO_PAYLOAD_KEY = 'runtimeInfo'
// 当前页面会话缓存的 traceId（初始化后写入）。
let currentTraceId = ''

console.log(`[${SDK_NAME} 已引入]`)

/**
 * @description 初始化 SDK，保存后续上报所需的基础配置并输出成功日志。
 * @param {InitOptions} options - 上报地址与发送选项配置。
 * @return {ReturnType<typeof setConfig>} 返回保存后的配置快照。
 */
export function init(options: InitOptions): ReturnType<typeof setConfig> {
  const normalizedOptions = normalizeInitOptions(options)
  const config = setConfig(normalizedOptions)
  currentTraceId = getOrCreateTraceId(runtime, TRACE_ID_STORAGE_KEY)

  console.log(`[${SDK_NAME} 初始化成功 🚀 traceId=${currentTraceId}]`)

  return config
}

/**
 * @description 执行常规手动上报，并按页面状态自动选择发送通道。
 * @param {ReportPayload} payload - 业务侧传入的 JSON 对象。
 * @param {ReportOptions | undefined} options - 可选的页面阶段与发送策略覆盖项。
 * @return {Promise<ReportResult>} 返回当前上报任务的执行结果。
 */
export function report(payload: ReportPayload, options?: ReportOptions): Promise<ReportResult> {
  return sendReport(payload, options, false)
}

/**
 * @description 执行即时上报，在页面隐藏或退出场景优先尝试 beacon。
 * @param {ReportPayload} payload - 业务侧传入的 JSON 对象。
 * @param {ReportOptions | undefined} options - 可选的页面阶段与发送策略覆盖项。
 * @return {Promise<ReportResult>} 返回当前上报任务的执行结果。
 */
export function reportImmediate(payload: ReportPayload, options?: ReportOptions): Promise<ReportResult> {
  return sendReport(payload, options, true)
}

/**
 * @description 对外暴露默认 SDK 对象，兼容模块化接入与 IIFE 全局挂载。
 * @param {{ init: typeof init; report: typeof report; reportImmediate: typeof reportImmediate }} sdk - SDK 能力集合。
 * @return {{ init: typeof init; report: typeof report; reportImmediate: typeof reportImmediate }} 返回原始 SDK 对象。
 */
export function createSdkExport(sdk: { init: typeof init; report: typeof report; reportImmediate: typeof reportImmediate }): {
  init: typeof init
  report: typeof report
  reportImmediate: typeof reportImmediate
} {
  return sdk
}

/**
 * @description 在前置校验通过后统一组装上下文并执行发送。
 * @param {ReportPayload} payload - 业务侧传入的 JSON 对象。
 * @param {ReportOptions | undefined} options - 可选的页面阶段与发送策略覆盖项。
 * @param {boolean} immediate - 是否按即时上报模式处理。
 * @return {Promise<ReportResult>} 返回当前上报任务的执行结果。
 */
async function sendReport(payload: ReportPayload, options: ReportOptions | undefined, immediate: boolean): Promise<ReportResult> {
  // 上报入参仅接受普通 JSON 对象，避免数组/原始值进入发送链路。
  if (!isPlainObject(payload)) {
    throw new Error('message-reporting 上报数据必须为 JSON 对象。')
  }

  // 读取初始化后的配置，未 init 时会在 getConfig(true) 内抛错。
  const config = getConfig(true)
  // 默认为每条上报注入 traceId，便于后端串联同一用户会话链路。
  const finalPayload: ReportPayload = {
    ...payload,
    [TRACE_ID_PAYLOAD_KEY]: currentTraceId,
  }

  // 为 gif 通道单独准备一份可选的精简 payload 字符串。
  let gifPayloadString: string | undefined
  if (config.includeRuntimeInfo) {
    // fetch/beacon 走完整版 runtimeInfo。
    finalPayload[RUNTIME_INFO_PAYLOAD_KEY] = collectRuntimeInfo(runtime)
    // gif 走精简 runtimeInfo，降低 URL 长度压力。
    const gifPayload: ReportPayload = {
      ...finalPayload,
      [RUNTIME_INFO_PAYLOAD_KEY]: collectGifRuntimeInfo(runtime),
    }
    gifPayloadString = serializePayload(gifPayload)
  }

  // 构建默认（完整版）payload，并连同 gif 精简 payload 一起交给发送层决策。
  const payloadString = serializePayload(finalPayload)
  const context = createReportContext(payloadString, options, immediate, runtime, gifPayloadString)

  // 按策略选择与降级链路执行实际发送。
  return executeTransport(config, context, runtime, options?.transport)
}

const sdk = createSdkExport({
  init,
  report,
  reportImmediate,
})

export type { InitOptions, PageStage, ReportOptions, ReportPayload, ReportResult, ResolvedInitOptions, TransportMode } from './types/index'

export default sdk
