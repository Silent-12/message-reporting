/**
 * HTTP 响应快照
 * @description 只保留协议判定所需的状态码与已解析正文。
 */
export interface HttpReply {
  // HTTP 状态码
  status: number
  // 已解析正文，读取或解析失败时为 undefined
  body: unknown
}

/**
 * 事件请求选项
 * @description 用钩子限制每次尝试，并跟踪实际未结束的请求。
 */
interface RequestOptions {
  // 发起每次尝试前的额度与时间窗检查，返回 false 表示放弃本次尝试
  beforeAttempt?: () => boolean
  // 每次实际发出的请求结束时调用一次，用于释放额度
  onSettled?: () => void
}

/** 单次请求超时，单位毫秒。 */
const REQUEST_TIMEOUT = 5000
/** 单个请求的最大尝试次数，含首次请求。 */
const REQUEST_ATTEMPTS = 4
/** 重试退避基数，单位毫秒；实际间隔为 1、2、4 秒。 */
const RETRY_BACKOFF = 1000

/** 判断未知值是否为非数组对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验统一响应结构及其 HTTP 状态。 */
export function isEnvelope(reply: HttpReply): reply is HttpReply & { body: Record<string, unknown> } {
  return isRecord(reply.body) && reply.body.code === reply.status && typeof reply.body.message === 'string' && typeof reply.body.timestamp === 'string'
}

/**
 * 可被停止信号中断的等待
 * @param ms 等待时长，单位毫秒
 * @param signal 停止信号
 * @returns 是否等待完整时长；被中断时返回 false
 */
function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel)
      resolve(true)
    }, ms)
    function cancel(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      resolve(false)
    }
    signal.addEventListener('abort', cancel, { once: true })
  })
}

/**
 * 发送带超时和有限重试的 JSON POST
 * @description 正文读取失败按网络错误重试，读取成功但 JSON 无效时不重试；可选钩子只跟踪实际请求的生命周期
 * @param url 请求地址
 * @param body 请求正文；调用方预先序列化以保证事件重试复用原信封
 * @param signal 外层停止信号
 * @param options 每次尝试的事件专用限制
 * @returns 最近一次响应；停止、限制或重试耗尽时返回 undefined
 */
export async function request(url: string, body: string, signal: AbortSignal, options: RequestOptions = {}): Promise<HttpReply | undefined> {
  for (let attempt = 0; attempt < REQUEST_ATTEMPTS && !signal.aborted; attempt++) {
    const local = new AbortController()
    if (options.beforeAttempt && !options.beforeAttempt()) return undefined
    const cancel = (): void => local.abort()
    signal.addEventListener('abort', cancel, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    let onStop: (() => void) | undefined
    let rejectedStatus: number | undefined
    try {
      const timeout = new Promise<HttpReply | undefined>((resolve) => {
        timer = setTimeout(() => {
          local.abort()
          resolve(rejectedStatus === undefined ? undefined : { status: rejectedStatus, body: undefined })
        }, REQUEST_TIMEOUT)
      })
      const stopped = new Promise<undefined>((resolve) => {
        onStop = (): void => resolve(undefined)
        signal.addEventListener('abort', onStop, { once: true })
        if (signal.aborted) resolve(undefined)
      })
      let fetchPromise: Promise<Response>
      try {
        fetchPromise = fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
          signal: local.signal,
        })
      } catch (error) {
        options.onSettled?.()
        throw error
      }
      const send = fetchPromise
        .then(async (response): Promise<HttpReply> => {
          if (response.status >= 400 && response.status < 500) rejectedStatus = response.status
          let text: string
          try {
            text = await response.text()
          } catch (error) {
            // 明确的 4xx 不重试，即使响应正文读取失败。
            if (response.status >= 400 && response.status < 500) return { status: response.status, body: undefined }
            throw error
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = undefined
          }
          return { status: response.status, body: parsed }
        })
        .finally(() => options.onSettled?.())
      const reply = await Promise.race([send, timeout, stopped])
      if (reply && reply.status < 500) return reply
    } catch {
      // 网络错误可有限重试；取消由外层信号决定。
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      if (onStop) signal.removeEventListener('abort', onStop)
    }
    if (attempt < REQUEST_ATTEMPTS - 1 && !(await delay(RETRY_BACKOFF * 2 ** attempt, signal))) return undefined
  }
  return undefined
}
