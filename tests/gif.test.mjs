import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'tsup'

const output = await mkdtemp(join(tmpdir(), 'message-reporting-gif-'))
after(() => rm(output, { recursive: true, force: true }))
await build({
  entry: { utils: fileURLToPath(new URL('../src/utils.ts', import.meta.url)) },
  config: false,
  format: ['cjs'],
  platform: 'browser',
  target: 'es2019',
  outDir: output,
  outExtension: () => ({ js: '.cjs' }),
  dts: false,
  silent: true,
})
const { buildGifRequestUrl } = createRequire(import.meta.url)(join(output, 'utils.cjs'))
const payload = { event: 'business_gif', label: '中文 + / & = ? # %', traceId: 'trace +/=&中文#%' }
const serialized = JSON.stringify(payload)

function assertBusinessQuery(url) {
  assert.equal(url.searchParams.get('data'), serialized)
  assert.equal(url.searchParams.getAll('data').length, 1)
  assert.equal(url.searchParams.getAll('_ts').length, 1)
  assert.ok(Number(url.searchParams.get('_ts')) > 0)
}

test('GIF query carries only JSON business data and a cache timestamp', () => {
  const before = Date.now()
  const url = new URL(buildGifRequestUrl('https://collector.example/report.gif', serialized))
  assertBusinessQuery(url)
  assert.deepEqual([...url.searchParams.keys()].sort(), ['_ts', 'data'])
  assert.deepEqual(JSON.parse(url.searchParams.get('data')), payload)
  assert.ok(Number(url.searchParams.get('_ts')) >= before)
  assert.ok(Number(url.searchParams.get('_ts')) <= Date.now())
})

test('GIF query replaces duplicate SDK parameters and retains other query values', () => {
  const endpoint = 'https://collector.example/report.gif?tenant=a%2Bb&tag=one&tag=two&data=old&data=older&_ts=1&_ts=2#section'
  const url = new URL(buildGifRequestUrl(endpoint, serialized))
  assertBusinessQuery(url)
  assert.equal(url.searchParams.get('tenant'), 'a+b')
  assert.deepEqual(url.searchParams.getAll('tag'), ['one', 'two'])
  assert.equal(url.hash, '#section')
})

for (const endpoint of ['/report.gif', '/report.gif?tenant=demo#section', '../report.gif#section', '//collector.example/report.gif?', '?tenant=demo']) {
  test(`GIF query supports a relative or protocol-relative endpoint: ${endpoint}`, () => {
    const result = buildGifRequestUrl(endpoint, serialized)
    const url = new URL(result, 'https://app.example/nested/page')
    assertBusinessQuery(url)
    assert.equal(result.startsWith('https://'), false)
    assert.equal(url.hash, endpoint.includes('#') ? '#section' : '')
  })
}
