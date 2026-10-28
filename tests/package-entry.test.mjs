import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'

// 仅校验发布入口契约：exports 条件须指向实际产物，ESM 与 CJS 均可按包名解析。
// 通过包名而非 dist 相对路径导入，覆盖接入方的真实解析路径。
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const require = createRequire(import.meta.url)

test('exports 条件指向实际产物', async () => {
  const conditions = pkg.exports['.']
  const entries = [conditions.import.types, conditions.import.default, conditions.require.types, conditions.require.default]

  for (const entry of entries) {
    const content = await readFile(new URL(entry, new URL('../', import.meta.url)), 'utf8')
    assert.ok(content.length > 0, `${entry} 应为非空文件`)
  }
})

test('ESM 按包名可命名导入', async () => {
  const sdk = await import('message-reporting')

  assert.equal(typeof sdk.init, 'function')
  assert.equal(typeof sdk.stop, 'function')
  assert.equal(typeof sdk.default.init, 'function')
})

test('CJS 按包名可 require', () => {
  const sdk = require('message-reporting')

  assert.equal(typeof sdk.init, 'function')
  assert.equal(typeof sdk.stop, 'function')
})
