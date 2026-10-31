import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import vm from 'node:vm'
import * as sdk from '../dist/index.js'
import { cid, decrypt, defaultConfig, envelope, installHost } from './support/host.mjs'

const otherCid = Buffer.alloc(32, 43).toString('base64url')
const opts = { serverUrl: 'https://example.test/prefix/', appId: 'project1' }
const nativeFetch = globalThis.fetch

/**
 * 安装宿主环境并重置 SDK 状态
 * @returns 模拟存储内容
 */
function setup() {
  sdk.stop()
  return installHost().entries
}

test('ESM、CJS 和 IIFE 公开初始化、停止与 CID 读取能力', async () => {
  const cjs = createRequire(import.meta.url)('../dist/index.cjs')
  const sandbox = {}
  vm.runInNewContext(await readFile(new URL('../dist/index.global.js', import.meta.url), 'utf8'), sandbox)
  for (const exported of [sdk, cjs, sandbox.MessageReportingSDK]) {
    assert.equal(typeof exported.init, 'function')
    assert.equal(typeof exported.stop, 'function')
    assert.equal(typeof exported.getCid, 'function')
    assert.equal(typeof exported.default.getCid, 'function')
    assert.equal(exported.report, undefined)
    assert.equal(exported.reportImmediate, undefined)
  }
})

test('读取指定目标的本地 CID，支持拒绝准入和停止后排查', async () => {
  setup()
  assert.equal(sdk.getCid(opts), null)
  globalThis.fetch = async (url) => (url.endsWith('/cids') ? envelope({ cid }) : envelope({ allowed: false }))
  assert.deepEqual(await sdk.init(opts), { status: 'denied' })
  assert.equal(sdk.getCid({ ...opts, serverUrl: 'https://EXAMPLE.test:443/prefix' }), cid)
  assert.equal(sdk.getCid({ ...opts, appId: 'other1' }), null)
  assert.equal(sdk.getCid({ ...opts, serverUrl: 'https://example.test/other' }), null)
  sdk.stop()
  assert.equal(sdk.getCid(opts), cid)
  globalThis.localStorage.setItem('__message_reporting_cid__:https%3A%2F%2Fexample.test%2Fprefix:project1', 'invalid')
  assert.equal(sdk.getCid(opts), null)
  assert.equal(sdk.getCid({ ...opts, serverUrl: 'invalid' }), null)
  globalThis.localStorage.getItem = () => {
    throw new Error('storage unavailable')
  }
  assert.equal(sdk.getCid(opts), null)
})

test('签发并持久化 CID 后查询上报策略，停止后复用并保留路径前缀', async () => {
  const entries = setup()
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    return url.endsWith('/cids') ? envelope({ cid }) : url.endsWith('/config') ? envelope(defaultConfig()) : envelope({ allowed: true })
  }
  assert.deepEqual(await sdk.init(opts), { status: 'allowed' })
  assert.equal(entries.size, 1)
  assert.equal(requests[0].url, 'https://example.test/prefix/v1/cids')
  assert.equal(requests[1].url, 'https://example.test/prefix/v1/admission')
  assert.equal(requests[0].options.credentials, 'omit')
  assert.equal(requests[0].options.referrerPolicy, 'no-referrer')
  sdk.stop()
  assert.deepEqual(await sdk.init({ ...opts, serverUrl: 'https://EXAMPLE.test:443/prefix' }), { status: 'allowed' })
  assert.equal(requests.length, 5)
})

test('允许任意主机的 HTTP 服务地址', async () => {
  setup()
  const requests = []
  globalThis.fetch = async (url) => {
    requests.push(url)
    return url.endsWith('/cids') ? envelope({ cid }) : url.endsWith('/config') ? envelope(defaultConfig()) : envelope({ allowed: true })
  }
  assert.deepEqual(await sdk.init({ ...opts, serverUrl: 'http://collector.example/prefix' }), { status: 'allowed' })
  assert.deepEqual(requests, [
    'http://collector.example/prefix/v1/cids',
    'http://collector.example/prefix/v1/admission',
    'http://collector.example/prefix/v1/config',
  ])
  sdk.stop()
})

test('所有采集来源关闭返回 disabled；配置失效时停止原有监听', async () => {
  setup()
  const state = installHost()
  state.config.browserKinds = []
  assert.deepEqual(await sdk.init(opts), { status: 'disabled' })
  assert.equal(state.listeners.length, 0)
  state.config.browserKinds = ['javascript']
  assert.deepEqual(await sdk.init(opts), { status: 'allowed' })
  assert.equal(state.listeners.length, 2)
  state.config.eventUrl = 'javascript:alert(1)'
  assert.deepEqual(await sdk.init(opts), { status: 'failed' })
  assert.equal(state.listeners.length, 0)
})

