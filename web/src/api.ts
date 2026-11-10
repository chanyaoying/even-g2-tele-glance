import type {
  AuthStatus,
  Chat,
  Folder,
  Id,
  MarkReadRequest,
  Message,
  PhoneAuthStart,
  PhoneAuthStatus,
  Photo,
  SendMessageRequest,
  SendMessageResponse,
  Topic,
  TelegramUpdate,
  TelegramTypingUpdate,
  TranscriptionResult,
} from './types'
import { debugLog, errorText } from './debugLog'
import { decryptJsonPayload, encryptedTelegramAuthHeader, encryptJsonPayload, PROTOCOL_HEADER, PROTOCOL_VERSION } from './secureAuth'

export type ListChatsOptions = { offset?: number; folderId?: Id }

export interface TelegramApi {
  authStatus(): Promise<AuthStatus>
  startPhoneAuth(phone: string): Promise<PhoneAuthStart>
  verifyPhoneAuth(phone: string, code: string, phoneCodeHash?: string | null, password?: string): Promise<PhoneAuthStatus>
  logout(): Promise<void>
  listChats(limit?: number, options?: ListChatsOptions): Promise<Chat[]>
  listFolders(): Promise<Folder[]>
  listTopics(chatId: Id): Promise<Topic[]>
  listMessages(chatId: Id, options?: { topicId?: Id; beforeId?: Id; afterId?: Id; limit?: number }): Promise<Message[]>
  getPhoto(chatId: Id, messageId: Id): Promise<Photo>
  sendMessage(chatId: Id, request: SendMessageRequest): Promise<Message>
  markRead(chatId: Id, request: MarkReadRequest): Promise<void>
  transcribe(wav: Blob, language?: string): Promise<TranscriptionResult>
  /**
   * Keep the live update stream open. `onError` fires on every drop (the stream then retries, unless the error
   * cannot fix itself, such as a 401), `onReconnect` when it comes back after a drop, `onOpen` on every connect.
   */
  subscribeUpdates(onUpdate: (update: TelegramUpdate | TelegramTypingUpdate) => void, onError?: (error: Event | Error) => void, onReconnect?: () => void, onOpen?: () => void): () => void
  testConnection(): Promise<ConnectionTestResult>
}

export type ConnectionTestResult = {
  health: { ok: boolean; error?: string }
  session: { ok: boolean; authorized?: boolean; error?: string } | null
}

export type TelegramAuthConfig = {
  telegramApiId?: string
  telegramApiHash?: string
  telegramSession?: string
  backendSharedSecret?: string
  sttBaseUrl?: string
}

export const BACKEND_URL_PLACEHOLDER = 'http://<BACKEND_URL>:8787'

/**
 * The Backend URL saved on this phone, or '' when none is: there is no built-in default backend, so an empty
 * value leads to the "needs setup" flow instead of sending Telegram credentials anywhere.
 */
export function defaultApiBaseUrl() {
  return localApiBaseUrl() ?? ''
}

/** The backend shared secret from Settings (`_baseUrl` is unused and only kept for older callers). */
export function effectiveBackendSharedSecret(config: TelegramAuthConfig, _baseUrl?: string) {
  return config.backendSharedSecret?.trim() ?? ''
}

export const API_BASE_URL_STORAGE_KEY = 'teleGlance.apiBaseUrl'
export const G2_TELE_API_BASE_URL_STORAGE_KEY = 'g2Tele.apiBaseUrl'
export const LEGACY_API_BASE_URL_STORAGE_KEY = 'evenTelegram.apiBaseUrl'
export const BACKEND_BUSY_MESSAGE = 'Server busy'
const BACKOFF_AFTER_FAILURES = 3
const BACKOFF_BASE_MS = 2000
const BACKOFF_MAX_MS = 30_000
export const BACKEND_UNREACHABLE_MESSAGE = 'No connection'
export const BACKEND_TIMEOUT_MESSAGE = 'Server slow'
export const TELEGRAM_BUSY_MESSAGE = 'Telegram busy'
/** Status on the stored chat list while the backend cannot be reached at startup (the app keeps retrying). */
export const OFFLINE_STATUS = 'Offline'
const BACKEND_UNREACHABLE_DETAIL = 'Backend is not reachable. Fill Backend URL in Settings and make sure the backend server is running.'
export const BACKEND_NOT_CONFIGURED_MESSAGE = 'Backend URL is required. Set it in TeleGlance Settings.'
/** 401: the Telegram session is gone (logged out elsewhere, revoked). Short text for the glasses. */
export const SESSION_EXPIRED_MESSAGE = 'Signed out'
/** 401/403: the backend could not read the encrypted auth header (shared secret mismatch or phone clock off). */
export const BACKEND_AUTH_REJECTED_MESSAGE = 'Backend rejected auth'
const BACKEND_AUTH_REJECTED_DETAIL = 'The backend could not verify this phone. Check that Backend shared secret in Settings is exactly TELEGLANCE_SHARED_SECRET on the server, and that the phone clock is set automatically.'
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const SEND_REQUEST_TIMEOUT_MS = 20_000
const TRANSCRIBE_REQUEST_TIMEOUT_MS = 60_000

