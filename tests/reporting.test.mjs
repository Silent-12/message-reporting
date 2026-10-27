import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const artifacts = new URL('../dist/', import.meta.url)
const traceKey = '__message_reporting_trace_id__'
const endpoint = 'https://collector.example/report'
const testTimestamp = 1700000000000

async function loadBrowserBundle(format, { fetchOk = true, beaconOk = true, now = () => testTimestamp, imageRequest = () => true } = {}) {
  const calls = []
  const storage = new Map([[traceKey, 'migration-test-trace']])
  const module = { exports: {} }
  const sandbox = {
    module,
    exports: module.exports,
    console: { log() {} },
    TextEncoder,
    Blob,
    URLSearchParams,
    Date: class extends Date {
      static now() {
        return now()
      }
    },
    crypto: {
      randomUUID: () => webcrypto.randomUUID(),
    },
    document: { visibilityState: 'visible' },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    navigator: {
      sendBeacon(url, body) {
        calls.push({ transport: 'beacon', url, body })
        return beaconOk
      },
    },
    async fetch(url, options) {
      calls.push({ transport: 'fetch', url, ...options })
      return { ok: fetchOk }
    },
    Image: class {
      set src(url) {
        calls.push({ transport: 'gif', url })
        Promise.resolve()
          .then(() => imageRequest(url))
          .then(
            (success) => (success ? this.onload?.() : this.onerror?.()),
            () => this.onerror?.(),
          )
      }
    },
  }
  const filename = format === 'cjs' ? 'index.cjs' : 'index.global.js'
  runInNewContext(await readFile(new URL(filename, artifacts), 'utf8'), sandbox, { filename })
  return { sdk: format === 'cjs' ? module.exports : sandbox.MessageReportingSDK, calls }
}

test('build emits all eight declared artifacts', async () => {
  assert.deepEqual((await readdir(artifacts)).sort(), [
    'index.cjs',
    'index.cjs.map',
    'index.d.cts',
    'index.d.ts',
    'index.global.js',
    'index.global.js.map',
    'index.js',
    'index.js.map',
  ])
})

test('ESM and CJS expose named methods and the default SDK object', async () => {
  const esm = await import('../dist/index.js')
  const cjs = createRequire(import.meta.url)('../dist/index.cjs')
  for (const sdk of [esm, cjs]) {
    for (const name of ['init', 'report', 'reportImmediate']) {
      assert.equal(typeof sdk[name], 'function')
      assert.equal(sdk.default[name], sdk[name])
    }
  }
})

