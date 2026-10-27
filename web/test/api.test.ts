import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpTelegramApi, SHARED_BACKEND_TEST_SECRET, SHARED_BACKEND_URL, defaultApiBaseUrl, isSharedBackendUrl } from '../src/api'
import { InstrumentedTelegramApi } from '../src/instrumentedApi'
import { decryptJsonPayload } from '../src/secureAuth'
import type { TelegramApi } from '../src/api'

describe('HttpTelegramApi secret selection', () => {
  let capturedHeaders: Headers | undefined
  let capturedBody: string | undefined

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetch() {
    capturedHeaders = undefined
    capturedBody = undefined
    const fetchStub = vi.fn(async (_url: string, init?: RequestInit & { body?: string }) => {
      capturedHeaders = init?.headers as Headers | undefined
      capturedBody = init?.body as string | undefined
      return new Response(JSON.stringify({ session: 'no_session' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchStub)
  }

  it('defaults to the shared testing backend URL', () => {
    expect(defaultApiBaseUrl()).toBe(SHARED_BACKEND_URL)
  })

  it('uses the test secret for the shared backend even when the user overrides the secret', async () => {
    stubFetch()
    const api = new HttpTelegramApi(
      SHARED_BACKEND_URL,
      () => ({
        telegramApiId: '123',
        telegramApiHash: 'abc',
        backendSharedSecret: 'user-typo-secret',
      }),
    )

    await api.authStatus()

    const authHeader = capturedHeaders?.get('X-TeleGlance-Auth')
    expect(authHeader).toBeTruthy()

    const decrypted = await decryptJsonPayload(authHeader!, SHARED_BACKEND_TEST_SECRET)
    const payload = JSON.parse(decrypted)
    expect(payload.apiId).toBe('123')
    expect(payload.apiHash).toBe('abc')

    await expect(decryptJsonPayload(authHeader!, 'user-typo-secret')).rejects.toThrow()
  })

  it('uses the user secret for a custom backend when set', async () => {
    stubFetch()
    const api = new HttpTelegramApi(
      'http://localhost:8787',
      () => ({
        telegramApiId: '123',
        telegramApiHash: 'abc',
        backendSharedSecret: 'user-secret',
      }),
    )

    await api.authStatus()

    const authHeader = capturedHeaders?.get('X-TeleGlance-Auth')
    expect(authHeader).toBeTruthy()

    // Decrypt with the user's secret — must succeed
    const decrypted = await decryptJsonPayload(authHeader!, 'user-secret')
    const payload = JSON.parse(decrypted)
    expect(payload.apiId).toBe('123')
    expect(payload.apiHash).toBe('abc')
  })

  it('request bodies are encrypted with the configured backend secret', async () => {
    stubFetch()
    const api = new HttpTelegramApi(
      'http://localhost:8787',
      () => ({
        telegramApiId: '123',
        telegramApiHash: 'abc',
        backendSharedSecret: 'user-secret',
      }),
    )

    await api.startPhoneAuth('+1234567890')

    // Body must be JSON with encryptedPayload
    expect(capturedBody).toBeTruthy()
    const body = JSON.parse(capturedBody!)
    expect(body).toEqual({ encryptedPayload: expect.any(String) })
    expect(body.encryptedPayload).toMatch(/^v1\./)

    // Decrypt under the configured secret — must succeed and reveal the phone number
    const decrypted = await decryptJsonPayload(body.encryptedPayload, 'user-secret')
    const payload = JSON.parse(decrypted)
    expect(payload.phone).toBe('+1234567890')
  })

  it('sends Telegram phone code hash in the encrypted verify body', async () => {
    stubFetch()
    const api = new HttpTelegramApi(
      'http://localhost:8787',
      () => ({
        telegramApiId: '123',
        telegramApiHash: 'abc',
        backendSharedSecret: 'user-secret',
      }),
    )

    await api.verifyPhoneAuth('+1234567890', '12345', 'telegram-hash')

    expect(capturedBody).toBeTruthy()
    const body = JSON.parse(capturedBody!)
    const decrypted = await decryptJsonPayload(body.encryptedPayload, 'user-secret')
    const payload = JSON.parse(decrypted)
    expect(payload).toEqual({
      phone: '+1234567890',
      code: '12345',
      phoneCodeHash: 'telegram-hash',
    })
  })

  it('request bodies are encrypted with the effective secret for the shared backend', async () => {
    stubFetch()
    const api = new HttpTelegramApi(
      SHARED_BACKEND_URL,
      () => ({
        telegramApiId: '123',
        telegramApiHash: 'abc',
        backendSharedSecret: 'user-typo-secret',
      }),
    )

    await api.startPhoneAuth('+1234567890')

    expect(capturedBody).toBeTruthy()
    const body = JSON.parse(capturedBody!)
    expect(body).toEqual({ encryptedPayload: expect.any(String) })
    expect(body.encryptedPayload).toMatch(/^v1\./)

    const decrypted = await decryptJsonPayload(body.encryptedPayload, SHARED_BACKEND_TEST_SECRET)
    const payload = JSON.parse(decrypted)
    expect(payload.phone).toBe('+1234567890')

    await expect(decryptJsonPayload(body.encryptedPayload, 'user-typo-secret')).rejects.toThrow()
  })

  it('forwards transcription language through the instrumented API wrapper', async () => {
    let seenLanguage: string | undefined
    const inner = {
      async transcribe(_wav: Blob, language?: string) {
        seenLanguage = language
        return { text: 'hola', language: language ?? 'auto' }
      },
    } as unknown as TelegramApi
    const api = new InstrumentedTelegramApi(inner)

    const result = await api.transcribe(new Blob(['wav']), 'es')

    expect(seenLanguage).toBe('es')
    expect(result.language).toBe('es')
  })
})

describe('isSharedBackendUrl', () => {
  it('matches only the exact shared backend origin', () => {
    expect(isSharedBackendUrl(SHARED_BACKEND_URL)).toBe(true)
    expect(isSharedBackendUrl(`${SHARED_BACKEND_URL}/`)).toBe(true)
    expect(isSharedBackendUrl(`  ${SHARED_BACKEND_URL}/api  `)).toBe(true)
  })

  it('rejects look-alike hosts and non-https schemes', () => {
    expect(isSharedBackendUrl(`${SHARED_BACKEND_URL}.evil.example`)).toBe(false)
    expect(isSharedBackendUrl('https://teleglance.akira-os.net@evil.example')).toBe(false)
    expect(isSharedBackendUrl('http://teleglance.akira-os.net')).toBe(false)
    expect(isSharedBackendUrl('not a url')).toBe(false)
    expect(isSharedBackendUrl(undefined)).toBe(false)
  })
})