/** Short message (fits the glasses) in `message`; the full technical text for the phone UI is in `detail`. */
const SLOW_REQUEST_MS = 3000

/** `sessionExpired`: sign in to Telegram again. `backendAuth`: the backend rejected the shared-secret auth. */
export type ApiErrorKind = 'sessionExpired' | 'backendAuth'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly detail: string = message,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
    readonly kind?: ApiErrorKind,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function isSessionExpiredError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.kind === 'sessionExpired'
}

export function isBackendAuthError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.kind === 'backendAuth'
}

/**
 * The backend answers 401 both for an expired Telegram session and for an auth header it cannot decrypt or
 * whose timestamp is outside the window. Only the detail text tells them apart; the auth-header texts all
 * mention the encryption ("Encrypted auth could not be decrypted", "... timestamp expired", "... nonce ...").
 */
function unauthorizedError(status: number, detail: string): ApiError {
  const authHeaderProblem = status === 403
    || /encrypt|nonce|shared secret|auth header|timestamp/i.test(detail)
  return authHeaderProblem
    ? new ApiError(BACKEND_AUTH_REJECTED_MESSAGE, `${BACKEND_AUTH_REJECTED_DETAIL} (${detail})`, status, undefined, 'backendAuth')
    : new ApiError(SESSION_EXPIRED_MESSAGE, detail, status, undefined, 'sessionExpired')
}

export function requestTimeoutMs(path: string, method = 'GET') {
  if (path === '/api/transcribe') return TRANSCRIBE_REQUEST_TIMEOUT_MS
  if (method === 'POST' && /^\/api\/chats\/[^/]+\/messages$/.test(path)) return SEND_REQUEST_TIMEOUT_MS
  return DEFAULT_REQUEST_TIMEOUT_MS
}

function timeoutDetail(ms: number) {
  return `Backend request timed out after ${Math.round(ms / 1000)}s. The server may be unreachable or stuck. Try again or check the backend.`
}

function floodWaitMessage(seconds: number) {
  return `Telegram asks you to wait ${seconds} s`
}

function parseRetryAfter(value: string | null, text: string): number | undefined {
  const header = value ? Number(value) : NaN
  if (Number.isFinite(header) && header > 0) return Math.ceil(header)
  const match = /(?:wait|retry)[^0-9]{0,40}(\d+)/i.exec(text)
  return match ? Number(match[1]) : undefined
}

function localApiBaseUrl() {
  if (typeof window === 'undefined') return undefined
  const value = (
    window.localStorage.getItem(API_BASE_URL_STORAGE_KEY)
    ?? window.localStorage.getItem(G2_TELE_API_BASE_URL_STORAGE_KEY)
    ?? window.localStorage.getItem(LEGACY_API_BASE_URL_STORAGE_KEY)
  )?.trim()
  if (value) return value
  try {
    const cookies = document.cookie.split(';')
    for (const cookie of cookies) {
      const eq = cookie.indexOf('=')
      if (eq === -1) continue
      const rawKey = cookie.slice(0, eq).trim()
      if (decodeURIComponent(rawKey) === API_BASE_URL_STORAGE_KEY) {
        return decodeURIComponent(cookie.slice(eq + 1).trim())
      }
    }
  } catch { /* cookies unavailable */ }
  return undefined
}

export class HttpTelegramApi implements TelegramApi {
  constructor(
    private readonly baseUrl = defaultApiBaseUrl(),
    private readonly authConfig: () => TelegramAuthConfig = () => ({}),
    private readonly shouldDeferUpdateProcessing: () => boolean = () => false,
  ) {}

