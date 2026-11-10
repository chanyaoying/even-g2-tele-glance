import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTH_AAD_LABEL,
  REQUEST_AAD_LABEL,
  RESPONSE_AAD_LABEL,
  clearDerivedKeyCache,
  decryptJsonPayload,
  decryptWithAad,
  encryptJsonPayload,
  encryptWithAad,
  encryptedTelegramAuthHeader,
  warmSharedSecretKey,
} from '../src/secureAuth'

describe('secureAuth', () => {
  beforeEach(() => clearDerivedKeyCache())
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('round-trips the auth header under the auth AAD with a fresh nonce each time', async () => {
    const config = { backendSharedSecret: 's3cret', telegramApiId: ' 123 ', telegramApiHash: 'abc', telegramSession: 'sess' }
    const first = await encryptedTelegramAuthHeader(config)
    const second = await encryptedTelegramAuthHeader(config)
    expect(first).toMatch(/^v1\.[\w-]+\.[\w-]+$/)
    expect(second).not.toBe(first)
    const payload = JSON.parse(await decryptWithAad(first!, 's3cret', AUTH_AAD_LABEL))
    expect(payload).toMatchObject({ apiId: '123', apiHash: 'abc', session: 'sess' })
    expect(Math.abs(payload.ts - Date.now() / 1000)).toBeLessThan(5)
  })

  it('returns no header without the shared secret or the Telegram API credentials', async () => {
    expect(await encryptedTelegramAuthHeader({ telegramApiId: '1', telegramApiHash: 'h' })).toBeNull()
    expect(await encryptedTelegramAuthHeader({ backendSharedSecret: 's', telegramApiHash: 'h' })).toBeNull()
  })

  it('uses a distinct AAD per purpose: request bodies, responses and auth headers never decrypt as each other', async () => {
    const request = await encryptJsonPayload('{"a":1}', 'k')
    expect(await decryptWithAad(request, 'k', REQUEST_AAD_LABEL)).toBe('{"a":1}')
    await expect(decryptJsonPayload(request, 'k')).rejects.toThrow()
    await expect(decryptWithAad(request, 'k', AUTH_AAD_LABEL)).rejects.toThrow()

    const response = await encryptWithAad('{"b":2}', 'k', RESPONSE_AAD_LABEL)
    expect(await decryptJsonPayload(response, 'k')).toBe('{"b":2}')

    const header = await encryptedTelegramAuthHeader({ backendSharedSecret: 'k', telegramApiId: '1', telegramApiHash: 'h' })
    await expect(decryptJsonPayload(header!, 'k')).rejects.toThrow()
  })

  it('fails to decrypt with the wrong secret and rejects malformed payloads', async () => {
    const response = await encryptWithAad('x', 'right', RESPONSE_AAD_LABEL)
    await expect(decryptJsonPayload(response, 'wrong')).rejects.toThrow()
    await expect(decryptJsonPayload('v2.a.b', 'right')).rejects.toThrow('malformed')
    await expect(decryptJsonPayload('nodots', 'right')).rejects.toThrow('malformed')
  })

  it('derives the key once per shared secret (PBKDF2 is slow on phones), also when warmed up first', async () => {
    const deriveKey = vi.spyOn(globalThis.crypto.subtle, 'deriveKey')
    warmSharedSecretKey(' warm ')
    await encryptJsonPayload('1', 'warm')
    await encryptJsonPayload('2', 'warm')
    await decryptJsonPayload(await encryptWithAad('3', 'warm', RESPONSE_AAD_LABEL), 'warm')
    expect(deriveKey).toHaveBeenCalledTimes(1)
    await encryptJsonPayload('4', 'other')
    expect(deriveKey).toHaveBeenCalledTimes(2)
  })

  it('does not keep a failed key derivation cached', async () => {
    const original = globalThis.crypto.subtle.importKey.bind(globalThis.crypto.subtle)
    const importKey = vi.spyOn(globalThis.crypto.subtle, 'importKey')
      .mockRejectedValueOnce(new Error('transient'))
      .mockImplementation(original as typeof globalThis.crypto.subtle.importKey)
    await expect(encryptJsonPayload('1', 'flaky')).rejects.toThrow('transient')
    const encrypted = await encryptJsonPayload('2', 'flaky')
    expect(await decryptWithAad(encrypted, 'flaky', REQUEST_AAD_LABEL)).toBe('2')
    expect(importKey).toHaveBeenCalledTimes(2)
  })
})
