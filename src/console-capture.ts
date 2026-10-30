import type { ConsoleLevel } from './types/index'
import { pagePath } from './capture'
import { canSendEvent, sendInternalEvent, type InternalEvent } from './event'
import { readString } from './safe-read'

// 控制台采集：仅在准入允许后按级别包装当前窗口的 console 方法，宿主原有输出照常执行，
// 参数整理为有界文本后交给内部发送器异步上报；不触发 getter、不递归上报，
// 停止时只还原 SDK 自己安装的包装。

/** 单次控制台调用最多读取的参数个数。 */
const MAX_ARGUMENTS = 10
/** 单个对象最多读取的自有属性个数。 */
const MAX_PROPERTIES = 10
/** 参数快照的最大展开层数，根参数计为第 1 层，超出时使用占位文本。 */
const MAX_DEPTH = 2
/** 单条控制台消息的字符上限，发送前仍按明文体积上限二次裁剪。 */
const MAX_MESSAGE_CHARS = 8192

/**
 * 已安装的控制台方法
 * @description 记录包装前后的方法与原始属性描述符，用于精确还原且不覆盖宿主实现
 */
interface InstalledMethod {
  // 安装包装的窗口控制台对象
  host: Console
  // 该方法对应的控制台级别
  level: ConsoleLevel
  // 包装前的宿主方法，包装调用时原样转发
  original: (...args: unknown[]) => void
  // 本 SDK 安装的包装；包装需引用本记录，因此创建后再赋值
  wrapper: (...args: unknown[]) => void
  // 安装前的属性描述符；方法来自原型时为 undefined，还原时改为删除自有属性
  descriptor: PropertyDescriptor | undefined
  // 是否仍启用；还原后置为 false，用于忽略宿主仍持有的旧包装
  active: boolean
}

const installed = new Map<ConsoleLevel, InstalledMethod>()
// 包装正在执行本次调用时为 true，避免宿主方法或后续处理再次进入包装造成递归上报。
let handling = false

/**
 * 把单个控制台参数转换为有界的可序列化快照
 * @description 只读取自有数据属性，不触发 getter 也不调用 toJSON；循环引用、超出深度或属性数量的部分使用占位文本
 * @param value 待快照的参数
 * @param depth 剩余可展开层数
 * @param seen 当前递归路径上的对象，用于识别循环引用
 * @returns 可安全序列化的值
 */
function snapshot(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string') return value.slice(0, MAX_MESSAGE_CHARS)
  if (typeof value === 'undefined') return 'undefined'
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value)
  if (typeof value === 'function') return '[function]'
  if (value instanceof Error) return `${readString(value, 'name') ?? 'Error'}: ${readString(value, 'message') ?? ''}`
  if (seen.has(value)) return '[circular]'
  if (depth === 0) return Array.isArray(value) ? '[array]' : '[object]'
  seen.add(value)
  try {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    let count = 0
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      if (count === MAX_PROPERTIES) {
        result['…'] = 'more properties'
        break
      }
      count++
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      result[key] = descriptor && 'value' in descriptor ? snapshot(descriptor.value, depth - 1, seen) : '[accessor]'
    }
    return result
  } finally {
    seen.delete(value)
  }
}

/**
 * 把控制台参数整理为单条消息
 * @description 参数逐个快照后按顺序以空格连接，非字符串值序列化为 JSON；超出数量或长度的部分截断并标注
 * @param args 控制台调用的原始参数
 * @returns 不超过字符上限的消息文本
 */
function messageFrom(args: unknown[]): string {
  const parts: string[] = []
  for (const arg of args.slice(0, MAX_ARGUMENTS)) {
    try {
      const value = snapshot(arg, MAX_DEPTH, new WeakSet())
      parts.push(typeof value === 'string' ? value : JSON.stringify(value))
    } catch {
      parts.push('[unavailable]')
    }
  }
  if (args.length > MAX_ARGUMENTS) parts.push(`[${args.length - MAX_ARGUMENTS} more arguments]`)
  return parts.join(' ').slice(0, MAX_MESSAGE_CHARS)
}

/**
 * 还原单个控制台方法
 * @description 仅在当前属性仍是本 SDK 的包装时还原，宿主随后改写的实现不被覆盖
 * @param entry 已安装的方法记录
 */
function restore(entry: InstalledMethod): void {
  entry.active = false
  try {
    if (entry.host[entry.level] !== entry.wrapper) return
    if (entry.descriptor) Object.defineProperty(entry.host, entry.level, entry.descriptor)
    else Reflect.deleteProperty(entry.host, entry.level)
  } catch {
    // 宿主随后改写了控制台属性时，旧包装已停用，不覆盖宿主实现。
  }
}

/**
 * 按级别安装或更新控制台包装
 * @description 只在当前窗口的对应方法可写时安装；任一方法安装失败时回滚本次新增的包装并保留原有状态，
 * 不在目标级别中的旧包装会被还原，级别为空时全部停用
 * @param levels 需要监听的级别
 * @returns 是否已达成期望的安装状态
 */
export function configureConsoleCapture(levels: readonly ConsoleLevel[]): boolean {
  const desired = new Set(levels)
  if (desired.size === 0) {
    uninstallConsoleCapture()
    return true
  }
  const added: InstalledMethod[] = []
  let host: Console
  try {
    const win = globalThis.window
    host = win.console
    if (!host) return false
    for (const level of desired) {
      const existing = installed.get(level)
      if (existing?.host === host && host[level] === existing.wrapper) continue
      const original = host[level]
      if (typeof original !== 'function') throw new Error('console method unavailable')
      const entry: InstalledMethod = {
        host,
        level,
        original,
        wrapper: () => {},
        descriptor: Object.getOwnPropertyDescriptor(host, level),
        active: true,
      }
      entry.wrapper = function (...args: unknown[]): void {
        if (handling) return entry.original.apply(host, args)
        handling = true
        try {
          entry.original.apply(host, args)
          if (!entry.active || !canSendEvent()) return
          try {
            const input: InternalEvent = {
              kind: 'other',
              level,
              name: `console.${level}`,
              message: messageFrom(args),
              occurredAt: Date.now(),
              skipContext: true,
            }
            const path = pagePath(win)
            if (path !== undefined) input.pagePath = path
            const error = args.find((arg) => arg instanceof Error)
            const stack = readString(error, 'stack')
            if (stack !== undefined) input.stack = stack
            void sendInternalEvent(input).catch(() => {})
          } catch {
            // 控制台采集失败不得改变宿主调用结果。
          }
        } finally {
          handling = false
        }
      }
      added.push(entry)
      if (!Reflect.set(host, level, entry.wrapper) || host[level] !== entry.wrapper) throw new Error('console method not writable')
    }
  } catch {
    for (const entry of added) restore(entry)
    return false
  }
  for (const [level, entry] of installed) {
    if (!desired.has(level) || entry.host !== host || entry.host[level] !== entry.wrapper) {
      restore(entry)
      installed.delete(level)
    }
  }
  for (const entry of added) installed.set(entry.level, entry)
  return true
}

/**
 * 停用控制台包装
 * @description 逐个还原 SDK 自己安装的方法，不触碰宿主已有的实现；重复调用无副作用
 */
export function uninstallConsoleCapture(): void {
  for (const entry of installed.values()) restore(entry)
  installed.clear()
}