  async authStatus(): Promise<AuthStatus> {
    return this.get('/api/session/status')
  }

  async startPhoneAuth(phone: string): Promise<PhoneAuthStart> {
    return this.post('/api/session/phone/start', { phone })
  }

  async verifyPhoneAuth(phone: string, code: string, phoneCodeHash?: string | null, password?: string): Promise<PhoneAuthStatus> {
    return this.post('/api/session/phone/verify', { phone, code, phoneCodeHash, password })
  }

  async logout(): Promise<void> {
    await this.post('/api/session/logout')
  }

  async listChats(limit = 5, options: ListChatsOptions = {}): Promise<Chat[]> {
    const params = new URLSearchParams({ limit: String(limit) })
    if (options.offset) params.set('offset', String(options.offset))
    if (options.folderId !== undefined) params.set('folder_id', String(options.folderId))
    return this.get(`/api/chats?${params.toString()}`)
  }

  async listFolders(): Promise<Folder[]> {
    return this.get('/api/folders')
  }

  async listTopics(chatId: Id): Promise<Topic[]> {
    return this.get(`/api/chats/${encodeURIComponent(String(chatId))}/topics`)
  }

  async listMessages(chatId: Id, options: { topicId?: Id; beforeId?: Id; afterId?: Id; limit?: number } = {}): Promise<Message[]> {
    const params = new URLSearchParams()
    if (options.topicId) params.set('topic_id', String(options.topicId))
    if (options.beforeId) params.set('before_id', String(options.beforeId))
    if (options.afterId) params.set('after_id', String(options.afterId))
    params.set('limit', String(options.limit ?? 8))
    return this.get(`/api/chats/${encodeURIComponent(String(chatId))}/messages?${params.toString()}`)
  }

  async getPhoto(chatId: Id, messageId: Id): Promise<Photo> {
    return this.get(`/api/chats/${encodeURIComponent(String(chatId))}/messages/${encodeURIComponent(String(messageId))}/photo`)
  }

  async sendMessage(chatId: Id, request: SendMessageRequest): Promise<Message> {
    const response = await this.post<SendMessageResponse>(`/api/chats/${encodeURIComponent(String(chatId))}/messages`, {
      text: request.text,
      topicId: request.topicId,
    })
    return {
      id: response.id,
      sender: 'Me',
      text: request.text,
      outgoing: true,
    }
  }

  async markRead(chatId: Id, request: MarkReadRequest): Promise<void> {
    await this.post(`/api/chats/${encodeURIComponent(String(chatId))}/read`, {
      topicId: request.topicId,
      maxId: request.maxId,
    })
  }

  async transcribe(wav: Blob, language?: string): Promise<TranscriptionResult> {
    const form = new FormData()
    form.append('audio', wav, 'reply.wav')
    if (language) form.append('language', language)
    const sttBaseUrl = this.sttBaseUrl()
    return this.request('/api/transcribe', { method: 'POST', body: form }, sttBaseUrl, sttBaseUrl === this.baseUrl)
  }
  subscribeUpdates(onUpdate: (update: TelegramUpdate | TelegramTypingUpdate) => void, onError?: (error: Event | Error) => void, onReconnect?: () => void, onOpen?: () => void) {
    if (typeof fetch === 'undefined' || typeof AbortController === 'undefined') return () => undefined
    const controller = new AbortController()
    void this.keepStreamAlive(controller.signal, onUpdate, onError, onReconnect, onOpen)
    return () => controller.abort()
  }

