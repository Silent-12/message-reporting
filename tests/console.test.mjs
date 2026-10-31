import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as sdk from '../dist/index.js'
import { decrypt, installHost, opts, uninstallHost } from './support/host.mjs'

const nativeFetch = globalThis.fetch

function setup(allowed = true) {
  sdk.stop()
  const state = installHost({ allowed })
  const calls = []
  state.win.console = Object.fromEntries(
    ['log', 'debug', 'info', 'warn', 'error'].map((level) => [
      level,
      function (...args) {
        calls.push({ level, args })
      },
    ]),
  )
  return { state, calls, originals: { ...state.win.console } }
}

async function settle(state, count) {
  for (let i = 0; i < 200 && state.events().length < count; i++) await new Promise((resolve) => setTimeout(resolve, 5))
}

function cleanup() {
  sdk.stop()
  uninstallHost()
  globalThis.fetch = nativeFetch
}

test('默认关闭控制台；服务端开启后按级别采集且保留宿主输出', async () => {
  const { state, calls, originals } = setup()
  try {
    assert.equal((await sdk.init(opts)).status, 'allowed')
    assert.equal(state.win.console.warn, originals.warn)
    state.config.console = { enabled: true, levels: ['warn', 'error'], fields: ['name', 'pagePath'] }
    assert.equal((await sdk.init(opts)).status, 'allowed')
    state.win.console.info('ignored')
    state.win.console.warn('warning')
    state.win.console.error('failure')
    await settle(state, 2)
    assert.deepEqual(
      calls.map((item) => item.level),
      ['info', 'warn', 'error'],
    )
    assert.deepEqual(
      state
        .events()
        .map(decrypt)
        .map(({ level, name, message, pagePath }) => ({ level, name, message, pagePath }))
        .sort((a, b) => a.level.localeCompare(b.level)),
      [
        { level: 'error', name: 'console.error', message: 'failure', pagePath: 'https://app.test/orders' },
        { level: 'warn', name: 'console.warn', message: 'warning', pagePath: 'https://app.test/orders' },
      ],
    )
    assert.equal(state.requests.filter((item) => item.url.endsWith('/config')).length, 2)
    sdk.stop()
    assert.equal(state.win.console.warn, originals.warn)
  } finally {
    cleanup()
  }
})

test('仅选择 log 时采集 console.log，保留原始输出并在停止后还原', async () => {
  const { state, calls, originals } = setup()
  try {
    state.config.console = { enabled: true, levels: ['info'], fields: ['name'] }
    assert.equal((await sdk.init(opts)).status, 'allowed')
    assert.equal(state.win.console.log, originals.log)
    state.win.console.log('ignored')
    state.config.console = { enabled: true, levels: ['log'], fields: ['name'] }
    assert.equal((await sdk.init(opts)).status, 'allowed')
    assert.equal(state.win.console.info, originals.info)
    state.win.console.info('ignored too')
    state.win.console.log('message', { count: 1 })
    await settle(state, 1)
    assert.deepEqual(
      calls.map((item) => item.level),
      ['log', 'info', 'log'],
    )
    assert.deepEqual(calls.at(-1).args, ['message', { count: 1 }])
    assert.deepEqual(
      state
        .events()
        .map(decrypt)
        .map(({ kind, level, name, message }) => ({ kind, level, name, message })),
      [{ kind: 'other', level: 'log', name: 'console.log', message: 'message {"count":1}' }],
    )
    sdk.stop()
    assert.equal(state.win.console.log, originals.log)
  } finally {
    cleanup()
  }
})

test('远程配置逐项控制级别与字段，重复初始化先卸载旧包装', async () => {
  const { state, originals } = setup()
  try {
    state.config.console = { enabled: true, levels: ['warn'], fields: [] }
    state.config.environmentFields = []
    assert.equal((await sdk.init(opts)).status, 'allowed')
    state.win.console.warn('basic', new Error('example'))
    await settle(state, 1)
    const basic = decrypt(state.events()[0])
    assert.equal(basic.message.startsWith('basic'), true)
    for (const field of ['name', 'stack', 'pagePath', 'environment']) assert.equal(field in basic, false)
    state.config.console = { enabled: true, levels: ['info'], fields: ['stack'] }
    assert.equal((await sdk.init(opts)).status, 'allowed')
    assert.equal(state.win.console.warn, originals.warn)
    state.win.console.info(new Error('detail'))
    await settle(state, 2)
    const detail = decrypt(state.events()[1])
    assert.equal(detail.level, 'info')
    assert.equal(typeof detail.stack, 'string')
    assert.equal('name' in detail, false)
    state.config.console.enabled = false
    assert.equal((await sdk.init(opts)).status, 'allowed')
    assert.equal(state.win.console.info, originals.info)
  } finally {
    cleanup()
  }
})

test('未准入不包装；服务端指定的方法不可写时清理全部采集', async () => {
  const { state, originals } = setup(false)
  try {
    state.config.console = { enabled: true, levels: ['warn'], fields: [] }
    assert.equal((await sdk.init(opts)).status, 'denied')
    assert.equal(state.win.console.warn, originals.warn)
    state.allowed = true
    Object.defineProperty(state.win.console, 'warn', { value: originals.warn, writable: false })
    assert.equal((await sdk.init(opts)).status, 'unavailable')
    assert.equal(state.listeners.length, 0)
  } finally {
    cleanup()
  }
})

test('控制台参数快照不触发 getter，循环引用和属性数量使用占位文本', async () => {
  const { state } = setup()
  let getters = 0
  let contexts = 0
  const value = { safe: 1 }
  Object.defineProperty(value, 'secret', {
    enumerable: true,
    get() {
      getters++
      return 'hidden'
    },
  })
  const circular = { value: 1 }
  circular.self = circular
  const large = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`key${index}`, index]))
  try {
    state.config.console = { enabled: true, levels: ['warn'], fields: [] }
    assert.equal(
      (
        await sdk.init({
          ...opts,
          getContext: () => {
            contexts++
            return {}
          },
        })
      ).status,
      'allowed',
    )
    state.win.console.warn(value)
    await settle(state, 1)
    assert.equal(decrypt(state.events()[0]).message, '{"safe":1,"secret":"[accessor]"}')
    state.win.console.warn(circular)
    await settle(state, 2)
    assert.equal(decrypt(state.events()[1]).message, '{"value":1,"self":"[circular]"}')
    state.win.console.warn(large)
    await settle(state, 3)
    assert.equal(decrypt(state.events()[2]).message.includes('"…":"more properties"'), true)
    assert.equal(getters, 0)
    assert.equal(contexts, 0)
  } finally {
    cleanup()
  }
})

test('停止时不覆盖宿主随后安装的控制台包装', async () => {
  const { state } = setup()
  try {
    state.config.console = { enabled: true, levels: ['error'], fields: [] }
    assert.equal((await sdk.init(opts)).status, 'allowed')
    const sdkWrapper = state.win.console.error
    let hostCalls = 0
    const hostWrapper = (...args) => {
      hostCalls++
      sdkWrapper(...args)
    }
    state.win.console.error = hostWrapper
    sdk.stop()
    assert.equal(state.win.console.error, hostWrapper)
    state.win.console.error('after stop')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(hostCalls, 1)
    assert.equal(state.events().length, 0)
  } finally {
    cleanup()
  }
})
