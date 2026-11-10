import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  BACKEND_AUTH_REJECTED_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
  isBackendAuthError,
  isSessionExpiredError,
  BACKEND_TIMEOUT_MESSAGE,
  BACKEND_UNREACHABLE_MESSAGE,
  HttpTelegramApi,
  requestTimeoutMs,
} from '../src/api'

function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

function makeApi() {
  return new HttpTelegramApi('http://localhost:8787', () => ({
    telegramApiId: '123',
    telegramApiHash: 'abc',
    backendSharedSecret: 'user-secret',
  }))
}

describe('per-call request timeouts', () => {
  it('uses longer budgets for transcribe and send', () => {
    expect(requestTimeoutMs('/api/transcribe', 'POST')).toBe(60_000)
    expect(requestTimeoutMs('/api/chats/5/messages', 'POST')).toBe(20_000)
    expect(requestTimeoutMs('/api/chats/5/messages', 'GET')).toBe(15_000)
    expect(requestTimeoutMs('/api/chats')).toBe(15_000)
  })
})

describe('HttpTelegramApi errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('maps network failures to a short message with detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed') }))
    const error = await makeApi().listChats(5).catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.message).toBe(BACKEND_UNREACHABLE_MESSAGE)
    expect(error.message.length).toBeLessThan(20)
    expect(error.detail).toContain('Backend URL')
  })

  it('reports a short timeout message and keeps the long text in detail', async () => {
    vi.useFakeTimers()
    const called = deferred()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => {
      called.resolve()
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })))
    const pending = makeApi().listChats(5).catch((e) => e)
    await called.promise
    await vi.advanceTimersByTimeAsync(15_001)
    const error = await pending
    expect(error.message).toBe(BACKEND_TIMEOUT_MESSAGE)
    expect(error.detail).toContain('15s')
  })

  it('does not time out a transcription at 15 s', async () => {
    vi.useFakeTimers()
    const called = deferred()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((resolve, reject) => {
      called.resolve()
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      setTimeout(() => resolve(new Response(JSON.stringify({ text: 'hi' }), { status: 200 })), 40_000)
    })))
    const pending = makeApi().transcribe(new Blob(['x']))
    await called.promise
    await vi.advanceTimersByTimeAsync(40_001)
    await expect(pending).resolves.toMatchObject({ text: 'hi' })
  })

  it('surfaces a flood wait from Retry-After', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'FloodWaitError' }), {
      status: 429,
      headers: { 'Retry-After': '42' },
    })))
    const error = await makeApi().listChats(5).catch((e) => e)
    expect(error.message).toBe('Telegram asks you to wait 42 s')
    expect(error.retryAfterSeconds).toBe(42)
    expect(error.status).toBe(429)
  })

  it('falls back to the wait time in the detail text, then to a generic busy message', async () => {
    const respond = (detail: string) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail }), { status: 429 })))
    respond('A wait of 17 seconds is required')
    expect((await makeApi().listChats(5).catch((e) => e)).message).toBe('Telegram asks you to wait 17 s')
    respond('slow down')
    expect((await makeApi().listChats(5).catch((e) => e)).message).toBe('Telegram busy')
  })

  it('keeps ordinary backend detail as the message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Chat not found' }), { status: 404 })))
    const error = await makeApi().listChats(5).catch((e) => e)
    expect(error.message).toBe('Chat not found')
  })

  it('maps a 401 for an expired Telegram session to a session-expired error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Telegram session has expired. Reconnect in TeleGlance Settings.' }), { status: 401 })))
    const error = await makeApi().listChats(5).catch((e) => e)
    expect(isSessionExpiredError(error)).toBe(true)
    expect(isBackendAuthError(error)).toBe(false)
    expect(error.status).toBe(401)
    expect(error.message).toBe(SESSION_EXPIRED_MESSAGE)
    expect(error.detail).toContain('session has expired')
  })

  it.each([
    'Encrypted auth could not be decrypted',
    'Encrypted auth timestamp expired',
    'Encrypted auth nonce was already used',
    'Malformed encrypted auth header',
  ])('maps a 401 for an unreadable auth header (%s) to a backend-auth error, not a sign-out', async (detail) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail }), { status: 401 })))
    const error = await makeApi().authStatus().catch((e) => e)
    expect(isBackendAuthError(error)).toBe(true)
    expect(isSessionExpiredError(error)).toBe(false)
    expect(error.message).toBe(BACKEND_AUTH_REJECTED_MESSAGE)
    expect(error.detail).toContain('shared secret')
    expect(error.detail).toContain(detail)
  })

  it('treats a 403 as a rejected auth too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Forbidden', { status: 403 })))
    expect(isBackendAuthError(await makeApi().listFolders().catch((e) => e))).toBe(true)
  })

  it('sends the protocol header on every backend request, including the health check and transcription', async () => {
    const seen: Array<string | null> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('X-TeleGlance-Proto'))
      return new Response(JSON.stringify({ authorized: true, text: '' }), { status: 200 })
    }))
    const api = makeApi()
    await api.testConnection()
    await api.transcribe(new Blob(['x']))
    expect(seen.length).toBe(3) // /health, /api/session/status, /api/transcribe
    expect(seen.every((value) => value === '2')).toBe(true)
  })
})
