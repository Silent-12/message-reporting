import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

// 仅验证目标 01 的公开向量；不导入 SDK，不代表生产采集、协议校验或接口已经实现。
const fixture = JSON.parse(await readFile(new URL('./fixtures/protocol-v1.json', import.meta.url), 'utf8'))
const utf8 = new TextEncoder()
const subtle = webcrypto.subtle

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function decode(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url')
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const bytes = Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (character) => character.charCodeAt(0))
  if (encode(bytes) !== value || (length !== undefined && bytes.length !== length)) throw new Error('Non-canonical base64url or length')
  return bytes
}

async function derive(vector) {
  const ikm = await subtle.importKey('raw', decode(vector.cid, 32), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(
    await subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: utf8.encode('message-reporting/v1'),
        info: utf8.encode(`aes-256-gcm:${vector.appId}:${vector.eventId}`),
      },
      ikm,
      256,
    ),
  )
}

function aad(vector) {
  return JSON.stringify([1, vector.appId, vector.cid, vector.eventId, vector.sentAt])
}

async function importAes(vector) {
  return subtle.importKey('raw', await derive(vector), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

function parameters(vector) {
  return { name: 'AES-GCM', iv: decode(vector.iv, 12), additionalData: utf8.encode(aad(vector)), tagLength: 128 }
}

test('公开向量固定 v1 参数、UTF-8 明文和内外事件标识', () => {
  assert.equal(fixture.version, 1)
  assert.equal(fixture.salt, 'message-reporting/v1')
  assert.equal(fixture.tagLengthBits, 128)
  assert.equal(fixture.vectors.length, 2)
  for (const vector of fixture.vectors) {
    assert.match(vector.appId, /^(?=.*[a-z])(?=.*[0-9])[a-z0-9]{2,64}$/)
    assert.equal(decode(vector.cid, 32).length, 32)
    assert.equal(decode(vector.eventId, 16).length, 16)
    assert.equal(decode(vector.iv, 12).length, 12)
    assert.equal(vector.info, `aes-256-gcm:${vector.appId}:${vector.eventId}`)
    assert.equal(aad(vector), vector.aadUtf8)
    const event = JSON.parse(vector.plaintextJson)
    assert.equal(event.appId, vector.appId)
    assert.equal(event.eventId, vector.eventId)
    assert.match(event.message, /测试异常.*💥/u)
    assert.equal('release' in event, false)
    assert.ok(utf8.encode(vector.plaintextJson).length > vector.plaintextJson.length)
  }
})

for (const vector of fixture.vectors) {
  test(`Web Crypto ${vector.name}：HKDF 和密文/末尾标签匹配固定结果`, async () => {
    const keyBytes = await derive(vector)
    assert.equal(Array.from(keyBytes, (byte) => byte.toString(16).padStart(2, '0')).join(''), vector.keyHex)
    const ciphertext = new Uint8Array(await subtle.encrypt(parameters(vector), await importAes(vector), utf8.encode(vector.plaintextJson)))
    assert.equal(encode(ciphertext), vector.ciphertext)
    assert.equal(ciphertext.length, utf8.encode(vector.plaintextJson).length + 16)
  })

  test(`Web Crypto ${vector.name}：解密独立 Node crypto 固定密文`, async () => {
    const plaintext = await subtle.decrypt(parameters(vector), await importAes(vector), decode(vector.ciphertext))
    assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(plaintext), vector.plaintextJson)
  })
}

test('相同 CID 和 IV 下按事件隔离子密钥，appId 和 CID 也参与派生', async () => {
  const [first, second] = fixture.vectors
  assert.equal(first.cid, second.cid)
  assert.equal(first.iv, second.iv)
  assert.notEqual(first.eventId, second.eventId)
  assert.notDeepEqual(await derive(first), await derive(second))
  assert.notDeepEqual(await derive(first), await derive({ ...first, appId: 'anotherapp1' }))
  const otherCid = decode(first.cid, 32)
  otherCid[0] ^= 1
  assert.notDeepEqual(await derive(first), await derive({ ...first, cid: encode(otherCid) }))
})

test('向量读取拒绝非规范 base64url、填充、非法字符和错误字节长度', () => {
  const { cid, eventId, iv } = fixture.vectors[0]
  for (const value of ['', null, 123, `${cid}=`, 'AA+/', 'AA A', 'A', 'A'.repeat(42) + 'B']) {
    assert.throws(() => decode(value, 32))
  }
  assert.throws(() => decode(eventId, 32))
  assert.throws(() => decode(cid, 16))
  assert.throws(() => decode(iv, 16))
  assert.throws(() => decode('A'.repeat(21) + 'B', 16))
})

test('Web Crypto 拒绝错误密钥、AAD、IV、密文、认证标签和截断标签', async () => {
  const vector = fixture.vectors[0]
  const key = await importAes(vector)
  const ciphertext = decode(vector.ciphertext)
  const altered = (offset) => {
    const bytes = ciphertext.slice()
    bytes[offset] ^= 1
    return bytes
  }
  await assert.rejects(subtle.decrypt(parameters(vector), await importAes(fixture.vectors[1]), ciphertext))
  await assert.rejects(subtle.decrypt(parameters({ ...vector, sentAt: vector.sentAt + 1 }), key, ciphertext))
  const wrongIv = decode(vector.iv, 12)
  wrongIv[0] ^= 1
  await assert.rejects(subtle.decrypt({ ...parameters(vector), iv: wrongIv }, key, ciphertext))
  await assert.rejects(subtle.decrypt(parameters(vector), key, altered(0)))
  await assert.rejects(subtle.decrypt(parameters(vector), key, altered(ciphertext.length - 1)))
  await assert.rejects(subtle.decrypt(parameters(vector), key, ciphertext.slice(0, -1)))
})
