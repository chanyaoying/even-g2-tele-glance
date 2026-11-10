import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  BACKEND_AUTH_REJECTED_MESSAGE,
  BACKEND_BUSY_MESSAGE,
  HttpTelegramApi,
  SESSION_EXPIRED_MESSAGE,
  isBackendAuthError,
  isSessionExpiredError,
  isUnrecoverableStreamError,
} from '../src/api'
import { encryptWithAad, RESPONSE_AAD_LABEL } from '../src/secureAuth'
import { formatDayLabel, localizeStatus } from '../src/controller/model'
import { localeFromCode, setLocale } from '../src/locales'
import en from '../src/locales/en'

vi.mock('../src/secureAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/secureAuth')>()),
  encryptedTelegramAuthHeader: async () => 'encrypted-auth',
}))

function makeApi(config: Record<string, string> = { telegramApiId: '123', telegramApiHash: 'abc', backendSharedSecret: 'user-secret' }) {
  return new HttpTelegramApi('http://localhost:8787', () => config)
}

const encoder = new TextEncoder()
function streamOf(chunks: string[]) {
  let index = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]))
      else controller.close()
    },
  }), { status: 200 })
}

describe('backend error signals', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    setLocale(en)
  })

  it('classifies a 401 by X-TeleGlance-Error before the detail text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Encrypted auth whatever' }), {
      status: 401, headers: { 'X-TeleGlance-Error': 'session_expired' },
    })))
    const expired = await makeApi().listChats(5).catch((e) => e)
    expect(isSessionExpiredError(expired)).toBe(true)
    expect(expired.message).toBe(SESSION_EXPIRED_MESSAGE)

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Telegram session has expired.' }), {
      status: 401, headers: { 'X-TeleGlance-Error': 'backend_auth' },
    })))
    const rejected = await makeApi().listChats(5).catch((e) => e)
    expect(isBackendAuthError(rejected)).toBe(true)
    expect(rejected.message).toBe(BACKEND_AUTH_REJECTED_MESSAGE)
  })

  it('treats an encrypted 401 that cannot be decrypted (wrong shared secret) as rejected auth, not a crypto error', async () => {
    const body = JSON.stringify({ encryptedPayload: await encryptWithAad('{"detail":"x"}', 'server-secret', RESPONSE_AAD_LABEL) })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 401, headers: { 'X-TeleGlance-Encrypted': '1' } })))
    const error = await makeApi().listChats(5).catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(isBackendAuthError(error)).toBe(true)
    expect(error.detail).toContain('shared secret')

    // With the header the backend's own classification wins even though the body is unreadable.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 401, headers: { 'X-TeleGlance-Encrypted': '1', 'X-TeleGlance-Error': 'session_expired' } })))
    expect(isSessionExpiredError(await makeApi().listChats(5).catch((e) => e))).toBe(true)
  })

  it('reads plain JSON early rejections (413) without trying to decrypt them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Request body is too large' }), { status: 413 })))
    const error = await makeApi().sendMessage(1, { text: 'hi' }).catch((e) => e)
    expect(error.status).toBe(413)
    expect(error.message).toBe(en.errorRequestTooLarge)
    expect(error.detail).toContain('Request body is too large')
  })

  it('maps 503 + Retry-After to the busy message and waits that long before the next request', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ detail: 'Could not reach Telegram. Please retry.' }), {
      status: 503, headers: { 'Retry-After': '5' },
    }))
    vi.stubGlobal('fetch', fetchStub)
    const api = makeApi()
    const first = await api.listChats(5).catch((e) => e)
    expect(first.message).toBe(BACKEND_BUSY_MESSAGE)
    expect(first.retryAfterSeconds).toBe(5)
    expect(first.detail).toContain('Could not reach Telegram')
    const second = await api.listChats(5).catch((e) => e)
    expect(second.message).toBe(BACKEND_BUSY_MESSAGE)
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('does not hold up other requests for a busy transcription server', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ detail: 'transcription is busy, please retry' }), {
      status: 503, headers: { 'Retry-After': '5' },
    }))
    vi.stubGlobal('fetch', fetchStub)
    const api = makeApi()
    await api.transcribe(new Blob(['x'])).catch(() => undefined)
    await api.listChats(5).catch(() => undefined)
    expect(fetchStub).toHaveBeenCalledTimes(2)
  })

  it('marks missing settings as unrecoverable by kind, whatever the language', async () => {
    setLocale(localeFromCode('de'))
    const error = await makeApi({ telegramApiId: '123', telegramApiHash: 'abc' }).listChats(5).catch((e) => e)
    expect(error.kind).toBe('notConfigured')
    expect(error.message).toBe(localeFromCode('de').errorSharedSecretMissing)
    expect(isUnrecoverableStreamError(error)).toBe(true)
    expect(isUnrecoverableStreamError(new Error('Backend shared secret is required'))).toBe(false)
  })

  it('treats an error event with code session_expired as a session expiry, and resync like a reconnect', async () => {
    vi.useFakeTimers()
    const onReconnect = vi.fn()
    const onError = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => streamOf([
      `event: resync\ndata: ${JSON.stringify({ type: 'resync' })}\n\n`,
      `event: error\ndata: ${JSON.stringify({ detail: 'Gone', code: 'session_expired' })}\n\n`,
    ])))
    makeApi().subscribeUpdates(() => undefined, onError, onReconnect)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onReconnect).toHaveBeenCalledTimes(1)
    expect(isSessionExpiredError(onError.mock.calls[0][0])).toBe(true)
  })
})

describe('localised status sentinels', () => {
  afterEach(() => setLocale(en))

  it('translates the short backend statuses and loading texts at render time', () => {
    setLocale(localeFromCode('de'))
    const de = localeFromCode('de')
    expect(localizeStatus('Offline')).toBe(de.statusOffline)
    expect(localizeStatus(BACKEND_AUTH_REJECTED_MESSAGE)).toBe(de.statusAuthRejected)
    expect(localizeStatus('No connection')).toBe(de.statusNoConnection)
    expect(localizeStatus('Loading Project topics...')).toBe(de.statusLoadingTopics.replace('{name}', 'Project'))
    expect(localizeStatus('Loading General...')).toBe(de.statusLoadingThread.replace('{name}', 'General'))
    expect(localizeStatus('Chat not found')).toBe('Chat not found')
  })

  it('builds day dividers from the locale (romanised for ja, so the Latin-only glasses font can draw them)', () => {
    const now = new Date(2026, 9, 28, 15, 0)
    const at = (y: number, mo: number, d: number) => new Date(y, mo, d, 12, 0).toISOString()
    setLocale(localeFromCode('ja'))
    const ja = localeFromCode('ja')
    expect(formatDayLabel(at(2026, 9, 28), now)).toBe(ja.dayToday)
    const label = formatDayLabel(at(2026, 9, 26), now)
    expect(label).toContain(ja.dateMonths.split(' ')[9])
    expect(label).toContain(ja.dateWeekdays.split(' ')[1])
    expect(label).toMatch(/^[\x20-\x7e\u00c0-\u017f]+$/)
  })
})
