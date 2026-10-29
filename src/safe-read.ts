/**
 * 安全读取对象字段
 * @description 属性访问可能因权限、代理、跨域或宿主实现抛错，读取失败按缺失处理
 * @param value 待读取对象
 * @param key 字段名
 * @returns 字段值；不可读取时返回 undefined
 */
export function readField(value: unknown, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/**
 * 读取非空字符串字段
 * @param value 待读取对象
 * @param key 字段名
 * @returns 非空字符串；缺失、空字符串或类型不符时返回 undefined
 */
export function readString(value: unknown, key: string): string | undefined {
  const field = readField(value, key)
  return typeof field === 'string' && field !== '' ? field : undefined
}
