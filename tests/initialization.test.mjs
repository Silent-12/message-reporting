import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import vm from 'node:vm'
import * as sdk from '../dist/index.js'

const cid = Buffer.alloc(32, 42).toString('base64url')
const otherCid = Buffer.alloc(32, 43).toString('base64url')
const opts = { serverUrl: 'https://example.test/prefix/', appId: 'project1' }
const nativeFetch = globalThis.fetch
const envelope = (data, status = 200) => ({
  status,
  text: async () => JSON.stringify({ code: status, message: 'ok', data, timestamp: '2026-01-01T00:00:00Z' }),
})

function setup() {
  sdk.stop()
  const entries = new Map()
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => entries.set(key, value),
      removeItem: (key) => entries.delete(key),
    },
  })
  return entries
}

test('ESM、CJS 和 IIFE 只公开初始化与停止能力', async () => {
  const cjs = createRequire(import.meta.url)('../dist/index.cjs')
  const sandbox = {}
  vm.runInNewContext(await readFile(new URL('../dist/index.global.js', import.meta.url), 'utf8'), sandbox)
  for (const exported of [sdk, cjs, sandbox.MessageReportingSDK]) {
    assert.equal(typeof exported.init, 'function')
    assert.equal(typeof exported.stop, 'function')
    assert.equal(exported.report, undefined)
    assert.equal(exported.reportImmediate, undefined)
  }
})

test('签发并持久化 CID 后查询上报策略，停止后复用并保留路径前缀', async () => {
  const entries = setup()
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    return url.endsWith('/cids') ? envelope({ cid }) : envelope({ allowed: true })
  }
  assert.deepEqual(await sdk.init(opts), { status: 'allowed' })
  assert.equal(entries.size, 1)
  assert.equal(requests[0].url, 'https://example.test/prefix/v1/cids')
  assert.equal(requests[1].url, 'https://example.test/prefix/v1/admission')
  assert.equal(requests[0].options.credentials, 'omit')
  assert.equal(requests[0].options.referrerPolicy, 'no-referrer')
  sdk.stop()
  assert.deepEqual(await sdk.init({ ...opts, serverUrl: 'https://EXAMPLE.test:443/prefix' }), { status: 'allowed' })
  assert.equal(requests.length, 3)
})

test('不同应用隔离、禁止上报和参数校验', async () => {
  const entries = setup()
  globalThis.fetch = async (url) => (url.endsWith('/cids') ? envelope({ cid }) : envelope({ allowed: false }))
  assert.deepEqual(await sdk.init(opts), { status: 'denied' })
  assert.deepEqual(await sdk.init({ ...opts, appId: 'another2' }), { status: 'denied' })
  assert.equal(entries.size, 2)
  for (const bad of [
    { ...opts, appId: 'abc' },
    { ...opts, appId: 'ab-1' },
    { ...opts, serverUrl: 'http://example.test' },
    { ...opts, serverUrl: 'https://example.test/?' },
    { ...opts, serverUrl: 'https://user@example.test' },
  ])
    assert.equal((await sdk.init(bad)).status, 'invalid_config')
})

test('仅明确 CID_INVALID 时清理一致的存储值', async () => {
  const entries = setup()
  let error = { status: 401, code: undefined }
  globalThis.fetch = async (url) => (url.endsWith('/cids') ? envelope({ cid }) : envelope(error.code ? { errorCode: error.code } : null, error.status))
  assert.equal((await sdk.init(opts)).status, 'failed')
  assert.equal(entries.size, 1)
  error = { status: 401, code: 'CID_INVALID' }
  assert.deepEqual(await sdk.init(opts), { status: 'failed', errorCode: 'CID_INVALID' })
  assert.equal(entries.size, 0)
})

test('同一监控目标并发初始化共享过程，不同目标冲突；停止后迟到响应不能写入', async () => {
  const entries = setup()
  let resolveFetch
  globalThis.fetch = () =>
    new Promise((resolve) => {
      resolveFetch = resolve
    })
  const first = sdk.init(opts)
  assert.equal(sdk.init(opts), first)
  assert.deepEqual(await sdk.init({ ...opts, appId: 'other1' }), { status: 'conflict' })
  sdk.stop()
  assert.deepEqual(await first, { status: 'stopped' })
  resolveFetch(envelope({ cid }))
  await Promise.resolve()
  assert.equal(entries.size, 0)
})

test('同一监控目标并发与重复初始化共用过程，并接受新的上下文回调', async () => {
  setup()
  let resolveCids
  globalThis.fetch = (url) =>
    url.endsWith('/cids')
      ? new Promise((resolve) => {
          resolveCids = resolve
        })
      : Promise.resolve(envelope({ allowed: true }))
  const first = sdk.init({ ...opts, getContext: () => ({ route: '/a' }) })
  // 初始化进行中的同目标调用共用同一过程，并以最新传入的上下文回调为准
  assert.equal(sdk.init({ ...opts, getContext: () => ({ route: '/b' }) }), first)
  resolveCids(envelope({ cid }))
  assert.deepEqual(await first, { status: 'allowed' })
  assert.deepEqual(await sdk.init({ ...opts, getContext: () => ({ route: '/c' }) }), { status: 'allowed' })
})

