import { canSendEvent, cleanUrl, sendInternalEvent, type InternalEvent } from './event'
import { readField, readString } from './safe-read'
import type { BROWSER_KINDS } from './remote-config'

// 浏览器自动捕获：仅在初始化确认允许上报后安装窗口级监听器，采集同步 JavaScript 错误、
// 未处理 Promise 拒绝与资源加载错误，交给内部发送器异步上报；不覆盖宿主已有的全局处理器，
// 不阻止事件默认行为，停止时只移除自身监听器。

/**
 * 已安装的监听器
 * @description 记录安装监听器的窗口与对应处理器引用；部分监听器移除失败时只保留未能移除的处理器，供后续重试
 */
interface Installed {
  // 安装监听器的窗口
  win: Window
  // error 事件监听器，移除时须使用同一引用
  onError?: (event: Event) => void
  // unhandledrejection 事件监听器
  onRejection?: (event: Event) => void
}
let installed: Installed | undefined
/** 内联数据与 Blob 地址不包含可定位的位置，内容体积也不可控，因此不作为来源上报。 */
const INLINE_URL_PATTERN = /^(?:data|blob):/i

/**
 * 判断宿主是否具备采集能力
 * @description 无窗口、无法增删监听器或不支持 unhandledrejection 事件时不能宣称可以监控；
 * 浏览器对未知事件类型的 addEventListener 不会报错，因此必须显式探测该能力
 * @param win 候选窗口
 * @returns 是否具备安装监听器的能力
 */
export function canCapture(win: Window | undefined = globalThis.window): boolean {
  try {
    return win !== undefined && typeof win.addEventListener === 'function' && typeof win.removeEventListener === 'function' && 'onunhandledrejection' in win
  } catch {
    return false
  }
}

/**
 * 读取当前页面路径
 * @description 浏览器错误与控制台事件共用同一取值规则，避免两类事件的 `pagePath` 语义分叉
 * @param win 当前窗口
 * @returns 页面地址；不可读取时返回 undefined
 */
export function pagePath(win: Window): string | undefined {
  return readString(readField(win, 'location'), 'href')
}

/**
 * 判断错误事件目标是否为资源元素并映射事件类型
 * @description 资源元素的 error 事件不冒泡，只能通过捕获阶段取得；脚本运行错误的目标为窗口
 * @param target 事件目标
 * @returns 图片、脚本或其他资源类型；目标不是元素时返回 undefined
 */
function elementKind(target: unknown): 'img' | 'script' | 'resource' | undefined {
  if (readField(target, 'nodeType') !== 1) return undefined
  const tagName = readString(target, 'tagName')
  if (tagName === undefined) return undefined
  const tag = tagName.toUpperCase()
  // SVG 的 image 元素通过 href 加载图片，与 HTML img 归为同一类别。
  if (tag === 'IMG' || tag === 'IMAGE') return 'img'
  return tag === 'SCRIPT' ? 'script' : 'resource'
}

/**
 * 读取资源元素实际加载的地址
 * @description 图片优先取 currentSrc，其他元素依次尝试 src、href 与 data；
 * SVG 的 href 是 SVGAnimatedString，实际地址位于 baseVal
 * @param element 资源元素
 * @returns 元素地址；不可读取时返回 undefined
 */
function resourceUrl(element: unknown): string | undefined {
  for (const key of ['currentSrc', 'src', 'href', 'data']) {
    const value = readString(element, key)
    if (value !== undefined) return value
  }
  return readString(readField(element, 'href'), 'baseVal')
}

/**
 * 组装各类事件共有的字段
 * @param win 当前窗口
 * @param kind 事件类型
 * @param message 原始消息或拒绝值
 * @returns 含级别、发生时间与页面路径的内部事件
 */
function baseInput(win: Window, kind: InternalEvent['kind'], message: unknown): InternalEvent {
  const input: InternalEvent = { kind, level: 'error', message, occurredAt: Date.now() }
  const path = pagePath(win)
  if (path !== undefined) input.pagePath = path
  return input
}

/**
 * 写入错误对象可安全提供的名称与堆栈
 * @param input 内部事件
 * @param value 错误对象或拒绝值
 */
function applyErrorFields(input: InternalEvent, value: unknown): void {
  const name = readString(value, 'name')
  if (name !== undefined) input.name = name
  const stack = readString(value, 'stack')
  if (stack !== undefined) input.stack = stack
}

/**
 * 组装脚本运行错误事件
 * @description 跨域脚本可能只提供受限信息；缺少堆栈、名称或来源时省略对应字段
 * @param win 当前窗口
 * @param event 浏览器 error 事件
 * @returns 内部事件
 */
