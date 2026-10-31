/** 浏览器自动采集的事件类型。 */
export const BROWSER_KINDS = ['javascript', 'unhandledrejection', 'img', 'script', 'resource'] as const
/** 允许采集的控制台级别。 */
export const EVENT_LEVELS = ['debug', 'info', 'warn', 'error'] as const
/** 控制台事件可选字段。 */
export const CONSOLE_FIELDS = ['name', 'stack', 'pagePath'] as const
/** 自动附加的环境字段。 */
export const ENVIRONMENT_FIELDS = ['userAgent', 'online', 'effectiveType'] as const

/**
 * 服务端按应用下发的采集配置
 * @description 数组只接受协议列出的值，事件地址为完整请求 URL 或 null
 */
export interface RemoteConfig {
  eventUrl: string | null
  browserKinds: (typeof BROWSER_KINDS)[number][]
  console: {
    enabled: boolean
    levels: (typeof EVENT_LEVELS)[number][]
    fields: (typeof CONSOLE_FIELDS)[number][]
  }
  environmentFields: (typeof ENVIRONMENT_FIELDS)[number][]
  contextEnabled: boolean
}

/**
 * 校验配置数组
 * @description 只接受允许清单中的值，且不允许重复
 * @param value 待校验的数组
 * @param choices 允许的取值清单
 * @returns 是否为无重复且取值均受允许的数组
 */
function validList<T extends string>(value: unknown, choices: readonly T[]): value is T[] {
  return Array.isArray(value) && value.every((item) => choices.includes(item)) && new Set(value).size === value.length
}

/**
 * 校验事件接收地址
 * @description 接受 null 或最长 2048 字符的完整 HTTP(S) 地址，允许查询参数，不允许凭据和片段
 * @param value 服务端下发的事件地址
 * @returns 是否为有效事件地址或 null
 */
export function validEventUrl(value: unknown): value is string | null {
  if (value === null) return true
  if (typeof value !== 'string' || !value || value.length > 2048 || value.includes('#')) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.hash
  } catch {
    return false
  }
}

/**
 * 校验服务端采集配置
 * @description 要求字段完整且无额外字段；数组取值须合法且无重复，开启控制台采集时须指定至少一个级别
 * @param value 服务端响应中的采集配置
 * @returns 是否为符合协议的完整配置
 */
export function validRemoteConfig(value: unknown): value is RemoteConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const config = value as Record<string, unknown>
  if (Object.keys(config).length !== 5 || !['eventUrl', 'browserKinds', 'console', 'environmentFields', 'contextEnabled'].every((key) => key in config))
    return false
  if (!validEventUrl(config.eventUrl) || !validList(config.browserKinds, BROWSER_KINDS) || !validList(config.environmentFields, ENVIRONMENT_FIELDS))
    return false
  if (typeof config.contextEnabled !== 'boolean' || typeof config.console !== 'object' || config.console === null || Array.isArray(config.console)) return false
  const consoleConfig = config.console as Record<string, unknown>
  return (
    Object.keys(consoleConfig).length === 3 &&
    ['enabled', 'levels', 'fields'].every((key) => key in consoleConfig) &&
    typeof consoleConfig.enabled === 'boolean' &&
    validList(consoleConfig.levels, EVENT_LEVELS) &&
    validList(consoleConfig.fields, CONSOLE_FIELDS) &&
    (!consoleConfig.enabled || consoleConfig.levels.length > 0)
  )
}