  /** Keep one update stream open for as long as the caller is subscribed, reconnecting with backoff when it drops. */
  private async keepStreamAlive(
    signal: AbortSignal,
    onUpdate: (update: TelegramUpdate | TelegramTypingUpdate) => void,
    onError?: (error: Event | Error) => void,
    onReconnect?: () => void,
    onOpen?: () => void,
  ) {
    let failures = 0
    let connections = 0
    while (!signal.aborted) {
      const startedAt = Date.now()
      try {
        await this.streamUpdates(signal, onUpdate, () => {
          connections += 1
          // A reconnect may have missed events while it was down, so let the caller catch up.
          if (connections > 1) onReconnect?.()
          onOpen?.()
          debugLog('stream.open', { connections })
        })
      } catch (error) {
        if (signal.aborted) return
        debugLog('stream.error', { error: errorText(error), upMs: Date.now() - startedAt })
        if (isUnrecoverableStreamError(error)) {
          onError?.(error instanceof Error ? error : new Error('Update stream failed'))
          return
        }
        onError?.(error instanceof Error ? error : new Error('Update stream failed'))
      }
      if (signal.aborted) return
      // A stream that stayed up for a while was healthy, so the next drop starts the backoff over.
      failures = Date.now() - startedAt > STREAM_HEALTHY_MS ? 0 : failures + 1
      await sleepUnlessAborted(Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1)), signal)
    }
  }

  private get<T>(path: string): Promise<T> {
    // Identical requests that overlap share one network call. A burst of duplicates (for example the same
    // folder page asked for many times at once) then costs the backend one fetch, not dozens.
    const key = `${this.baseUrl}${path}`
    const existing = this.inflightGets.get(key)
    if (existing) return existing as Promise<T>
    const promise = this.request<T>(path, { method: 'GET' }).finally(() => {
      this.inflightGets.delete(key)
    })
    this.inflightGets.set(key, promise)
    return promise
  }

  private inflightGets = new Map<string, Promise<unknown>>()
  private failureStreak = 0
  private blockedUntil = 0

  /** After repeated timeouts or gateway errors, fail fast for a moment instead of piling more requests on. */
  private assertBackendNotBackedOff(path: string) {
    if (path.startsWith('/api/session/')) return // sign-in must always be able to try
    if (Date.now() < this.blockedUntil) throw new ApiError(BACKEND_BUSY_MESSAGE, 'Backend is busy. Retrying in a moment.')
  }

  private noteBackendResult(failed: boolean) {
    if (!failed) {
      this.failureStreak = 0
      return
    }
    this.failureStreak += 1
    if (this.failureStreak >= BACKOFF_AFTER_FAILURES) {
      const steps = this.failureStreak - BACKOFF_AFTER_FAILURES
      this.blockedUntil = Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** steps)
    }
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request(path, {
      method: 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
  /**
   * Returns the configured shared secret for the current backend.
   */
  private getEffectiveSharedSecret() {
    return effectiveBackendSharedSecret(this.authConfig(), this.baseUrl)
  }

  private async request<T>(path: string, init: RequestInit, baseUrl = this.baseUrl, includeTelegramAuth = true): Promise<T> {
    const startedAt = Date.now()
    try {
      const result = await this.requestInner<T>(path, init, baseUrl, includeTelegramAuth)
      const durationMs = Date.now() - startedAt
      if (durationMs >= SLOW_REQUEST_MS) debugLog('api.slow', { method: init.method ?? 'GET', path: path.split('?')[0], durationMs })
      return result
    } catch (error) {
      debugLog('api.error', { method: init.method ?? 'GET', path: path.split('?')[0], durationMs: Date.now() - startedAt, error: errorText(error) })
      throw error
    }
  }

  private async requestInner<T>(path: string, init: RequestInit, baseUrl = this.baseUrl, includeTelegramAuth = true): Promise<T> {
    // Without a Backend URL the request would go to the app's own origin; never send credentials there.
    if (!baseUrl?.trim()) throw new Error(BACKEND_NOT_CONFIGURED_MESSAGE)
    const ownBackend = baseUrl === this.baseUrl
    if (ownBackend) this.assertBackendNotBackedOff(path)
    const headers = await this.withTelegramHeaders(init.headers, includeTelegramAuth)
    const requestInit = await this.withEncryptedJsonBody(init, headers, includeTelegramAuth)
    const controller = new AbortController()
    const timeoutMs = requestTimeoutMs(path, init.method)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...requestInit,
        headers,
        signal: controller.signal,
      })
    } catch (error) {
      if (ownBackend) this.noteBackendResult(true)
      if (controller.signal.aborted) {
        throw new ApiError(BACKEND_TIMEOUT_MESSAGE, timeoutDetail(timeoutMs))
      }
      throw new ApiError(BACKEND_UNREACHABLE_MESSAGE, BACKEND_UNREACHABLE_DETAIL)
    } finally {
      clearTimeout(timer)
    }
    if (ownBackend) this.noteBackendResult(response.status === 502 || response.status === 503 || response.status === 504)
    const text = await this.responseText(response, includeTelegramAuth)
    if (!response.ok) throw httpError(response, text)
    return JSON.parse(text) as T
  }

  private async streamUpdates(
    signal: AbortSignal,
    onUpdate: (update: TelegramUpdate | TelegramTypingUpdate) => void,
    onOpen?: () => void,
  ) {
    if (!this.baseUrl?.trim()) throw new Error(BACKEND_NOT_CONFIGURED_MESSAGE)
    const headers = await this.withTelegramHeaders(undefined, true)
    // The server sends a keepalive every few seconds; silence means the connection died without telling us.
    const inner = new AbortController()
    const forwardAbort = () => inner.abort()
    signal.addEventListener('abort', forwardAbort, { once: true })
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const resetWatchdog = () => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => inner.abort(), STREAM_SILENCE_MS)
    }
    try {
      resetWatchdog()
      let response: Response
      try {
        response = await fetch(`${this.baseUrl}/api/updates`, {
          headers,
          signal: inner.signal,
        })
      } catch {
        throw new ApiError(BACKEND_UNREACHABLE_MESSAGE, BACKEND_UNREACHABLE_DETAIL)
      }
      if (!response.ok) throw httpError(response, await this.responseText(response, true))
      if (!response.body) throw new Error('Update stream is unavailable')
      onOpen?.()
      await this.readEventStream(response.body.getReader(), signal, onUpdate, resetWatchdog)
    } finally {
      if (watchdog) clearTimeout(watchdog)
      signal.removeEventListener('abort', forwardAbort)
    }
  }

  private async readEventStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
    onUpdate: (update: TelegramUpdate | TelegramTypingUpdate) => void,
    onActivity: () => void,
  ) {
    const decoder = new TextDecoder()
    let buffer = ''
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) return
      onActivity()
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''
      for (const event of events) {
        const lines = event.split('\n')
        const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message'
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (!data) continue
        await this.waitForUpdateProcessing(signal)
        const decodedData = await this.decryptEventData(data)
        if (eventName === 'message') {
          onUpdate(JSON.parse(decodedData) as TelegramUpdate)
        } else if (eventName === 'typing') {
          const update: TelegramTypingUpdate = { type: 'typing', ...JSON.parse(decodedData) }
          onUpdate(update)
        } else if (eventName === 'error') {
          const payload = JSON.parse(decodedData) as { detail?: string }
          const detail = payload.detail || 'Update stream failed'
          // The stream reports a dead Telegram session as an error event, not as an HTTP 401.
          if (/session has expired/i.test(detail)) throw unauthorizedError(401, detail)
          throw new Error(detail)
        }
      }
    }
  }

  private async withTelegramHeaders(headers: HeadersInit | undefined, includeTelegramAuth: boolean) {
    const merged = new Headers(headers)
    // Tells the backend this client uses the per-purpose AADs (see secureAuth.ts).
    merged.set(PROTOCOL_HEADER, PROTOCOL_VERSION)
    if (!includeTelegramAuth) return merged
    const sharedSecret = this.getEffectiveSharedSecret()
    if (!sharedSecret) {
      throw new Error('Backend shared secret is required. Set it in TeleGlance Settings and in backend .env as TELEGLANCE_SHARED_SECRET.')
    }
    const config = { ...this.authConfig(), backendSharedSecret: sharedSecret }
    const encryptedAuth = await encryptedTelegramAuthHeader(config)
    if (!encryptedAuth) {
      throw new Error('Encrypted auth requires Backend shared secret, Telegram API ID, and Telegram API hash in TeleGlance Settings.')
    }
    merged.set('X-TeleGlance-Auth', encryptedAuth)
    return merged
  }

  private async withEncryptedJsonBody(init: RequestInit, headers: Headers, includeTelegramAuth: boolean): Promise<RequestInit> {
    const sharedSecret = this.getEffectiveSharedSecret()
    const contentType = headers.get('Content-Type') ?? headers.get('content-type') ?? ''
    if (!includeTelegramAuth || !sharedSecret || typeof init.body !== 'string' || !contentType.startsWith('application/json')) {
      return init
    }
    const encryptedPayload = await encryptJsonPayload(init.body, sharedSecret)
    return {
      ...init,
      body: JSON.stringify({ encryptedPayload }),
    }
  }

  private async responseText(response: Response, includeTelegramAuth: boolean) {
    const text = await response.text()
    if (!includeTelegramAuth || response.headers.get('X-TeleGlance-Encrypted') !== '1') return text
    const sharedSecret = this.getEffectiveSharedSecret()
    if (!sharedSecret) throw new Error('Backend shared secret is required to decrypt backend response.')
    const envelope = JSON.parse(text) as { encryptedPayload?: unknown }
    if (typeof envelope.encryptedPayload !== 'string') throw new Error('Encrypted backend response is malformed')
    return decryptJsonPayload(envelope.encryptedPayload, sharedSecret)
  }

  private async decryptEventData(data: string) {
    const payload = JSON.parse(data) as { encryptedPayload?: unknown }
    if (typeof payload.encryptedPayload !== 'string') return data
    const sharedSecret = this.getEffectiveSharedSecret()
    if (!sharedSecret) throw new Error('Backend shared secret is required to decrypt update stream.')
    return decryptJsonPayload(payload.encryptedPayload, sharedSecret)
  }

  /** Settings "Test connection": plain GET /health, then the authenticated session status. */
  async testConnection(): Promise<ConnectionTestResult> {
    const result: ConnectionTestResult = { health: { ok: false }, session: null }
    try {
      if (!this.baseUrl?.trim()) throw new Error(BACKEND_NOT_CONFIGURED_MESSAGE)
      const response = await fetch(`${this.baseUrl}/health`, { headers: { [PROTOCOL_HEADER]: PROTOCOL_VERSION } })
      result.health = response.ok ? { ok: true } : { ok: false, error: `HTTP ${response.status}` }
    } catch (error) {
      result.health = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (!result.health.ok) return result
    try {
      const status = await this.authStatus()
      result.session = { ok: true, authorized: Boolean(status.authorized) }
    } catch (error) {
      result.session = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    return result
  }

  private sttBaseUrl() {
    return this.authConfig().sttBaseUrl?.trim() || this.baseUrl
  }

  private async waitForUpdateProcessing(signal: AbortSignal) {
    while (!signal.aborted && this.shouldDeferUpdateProcessing()) {
      await sleep(100)
    }
  }
}

function httpError(response: Response, text: string): ApiError {
  const detail = readableErrorText(response.status, text)
  if (response.status === 429) {
    const seconds = parseRetryAfter(response.headers.get('Retry-After'), detail)
    return seconds
      ? new ApiError(floodWaitMessage(seconds), detail, 429, seconds)
      : new ApiError(TELEGRAM_BUSY_MESSAGE, detail, 429)
  }
  if (response.status === 401 || response.status === 403) return unauthorizedError(response.status, detail)
  if (response.status === 502 || response.status === 503) return new ApiError(BACKEND_BUSY_MESSAGE, detail, response.status)
  if (response.status === 504) return new ApiError(BACKEND_TIMEOUT_MESSAGE, detail, 504)
  return new ApiError(detail, detail, response.status)
}

function readableErrorText(status: number, text: string) {
  if (!text) return `Request failed with ${status}`
  try {
    const payload = JSON.parse(text) as { detail?: unknown }
    if (typeof payload.detail === 'string') return payload.detail
  } catch {
    return text
  }
  return text
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms)
    const maybeNodeTimeout = timeout as unknown as { unref?: () => void }
    maybeNodeTimeout.unref?.()
  })
}

/** After this long without any bytes (the server sends a keepalive every 15 s) the stream is treated as dead. */
const STREAM_SILENCE_MS = 45_000
const STREAM_RETRY_BASE_MS = 1_000
const STREAM_RETRY_MAX_MS = 30_000
/** A stream that lived this long counts as healthy, which resets the retry backoff. */
const STREAM_HEALTHY_MS = 30_000

/**
 * Missing settings and rejected auth (401/403: expired session, wrong shared secret) never fix themselves by
 * retrying; everything else (network, restart, 5xx) does. The caller resubscribes after signing in again.
 */
export function isUnrecoverableStreamError(error: unknown): boolean {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return true
  const message = error instanceof Error ? error.message : ''
  return message.includes('shared secret is required')
    || message.includes('Encrypted auth requires')
    || message === BACKEND_NOT_CONFIGURED_MESSAGE
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}