test('不同服务端地址或路径前缀不共用 CID', async () => {
  const entries = setup()
  const requests = []
  globalThis.fetch = async (url) => {
    requests.push(url)
    return url.endsWith('/cids') ? envelope({ cid }) : envelope({ allowed: true })
  }
  assert.deepEqual(await sdk.init(opts), { status: 'allowed' })
  sdk.stop()
  assert.deepEqual(await sdk.init({ ...opts, serverUrl: 'https://example.test/other-prefix' }), { status: 'allowed' })
  assert.equal(entries.size, 2)
  assert.equal(requests.filter((url) => url.endsWith('/cids')).length, 2)
})

test('持久化失败和无效响应不能进入允许状态', async () => {
  setup()
  globalThis.localStorage.setItem = () => {
    throw new Error('storage')
  }
  globalThis.fetch = async () => envelope({ cid })
  assert.equal((await sdk.init(opts)).status, 'unavailable')
  setup()
  globalThis.fetch = async () => envelope({ cid: otherCid + '=' })
  assert.equal((await sdk.init(opts)).status, 'failed')
})

test('网络失败最多四次请求，指数退避为 1、2、4 秒；429 不重试', async () => {
  setup()
  const actualSetTimeout = globalThis.setTimeout
  const delays = []
  globalThis.setTimeout = (fn, ms) => {
    delays.push(ms)
    return actualSetTimeout(fn, ms === 5000 ? 5000 : 0)
  }
  try {
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      throw new Error('network')
    }
    assert.deepEqual(await sdk.init(opts), { status: 'failed', errorCode: 'TEMPORARY_FAILURE' })
    assert.equal(calls, 4)
    assert.deepEqual(
      delays.filter((ms) => ms !== 5000),
      [1000, 2000, 4000],
    )
    assert.equal(delays.filter((ms) => ms === 5000).length, 4)
    calls = 0
    globalThis.fetch = async () => {
      calls++
      return envelope({ errorCode: 'RATE_LIMITED' }, 429)
    }
    assert.deepEqual(await sdk.init(opts), { status: 'failed', errorCode: 'RATE_LIMITED' })
    assert.equal(calls, 1)
  } finally {
    globalThis.setTimeout = actualSetTimeout
  }
})

test('签发响应正文读取中断会重试，JSON 解析错误不重试', async () => {
  setup()
  const timer = globalThis.setTimeout
  let attempts = 0
  let invalid = false
  globalThis.setTimeout = (fn, ms) => timer(fn, ms === 5000 ? 5000 : 0)
  globalThis.fetch = async (url) => {
    if (url.endsWith('/admission')) return envelope({ allowed: true })
    attempts++
    if (invalid) return { status: 200, text: async () => '{invalid' }
    if (attempts === 1)
      return {
        status: 200,
        text: async () => {
          throw new TypeError('connection lost')
        },
      }
    return envelope({ cid })
  }
  try {
    assert.equal((await sdk.init(opts)).status, 'allowed')
    assert.equal(attempts, 2)
    setup()
    attempts = 0
    invalid = true
    assert.equal((await sdk.init(opts)).status, 'failed')
    assert.equal(attempts, 1)
  } finally {
    globalThis.setTimeout = timer
    sdk.stop()
    globalThis.fetch = nativeFetch
  }
})

test('单次请求 5 秒超时后继续重试，迟到响应不能被采用', async () => {
  setup()
  const actualSetTimeout = globalThis.setTimeout
  const delays = []
  globalThis.setTimeout = (fn, ms) => {
    delays.push(ms)
    return actualSetTimeout(fn, 0)
  }
  try {
    let calls = 0
    globalThis.fetch = async (url) => {
      calls++
      if (calls === 1) return new Promise(() => {})
      return url.endsWith('/cids') ? envelope({ cid }) : envelope({ allowed: true })
    }
    assert.deepEqual(await sdk.init(opts), { status: 'allowed' })
    assert.equal(calls, 3)
    assert.deepEqual(delays.slice(0, 2), [5000, 1000])
  } finally {
    globalThis.setTimeout = actualSetTimeout
    sdk.stop()
  }
})

test('真实本地 HTTP 接收器完成签发和上报策略请求', async () => {
  const entries = setup()
  globalThis.fetch = nativeFetch
  const calls = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    calls.push({ path: request.url, body: JSON.parse(raw), method: request.method })
    const data = request.url.endsWith('/cids') ? { cid } : { allowed: true }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ code: 200, message: '成功', data, timestamp: new Date().toISOString() }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    assert.deepEqual(await sdk.init({ ...opts, serverUrl: `http://127.0.0.1:${port}/prefix` }), { status: 'allowed' })
    assert.deepEqual(
      calls.map((call) => call.path),
      ['/prefix/v1/cids', '/prefix/v1/admission'],
    )
    assert.ok(calls.every((call) => call.method === 'POST'))
    assert.deepEqual(calls[1].body, { appId: opts.appId, cid })
    assert.equal(entries.size, 1)
  } finally {
    sdk.stop()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