for (const format of ['cjs', 'iife']) {
  test(`${format}: small reports use GIF and retain traceId and query parameters`, async () => {
    const { sdk, calls } = await loadBrowserBundle(format)
    sdk.init({ endpoint, gifEndpoint: `${endpoint}.gif?tenant=demo` })
    const payload = { event: 'page_view', label: '中文 & value' }
    const result = await sdk.report(payload)
    assert.equal(result.ok, true)
    assert.equal(result.transport, 'gif')
    assert.equal(calls.length, 1)
    const url = new URL(calls[0].url)
    assert.equal(url.searchParams.get('tenant'), 'demo')
    assert.ok(Number(url.searchParams.get('_ts')) > 0)
    assert.deepEqual(JSON.parse(url.searchParams.get('data')), { ...payload, traceId: 'migration-test-trace' })
    assert.equal(payload.traceId, undefined)
  })

  test(`${format}: fetch sends JSON to the caller's endpoint with custom headers`, async () => {
    const { sdk, calls } = await loadBrowserBundle(format)
    sdk.init({ endpoint, preferGifForSmallPayload: false, headers: { 'x-tenant': 'demo' }, fetchCredentials: 'omit' })
    const result = await sdk.report({ event: 'fetch_report' })
    assert.equal(result.ok, true)
    assert.equal(result.transport, 'fetch')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, endpoint)
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].headers['content-type'], 'application/json')
    assert.equal(calls[0].headers['x-tenant'], 'demo')
    assert.equal(calls[0].credentials, 'omit')
    assert.equal(calls[0].keepalive, false)
    assert.equal(JSON.parse(calls[0].body).event, 'fetch_report')
  })

  test(`${format}: immediate reporting uses a JSON beacon`, async () => {
    const { sdk, calls } = await loadBrowserBundle(format)
    sdk.init({ endpoint })
    const result = await sdk.reportImmediate({ event: 'page_exit' })
    assert.equal(result.ok, true)
    assert.equal(result.transport, 'beacon')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, endpoint)
    assert.equal(calls[0].body.type, 'application/json')
    assert.equal(JSON.parse(await calls[0].body.text()).event, 'page_exit')
  })

  test(`${format}: failed fetch and rejected beacon fall back to GIF`, async () => {
    const { sdk, calls } = await loadBrowserBundle(format, { fetchOk: false, beaconOk: false })
    sdk.init({ endpoint, preferGifForSmallPayload: false })
    const result = await sdk.report({ event: 'fallback' })
    assert.equal(result.ok, true)
    assert.equal(result.transport, 'gif')
    assert.deepEqual(
      calls.map((call) => call.transport),
      ['fetch', 'beacon', 'gif'],
    )
    assert.deepEqual(Array.from(result.attemptedTransports), ['fetch', 'beacon', 'gif'])
  })

  for (const transport of ['fetch', 'beacon', 'gif']) {
    test(`${format}: ${transport} sends business fields without adding metadata beyond traceId`, async () => {
      const { sdk, calls } = await loadBrowserBundle(format)
      const config = sdk.init({ endpoint, preferGifForSmallPayload: false })
      assert.deepEqual(
        Object.keys(config).sort(),
        [
          'endpoint',
          'gifEndpoint',
          'headers',
          'fetchCredentials',
          'beaconMaxPayloadBytes',
          'gifMaxPayloadBytes',
          'preferGifForSmallPayload',
          'includeRuntimeInfo',
        ].sort(),
      )
      const payload = { event: 'business_report', amount: 12.5, details: { label: '中文 + & %', values: [1, 2] } }
      const result = await sdk.report(payload, { transport })
      assert.equal(result.ok, true)
      assert.equal(result.transport, transport)
      assert.equal(calls.length, 1)
      const body = transport === 'gif' ? new URL(calls[0].url).searchParams.get('data') : transport === 'beacon' ? await calls[0].body.text() : calls[0].body
      assert.deepEqual(JSON.parse(body), { ...payload, traceId: 'migration-test-trace' })
      assert.equal(payload.traceId, undefined)
      if (transport === 'gif') assert.deepEqual([...new URL(calls[0].url).searchParams.keys()].sort(), ['_ts', 'data'])
    })
  }

  test(`${format}: GIF fallback preserves compact runtime data and query parameters`, async () => {
    const { sdk, calls } = await loadBrowserBundle(format, { fetchOk: false, beaconOk: false })
    sdk.init({ endpoint, gifEndpoint: `${endpoint}.gif?tenant=demo#section`, includeRuntimeInfo: true, preferGifForSmallPayload: false })
    const result = await sdk.report({ event: 'runtime_fallback' })
    assert.equal(result.ok, true)
    assert.equal(result.transport, 'gif')
    assert.deepEqual(
      calls.map((call) => call.transport),
      ['fetch', 'beacon', 'gif'],
    )
    const url = new URL(calls[2].url)
    const payload = JSON.parse(url.searchParams.get('data'))
    assert.equal(url.searchParams.get('tenant'), 'demo')
    assert.equal(url.hash, '#section')
    assert.equal(payload.event, 'runtime_fallback')
    assert.equal(payload.traceId, 'migration-test-trace')
    assert.equal('ua' in payload.runtimeInfo, false)
    assert.equal('ua' in JSON.parse(calls[0].body).runtimeInfo, true)
  })

  test(`${format}: GIF payloads above the configured byte limit use fetch`, async () => {
    const { sdk, calls } = await loadBrowserBundle(format)
    sdk.init({ endpoint, gifMaxPayloadBytes: 1500 })
    const result = await sdk.report({ event: 'large_report', message: 'x'.repeat(1600) })
    assert.equal(result.transport, 'fetch')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].transport, 'fetch')
  })

  test(`${format}: GIF GET reaches an independent business collector`, { timeout: 5000 }, async () => {
    const requests = []
    const server = createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1')
      requests.push({
        method: request.method,
        path: url.pathname,
        keys: [...url.searchParams.keys()].sort(),
        payload: JSON.parse(url.searchParams.get('data')),
        tenant: url.searchParams.get('tenant'),
      })
      response.writeHead(200, { 'content-type': 'image/gif' })
      response.end(Buffer.from('R0lGODlhAQABAPAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'))
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const origin = `http://127.0.0.1:${server.address().port}`
      const { sdk } = await loadBrowserBundle(format, {
        imageRequest: async (url) => {
          const response = await fetch(url)
          await response.arrayBuffer()
          return response.ok
        },
      })
      sdk.init({ endpoint: `${origin}/collect`, gifEndpoint: `${origin}/report.gif?tenant=demo` })
      const result = await sdk.report({ event: 'business_get', label: '中文 + & %' }, { transport: 'gif' })
      assert.equal(result.ok, true)
      assert.equal(result.transport, 'gif')
      assert.equal(requests.length, 1)
      assert.deepEqual(requests[0], {
        method: 'GET',
        path: '/report.gif',
        keys: ['_ts', 'data', 'tenant'],
        payload: { event: 'business_get', label: '中文 + & %', traceId: 'migration-test-trace' },
        tenant: 'demo',
      })
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test(`${format}: invalid initialization and payloads fail before transport`, async () => {
    const { sdk, calls } = await loadBrowserBundle(format)
    assert.throws(() => sdk.init({ endpoint: '' }), /endpoint/)
    await assert.rejects(sdk.report({ event: 'before_init' }), /init/)
    sdk.init({ endpoint })
    await assert.rejects(sdk.report([]), /JSON/)
    const circular = {}
    circular.self = circular
    await assert.rejects(sdk.report(circular), /序列化/)
    assert.equal(calls.length, 0)
  })
}

test('ESM reports reach an independent local HTTP collector', { timeout: 5000 }, async () => {
  const requests = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ method: request.method, url: request.url, contentType: request.headers['content-type'], payload: JSON.parse(body) })
    response.writeHead(204).end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const sdk = await import('../dist/index.js')
    sdk.init({
      endpoint: `http://127.0.0.1:${server.address().port}/collect`,
      preferGifForSmallPayload: false,
    })
    const result = await sdk.report({ event: 'migration_smoke' })
    assert.equal(result.ok, true)
    assert.equal(result.transport, 'fetch')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, 'POST')
    assert.equal(requests[0].url, '/collect')
    assert.equal(requests[0].contentType, 'application/json')
    assert.equal(requests[0].payload.event, 'migration_smoke')
    assert.ok(requests[0].payload.traceId)
    assert.deepEqual(Object.keys(requests[0].payload).sort(), ['event', 'traceId'])
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
