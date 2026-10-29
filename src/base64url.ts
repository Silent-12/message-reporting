/**
 * 编码无填充 base64url
 * @description 逐字节转二进制字符串后编码，再替换 `+`、`/` 并去掉尾部填充
 * @param bytes 待编码字节
 * @returns 无 `=` 填充的 base64url 字符串
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 解码无填充 base64url
 * @description 按 43 字符 CID 的尾部位只补齐一个填充符，其他长度会由 atob 抛错
 * @param value 无填充 base64url 字符串
 * @returns 解码后的字节
 */
export function decodeBase64Url(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='), (char) => char.charCodeAt(0))
}
