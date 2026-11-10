import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKEND_NOT_CONFIGURED_MESSAGE, HttpTelegramApi, defaultApiBaseUrl, effectiveBackendSharedSecret } from '../src/api'
import { InstrumentedTelegramApi } from '../src/instrumentedApi'
import { AUTH_AAD_LABEL, REQUEST_AAD_LABEL, decryptJsonPayload, decryptWithAad } from '../src/secureAuth'
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

  it('has no default backend URL, so an unconfigured app asks for setup', () => {
    expect(defaultApiBaseUrl()).toBe('')
  })

  it('never sends a request (or credentials) when no backend URL is set', async () => {
    stubFetch()
    const api = new HttpTelegramApi('', () => ({ telegramApiId: '123', telegramApiHash: 'abc', backendSharedSecret: 'user-secret' }))
    await expect(api.authStatus()).rejects.toThrow(BACKEND_NOT_CONFIGURED_MESSAGE)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('uses the configured secret for every backend URL (no built-in substitution)', () => {
    expect(effectiveBackendSharedSecret({ backendSharedSecret: ' mine ' }, 'https://any.example')).toBe('mine')
    expect(effectiveBackendSharedSecret({}, 'https://any.example')).toBe('')
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

    // Decrypt with the user's secret under the auth-header AAD — must succeed
    const decrypted = await decryptWithAad(authHeader!, 'user-secret', AUTH_AAD_LABEL)
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

    // Decrypt under the configured secret and the request AAD — must succeed and reveal the phone number
    const decrypted = await decryptWithAad(body.encryptedPayload, 'user-secret', REQUEST_AAD_LABEL)
    const payload = JSON.parse(decrypted)
    expect(payload.phone).toBe('+1234567890')
    // A request body is never valid as a response or an auth header (distinct AADs).
    await expect(decryptJsonPayload(body.encryptedPayload, 'user-secret')).rejects.toThrow()
    await expect(decryptWithAad(body.encryptedPayload, 'user-secret', AUTH_AAD_LABEL)).rejects.toThrow()
    expect(capturedHeaders?.get('X-TeleGlance-Proto')).toBe('2')
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
    const decrypted = await decryptWithAad(body.encryptedPayload, 'user-secret', REQUEST_AAD_LABEL)
    const payload = JSON.parse(decrypted)
    expect(payload).toEqual({
      phone: '+1234567890',
      code: '12345',
      phoneCodeHash: 'telegram-hash',
    })
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
