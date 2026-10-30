import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as sdk from '../dist/index.js'
import { decrypt, installHost, opts, uninstallHost } from './support/host.mjs'

const nativeFetch = globalThis.fetch

/**
 * 安装宿主环境并重置 SDK 状态，用可记录调用的方法替换窗口 console
 * @param allowed 上报策略判定结果
 * @returns 宿主状态、宿主方法调用记录与替换前的 console 方法
 */
function setup(allowed = true) {
  sdk.stop()
  const state = installHost({ allowed })
  const calls = []
  state.win.console = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      function (...args) {
        calls.push({ level, args, receiver: this })
      },
    ]),
  )
  return { state, calls, originals: { ...state.win.console } }
}

/**
 * 等待已发送事件请求达到预期数量，用于异步加密与发送
 */
async function settle(state, count) {
  for (let i = 0; i < 200 && state.events().length < count; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  // 多等一轮，确保超出的请求或递归发送也能被观察到。
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function cleanup() {
  sdk.stop()
  uninstallHost()
  globalThis.fetch = nativeFetch
}

test('默认关闭；true 捕获四级且保留宿主控制台调用', async () => {
  const { state, calls, originals } = setup()
  try {
    assert.equal((await sdk.init(opts)).status, 'allowed')
    assert.equal(state.win.console.error, originals.error)
    state.win.console.error('before')
    await settle(state, 0)
    assert.equal(state.events().length, 0)
    assert.equal((await sdk.init({ ...opts, captureConsole: true })).status, 'allowed')
    for (const level of ['debug', 'info', 'warn', 'error']) state.win.console[level]('hello', level)
    await settle(state, 4)
    assert.deepEqual(
      calls.map(({ level }) => level),
      ['error', 'debug', 'info', 'warn', 'error'],
    )
    assert.ok(calls.every(({ receiver }) => receiver === state.win.console))
    assert.deepEqual(
      state
        .events()
        .map(decrypt)
        .map(({ kind, level, name, message, pagePath }) => ({ kind, level, name, message, pagePath }))
        .sort((a, b) => a.level.localeCompare(b.level)),
      ['debug', 'info', 'warn', 'error']
        .map((level) => ({
          kind: 'other',
          level,
          name: `console.${level}`,
          message: `hello ${level}`,
          pagePath: 'https://app.test/orders',
        }))
        .sort((a, b) => a.level.localeCompare(b.level)),
    )
    sdk.stop()
    for (const level of ['debug', 'info', 'warn', 'error']) assert.equal(state.win.console[level], originals[level])
    state.win.console.error('after')
    await settle(state, 4)
    assert.equal(state.events().length, 4)
  } finally {
    cleanup()
  }
})

test('级别自由组合，重复初始化切换或关闭，数组变更不影响配置', async () => {
  const { state, originals } = setup()
  try {
    const selected = ['debug', 'warn', 'error']
    assert.equal((await sdk.init({ ...opts, captureConsole: selected })).status, 'allowed')
    selected.splice(0)
    for (const level of ['debug', 'info', 'warn', 'error']) state.win.console[level](level)
    await settle(state, 3)
    assert.deepEqual(
      state
        .events()
        .map(decrypt)
        .map(({ level }) => level),
      ['debug', 'warn', 'error'],
    )
    assert.equal((await sdk.init({ ...opts, captureConsole: ['info'] })).status, 'allowed')
    assert.equal(state.win.console.debug, originals.debug)
    state.win.console.debug('ignored')
    state.win.console.info('included')
    await settle(state, 4)
    assert.equal(decrypt(state.events()[3]).message, 'included')
    assert.equal((await sdk.init({ ...opts, captureConsole: false })).status, 'allowed')
    assert.equal(state.win.console.info, originals.info)
    state.win.console.info('ignored again')
    await settle(state, 4)
    assert.equal(state.events().length, 4)
  } finally {
    cleanup()
  }
})

test('未准入不包装；无效级别拒绝；包装失败回滚且不宣称已启动', async () => {
  const { state, originals } = setup(false)
  try {
    assert.equal((await sdk.init({ ...opts, captureConsole: true })).status, 'denied')
    assert.equal(state.win.console.warn, originals.warn)
    assert.equal((await sdk.init({ ...opts, captureConsole: ['trace'] })).status, 'invalid_config')
    assert.equal((await sdk.init({ ...opts, captureConsole: 'warn' })).status, 'invalid_config')
    assert.equal((await sdk.init({ ...opts, captureConsole: new Array(1) })).status, 'invalid_config')
    state.allowed = true
    Object.defineProperty(state.win.console, 'warn', { value: originals.warn, writable: false })
    assert.equal((await sdk.init({ ...opts, captureConsole: ['debug', 'warn'] })).status, 'unavailable')
    assert.equal(state.win.console.debug, originals.debug)
    assert.equal(state.listeners.length, 0)
    assert.equal((await sdk.init({ ...opts, captureConsole: ['error'] })).status, 'allowed')
  } finally {
    cleanup()
  }
})

test('已允许后控制台级别无法生效时停止监控并返回不可用', async () => {
  const { state, originals } = setup()
  try {
    assert.equal((await sdk.init({ ...opts, captureConsole: ['error'] })).status, 'allowed')
    assert.notEqual(state.win.console.error, originals.error)
    // 宿主在初始化后把 debug 改为不可写，重复初始化请求的新级别无法生效。
    Object.defineProperty(state.win.console, 'debug', { value: originals.debug, writable: false })
    assert.equal((await sdk.init({ ...opts, captureConsole: ['debug'] })).status, 'unavailable')
    // unavailable 必须对应未在监控：监听器已移除，原有包装已还原。
    assert.equal(state.listeners.length, 0)
    assert.equal(state.win.console.error, originals.error)
    state.win.console.error('after')
    await settle(state, 0)
    assert.equal(state.events().length, 0)
    // 停止后可重新初始化并恢复上报。
    assert.equal((await sdk.init({ ...opts, captureConsole: ['warn'] })).status, 'allowed')
    state.win.console.warn('resumed')
    await settle(state, 1)
    assert.equal(decrypt(state.events()[0]).message, 'resumed')
  } finally {
    cleanup()
  }
})

test('对象快照有界且不触发 getter；控制台事件不调用上下文以避免递归', async () => {
  const { state } = setup()
  let getters = 0
  let contexts = 0
  const object = { value: 1 }
  object.self = object
  Object.defineProperty(object, 'secret', {
    enumerable: true,
    get() {
      getters++
      return 'hidden'
    },
  })
  try {
    assert.equal(
      (
        await sdk.init({
          ...opts,
          captureConsole: ['warn'],
          getContext: () => {
            contexts++
            state.win.console.warn('from context')
            return { route: '/orders' }
          },
        })
      ).status,
      'allowed',
    )
    state.win.console.warn('object', object)
    await settle(state, 1)
    const plain = decrypt(state.events()[0])
    assert.equal(plain.message, 'object {"value":1,"self":"[circular]","secret":"[accessor]"}')
    assert.equal(getters, 0)
    assert.equal(contexts, 0)
    assert.equal(state.events().length, 1)
  } finally {
    cleanup()
  }
})

test('停止时不覆盖宿主随后安装的控制台包装', async () => {
  const { state } = setup()
  try {
    assert.equal((await sdk.init({ ...opts, captureConsole: ['error'] })).status, 'allowed')
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
    await settle(state, 0)
    assert.equal(hostCalls, 1)
    assert.equal(state.events().length, 0)
  } finally {
    cleanup()
  }
})