test('远程配置筛选浏览器类型与环境字段，并指定独立事件地址', async () => {
  setup()
  const state = installHost()
  state.config.eventUrl = 'https://collector.example/ingest?app=1'
  state.config.browserKinds = ['javascript']
  state.config.environmentFields = ['online']
  state.config.contextEnabled = false
  let excludedReads = 0
  for (const field of ['userAgent', 'connection'])
    Object.defineProperty(state.navigator, field, {
      get() {
        excludedReads++
        return field === 'userAgent' ? 'private-agent' : { effectiveType: '4g' }
      },
    })
  let called = 0
  assert.deepEqual(
    await sdk.init({
      ...opts,
      getContext: () => {
        called++
        return { secret: true }
      },
    }),
    { status: 'allowed' },
  )
  state.dispatch('unhandledrejection', { reason: 'ignored' })
  state.dispatch('error', { target: state.win, message: 'boom' })
  for (let i = 0; i < 200 && !state.requests.some((item) => item.url === state.config.eventUrl); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  const sent = state.requests.filter((item) => item.url === state.config.eventUrl)
  assert.equal(sent.length, 1)
  const plain = decrypt(sent[0])
  assert.equal(plain.kind, 'javascript')
  assert.deepEqual(plain.environment, { online: true })
  assert.equal(excludedReads, 0)
  assert.equal('context' in plain, false)
  assert.equal(called, 0)
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
      : Promise.resolve(url.endsWith('/config') ? envelope(defaultConfig()) : envelope({ allowed: true }))
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
    return url.endsWith('/cids') ? envelope({ cid }) : url.endsWith('/config') ? envelope(defaultConfig()) : envelope({ allowed: true })
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
  // 每次 setup 都会重新安装宿主 fetch，因此重装后需要重新绑定本用例的响应。
  const respond = async (url) => {
    if (url.endsWith('/admission')) return envelope({ allowed: true })
    if (url.endsWith('/config')) return envelope(defaultConfig())
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
  globalThis.fetch = respond
  try {
    assert.equal((await sdk.init(opts)).status, 'allowed')
    assert.equal(attempts, 2)
    setup()
    globalThis.fetch = respond
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
      return url.endsWith('/cids') ? envelope({ cid }) : url.endsWith('/config') ? envelope(defaultConfig()) : envelope({ allowed: true })
    }
    assert.deepEqual(await sdk.init(opts), { status: 'allowed' })
    assert.equal(calls, 4)
    assert.deepEqual(delays.slice(0, 2), [5000, 1000])
  } finally {
    globalThis.setTimeout = actualSetTimeout
    sdk.stop()
  }
})

test('真实本地 HTTP 接收器完成初始化、配置下发和目标地址上报', async () => {
  sdk.stop()
  const state = installHost()
  globalThis.fetch = nativeFetch
  const calls = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    calls.push({ path: request.url, body: JSON.parse(raw), method: request.method })
    const data = request.url.endsWith('/cids')
      ? { cid }
      : request.url.endsWith('/config')
        ? { ...defaultConfig(), eventUrl: `http://${request.headers.host}/ingest` }
        : request.url.endsWith('/admission')
          ? { allowed: true }
          : null
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ code: 200, message: '成功', data, timestamp: new Date().toISOString() }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    assert.deepEqual(await sdk.init({ ...opts, serverUrl: `http://127.0.0.1:${port}/prefix` }), { status: 'allowed' })
    assert.deepEqual(
      calls.map((call) => call.path),
      ['/prefix/v1/cids', '/prefix/v1/admission', '/prefix/v1/config'],
    )
    assert.ok(calls.every((call) => call.method === 'POST'))
    assert.deepEqual(calls[1].body, { appId: opts.appId, cid })
    assert.equal(state.entries.size, 1)
    state.dispatch('error', { target: state.win, message: 'local receiver test' })
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('本地接收端未收到事件')), 2000)
      const poll = () => {
        if (calls.some((call) => call.path === '/ingest')) {
          clearTimeout(timeout)
          resolve()
        } else setTimeout(poll, 10)
      }
      poll()
    })
    const received = calls.find((call) => call.path === '/ingest')
    assert.equal(decrypt(received.body).message, 'local receiver test')
  } finally {
    sdk.stop()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
