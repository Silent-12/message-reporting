import { readField, readString } from './safe-read'

/**
 * 浏览器环境信息
 * @description 只包含浏览器实际提供的 UA、在线状态与网络有效类型，缺失字段不推断精确网络或设备身份
 */
export interface Environment {
  // 浏览器 User-Agent
  userAgent?: string
  // 浏览器报告的在线状态
  online?: boolean
  // 浏览器报告的网络有效类型，例如 4g
  effectiveType?: string
}

/**
 * 从当前运行时读取环境信息
 * @description 仅读取 `navigator.userAgent`、`navigator.onLine` 与 `navigator.connection.effectiveType`，
 * 任一属性缺失、为空或读取抛错时省略对应字段；浏览器未提供网络信息 API 时不推断网络类型
 * @returns 至少含一个字段的环境信息；全部缺失时返回 undefined
 */
export function readEnvironment(): Environment | undefined {
  const navigator = readField(globalThis, 'navigator')
  const userAgent = readString(navigator, 'userAgent')
  const online = readField(navigator, 'onLine')
  const effectiveType = readString(readField(navigator, 'connection'), 'effectiveType')
  const environment: Environment = {}
  if (userAgent !== undefined) environment.userAgent = userAgent
  if (typeof online === 'boolean') environment.online = online
  if (effectiveType !== undefined) environment.effectiveType = effectiveType
  return Object.keys(environment).length ? environment : undefined
}
