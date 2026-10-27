import type { ReportContext, ReportResult, ResolvedInitOptions, RuntimeLike, TransportMode } from './types/index'
import { buildGifRequestUrl } from './utils'

/**
 * @description 判断当前运行时是否支持 sendBeacon。
 * @param {RuntimeLike} runtime - 当前浏览器运行时对象。
 * @return {boolean} 支持 sendBeacon 时返回 true，否则返回 false。
 */
export function supportsBeacon(runtime: RuntimeLike): boolean {
  return typeof runtime.navigator?.sendBeacon === 'function'
}

/**
 * @description 判断当前运行时是否支持 fetch。
 * @param {RuntimeLike} runtime - 当前浏览器运行时对象。
 * @return {boolean} 支持 fetch 时返回 true，否则返回 false。
 */
export function supportsFetch(runtime: RuntimeLike): boolean {
  return typeof runtime.fetch === 'function'
}

/**
 * @description 判断当前运行时是否支持通过 Image 发送 gif 请求。
 * @param {RuntimeLike} runtime - 当前浏览器运行时对象。
 * @return {boolean} 支持 Image 构造函数时返回 true，否则返回 false。
 */
export function supportsGif(runtime: RuntimeLike): boolean {
  return typeof runtime.Image === 'function'
}

/**
 * @description 根据页面阶段、数据体积和环境能力选择首选发送通道。
 * @param {ResolvedInitOptions} config - 标准化后的 SDK 配置。
 * @param {ReportContext} context - 当前上报上下文。
 * @param {RuntimeLike} runtime - 当前浏览器运行时对象。
 * @return {TransportMode} 返回本次上报的首选发送通道。
 */
export function selectTransport(config: ResolvedInitOptions, context: ReportContext, runtime: RuntimeLike): TransportMode {
  const preferBeacon = context.immediate || context.stage !== 'normal'
  const gifPayloadSize = context.gifPayloadSize ?? context.payloadSize

  if (preferBeacon && supportsBeacon(runtime) && context.payloadSize <= config.beaconMaxPayloadBytes) {
    return 'beacon'
  }

  if (config.preferGifForSmallPayload && gifPayloadSize <= config.gifMaxPayloadBytes && supportsGif(runtime)) {
    return 'gif'
  }

  if (supportsFetch(runtime)) {
    return 'fetch'
  }

  if (supportsBeacon(runtime) && context.payloadSize <= config.beaconMaxPayloadBytes) {
    return 'beacon'
  }

  return 'gif'
}

/**
 * @description 构建稳定可预测的降级链路，并过滤当前不可用的通道。
 * @param {TransportMode} preferredTransport - 已选出的首选发送通道。
 * @param {ResolvedInitOptions} config - 标准化后的 SDK 配置。
 * @param {ReportContext} context - 当前上报上下文。
 * @param {RuntimeLike} runtime - 当前浏览器运行时对象。
 * @return {TransportMode[]} 返回按优先级排序的可尝试通道列表。
 */
export function buildTransportChain(
  preferredTransport: TransportMode,
  config: ResolvedInitOptions,
  context: ReportContext,
  runtime: RuntimeLike,
): TransportMode[] {
  const chainMap: Record<TransportMode, TransportMode[]> = {
    beacon: ['beacon', 'fetch', 'gif'],
    fetch: ['fetch', 'beacon', 'gif'],
    gif: ['gif', 'fetch', 'beacon'],
  }
  const gifPayloadSize = context.gifPayloadSize ?? context.payloadSize

  return chainMap[preferredTransport].filter((transport) => {
    if (transport === 'beacon') {
      return supportsBeacon(runtime) && context.payloadSize <= config.beaconMaxPayloadBytes
    }

    if (transport === 'fetch') {
      return supportsFetch(runtime)
    }

    return supportsGif(runtime) && gifPayloadSize <= config.gifMaxPayloadBytes
  })
}

/**
 * @description 使用 sendBeacon 发送上报数据。
 * @param {ResolvedInitOptions} config - 标准化后的 SDK 配置。
 * @param {ReportContext} context - 当前上报上下文。
 * @param {RuntimeLike} runtime - 当前浏览器运行时对象。
 * @return {boolean} 浏览器接受 beacon 任务时返回 true，否则返回 false。
 */