function scriptInput(win: Window, event: Event): InternalEvent {
  const error = readField(event, 'error')
  const input = baseInput(win, 'javascript', readString(event, 'message') ?? error ?? 'Script error.')
  applyErrorFields(input, error)
  const filename = readString(event, 'filename')
  if (filename !== undefined) {
    const source: NonNullable<InternalEvent['source']> = { url: filename }
    // 行列号的合法范围由发送器统一校验，避免两处各维护一份规则。
    const line = readField(event, 'lineno')
    if (typeof line === 'number') source.line = line
    const column = readField(event, 'colno')
    if (typeof column === 'number') source.column = column
    input.source = source
  }
  return input
}

/**
 * 组装资源元素加载错误事件
 * @description 地址取元素实际加载地址并复用发送器的 URL 清理规则；内联数据与 Blob 地址不进入事件内容，
 * 缺失地址时退回元素标签名
 * @param win 当前窗口
 * @param kind 资源类型
 * @param element 资源元素
 * @returns 内部事件
 */
function resourceInput(win: Window, kind: 'img' | 'script' | 'resource', element: unknown): InternalEvent {
  const raw = resourceUrl(element)
  const url = raw === undefined || INLINE_URL_PATTERN.test(raw) ? undefined : raw
  const tagName = readString(element, 'tagName')
  const message = url === undefined ? `Failed to load resource: ${tagName ?? kind}` : `Failed to load resource: ${cleanUrl(url)}`
  const input = baseInput(win, kind, message)
  if (url !== undefined) input.source = { url }
  return input
}

/**
 * 组装未处理 Promise 拒绝事件
 * @description 拒绝值原样交给内部发送器归一化，只从对象按需读取名称与堆栈
 * @param win 当前窗口
 * @param event 浏览器 unhandledrejection 事件
 * @returns 内部事件
 */
function rejectionInput(win: Window, event: Event): InternalEvent {
  const reason = readField(event, 'reason')
  const input = baseInput(win, 'unhandledrejection', reason)
  applyErrorFields(input, reason)
  return input
}

/**
 * 处理单个浏览器事件
 * @description 同一事件对象只处理一次；超出并发额度的事件在组装前丢弃；采集、整理与发送的任何异常
 * 都不得影响宿主页面或产生新的错误事件
 * @param seen 已处理的浏览器事件对象
 * @param event 浏览器事件
 * @param build 按事件组装内部事件
 */
function report(seen: WeakSet<Event>, event: Event, build: () => InternalEvent): void {
  try {
    if (seen.has(event)) return
    seen.add(event)
    if (!canSendEvent()) return
    void sendInternalEvent(build()).catch(() => {})
  } catch {
    // 采集或发送失败时静默丢弃，避免递归上报。
  }
}

/**
 * 安装浏览器错误监听器
 * @description 资源错误需要捕获阶段监听，脚本运行错误与未处理拒绝均从窗口取得；运行时按配置过滤事件类型。
 * 重复调用先移除上一次安装，上一次安装的监听器无法移除时不再注册，避免同一事件被重复上报；缺少能力或安装抛错时返回 false，不改变宿主页面
 * @param kinds 需要采集的浏览器事件类型
 * @returns 是否安装成功
 */
export function installCapture(kinds: readonly (typeof BROWSER_KINDS)[number][]): boolean {
  uninstallCapture()
  // 仍有未能移除的监听器时继续注册会造成重复采集。
  if (installed) return false
  try {
    const win = globalThis.window
    if (!canCapture(win)) return false
    const seen = new WeakSet<Event>()
    const onError = (event: Event): void => {
      try {
        const target = readField(event, 'target')
        const kind = elementKind(target)
        if (!kinds.includes(kind ?? 'javascript')) return
        report(seen, event, () => (kind === undefined ? scriptInput(win, event) : resourceInput(win, kind, target)))
      } catch {
        // 宿主事件属性读取失败时忽略本次事件。
      }
    }
    const onRejection = (event: Event): void => {
      if (kinds.includes('unhandledrejection')) report(seen, event, () => rejectionInput(win, event))
    }
    win.addEventListener('error', onError, true)
    // 先记录已注册的监听器再注册第二个：第二个失败且回滚也失败时，仍可在后续停止或重新初始化时重试移除。
    installed = { win, onError }
    try {
      win.addEventListener('unhandledrejection', onRejection, false)
    } catch {
      uninstallCapture()
      return false
    }
    installed = { win, onError, onRejection }
    return true
  } catch {
    return false
  }
}

/**
 * 移除 SDK 安装的监听器
 * @description 不触碰宿主已有的处理器；每个监听器独立移除，失败项保留在跟踪状态中供后续重试
 */
export function uninstallCapture(): void {
  const current = installed
  if (!current) return
  installed = undefined
  const failed: Installed = { win: current.win }
  if (current.onError !== undefined) {
    try {
      current.win.removeEventListener('error', current.onError, true)
    } catch {
      failed.onError = current.onError
    }
  }
  if (current.onRejection !== undefined) {
    try {
      current.win.removeEventListener('unhandledrejection', current.onRejection, false)
    } catch {
      failed.onRejection = current.onRejection
    }
  }
  if (failed.onError !== undefined || failed.onRejection !== undefined) installed = failed
}