export function sendByBeacon(config: ResolvedInitOptions, context: ReportContext, runtime: RuntimeLike): boolean {
  if (!supportsBeacon(runtime)) {
    return false
  }

  const beaconBody = typeof runtime.Blob === 'function' ? new runtime.Blob([context.payloadString], { type: 'application/json' }) : context.payloadString

  return runtime.navigator!.sendBeacon(config.endpoint, beaconBody)
}

/**
 * @description 使用 fetch 发送 JSON 请求。
 * @param {ResolvedInitOptions} config - 标准化后的 SDK 配置。
 * @param {ReportContext} context - 当前上报上下文。
 * @param {RuntimeLike} runtime - 当前浏览器运行时对象。
 * @return {Promise<boolean>} 服务端返回 2xx 响应时返回 true，否则返回 false。
 */
export async function sendByFetch(config: ResolvedInitOptions, context: ReportContext, runtime: RuntimeLike): Promise<boolean> {
  if (!supportsFetch(runtime)) {
    return false
  }

  try {
    const response = await runtime.fetch!(config.endpoint, {
      method: 'POST',
      headers: { ...config.headers },
      body: context.payloadString,
      credentials: config.fetchCredentials,
      keepalive: context.immediate || context.stage !== 'normal',
    })

    return response.ok
  } catch {
    return false
  }
}

/**
 * @description 使用 gif 图片请求作为兜底发送方案。
 * @param {ResolvedInitOptions} config - 标准化后的 SDK 配置。
 * @param {ReportContext} context - 当前上报上下文。
 * @param {RuntimeLike} runtime - 当前浏览器运行时对象。
 * @return {Promise<boolean>} 图片请求触发成功时返回 true，否则返回 false。
 */
export function sendByGif(config: ResolvedInitOptions, context: ReportContext, runtime: RuntimeLike): Promise<boolean> {
  if (!supportsGif(runtime)) {
    return Promise.resolve(false)
  }

  return new Promise<boolean>((resolve) => {
    const image = new runtime.Image!(1, 1)
    const finalize = (result: boolean): void => {
      image.onload = null
      image.onerror = null
      resolve(result)
    }

    image.onload = (): void => finalize(true)
    image.onerror = (): void => finalize(false)
    const gifPayloadString = context.gifPayloadString ?? context.payloadString
    image.src = buildGifRequestUrl(config.gifEndpoint, gifPayloadString)
  })
}

/**
 * @description 按首选策略和降级顺序执行发送流程。
 * @param {ResolvedInitOptions} config - 标准化后的 SDK 配置。
 * @param {ReportContext} context - 当前上报上下文。
 * @param {RuntimeLike} runtime - 当前浏览器运行时对象。
 * @param {TransportMode | undefined} forcedTransport - 调用方显式指定的发送通道。
 * @return {Promise<ReportResult>} 返回本次发送结果及尝试过的通道信息。
 */
export async function executeTransport(
  config: ResolvedInitOptions,
  context: ReportContext,
  runtime: RuntimeLike,
  forcedTransport: TransportMode | undefined,
): Promise<ReportResult> {
  const preferredTransport = forcedTransport ?? selectTransport(config, context, runtime)
  const transportChain = buildTransportChain(preferredTransport, config, context, runtime)

  if (transportChain.length === 0) {
    throw new Error('message-reporting 当前环境没有可用的发送通道。')
  }

  for (const transport of transportChain) {
    if (transport === 'beacon' && sendByBeacon(config, context, runtime)) {
      return {
        ok: true,
        transport,
        payloadSize: context.payloadSize,
        attemptedTransports: [transport],
      }
    }

    if (transport === 'fetch' && (await sendByFetch(config, context, runtime))) {
      return {
        ok: true,
        transport,
        payloadSize: context.payloadSize,
        attemptedTransports: transportChain.slice(0, transportChain.indexOf(transport) + 1),
      }
    }

    if (transport === 'gif' && (await sendByGif(config, context, runtime))) {
      return {
        ok: true,
        transport,
        payloadSize: context.gifPayloadSize ?? context.payloadSize,
        attemptedTransports: transportChain.slice(0, transportChain.indexOf(transport) + 1),
      }
    }
  }

  return {
    ok: false,
    transport: transportChain[transportChain.length - 1],
    payloadSize: context.payloadSize,
    attemptedTransports: transportChain,
  }
}
