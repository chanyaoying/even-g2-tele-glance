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
import { decryptJsonPayload, encryptedTelegramAuthHeader, encryptJsonPayload } from './secureAuth'

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
  subscribeUpdates(onUpdate: (update: TelegramUpdate | TelegramTypingUpdate) => void, onError?: (error: Event | Error) => void, onReconnect?: () => void): () => void
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

export const SHARED_BACKEND_URL = 'https://teleglance.akira-os.net'
export const SHARED_BACKEND_TEST_SECRET = 'test-secret-token'
export const BACKEND_URL_PLACEHOLDER = 'http://<BACKEND_URL>:8787'

export function defaultApiBaseUrl() {
  return localApiBaseUrl() ?? SHARED_BACKEND_URL
}

export function isSharedBackendUrl(baseUrl: string | undefined) {
  // Compare parsed origins: a prefix match would also accept look-alikes such as
  // https://teleglance.akira-os.net.evil.example or https://teleglance.akira-os.net@evil.example.
  try {
    return new URL((baseUrl ?? '').trim()).origin === SHARED_BACKEND_URL
  } catch {
    return false
  }
}

export function effectiveBackendSharedSecret(config: TelegramAuthConfig, baseUrl: string | undefined) {
  if (isSharedBackendUrl(baseUrl)) return SHARED_BACKEND_TEST_SECRET
  return config.backendSharedSecret?.trim() ?? ''
}

export const API_BASE_URL_STORAGE_KEY = 'teleGlance.apiBaseUrl'
export const G2_TELE_API_BASE_URL_STORAGE_KEY = 'g2Tele.apiBaseUrl'
export const LEGACY_API_BASE_URL_STORAGE_KEY = 'evenTelegram.apiBaseUrl'
export const BACKEND_BUSY_MESSAGE = 'Backend is busy. Retrying in a moment.'
const BACKOFF_AFTER_FAILURES = 3
const BACKOFF_BASE_MS = 2000
const BACKOFF_MAX_MS = 30_000
export const BACKEND_UNREACHABLE_MESSAGE ='Backend is not reachable. Fill Backend URL in Settings and make sure the backend server is running.'
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
function REQUEST_TIMEOUT_MESSAGE(ms: number) {
  return `Backend request timed out after ${Math.round(ms / 1000)}s. The server may be unreachable or stuck. Try again or check the backend.`
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
  subscribeUpdates(onUpdate: (update: TelegramUpdate | TelegramTypingUpdate) => void, onError?: (error: Event | Error) => void, onReconnect?: () => void) {
    if (typeof fetch === 'undefined' || typeof AbortController === 'undefined') return () => undefined
    const controller = new AbortController()
    void this.keepStreamAlive(controller.signal, onUpdate, onError, onReconnect)
    return () => controller.abort()
  }

  /** Keep one update stream open for as long as the caller is subscribed, reconnecting with backoff when it drops. */
  private async keepStreamAlive(
    signal: AbortSignal,
    onUpdate: (update: TelegramUpdate | TelegramTypingUpdate) => void,
    onError?: (error: Event | Error) => void,
    onReconnect?: () => void,
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
        })
      } catch (error) {
        if (signal.aborted) return
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
    if (Date.now() < this.blockedUntil) throw new Error(BACKEND_BUSY_MESSAGE)
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
    const ownBackend = baseUrl === this.baseUrl
    if (ownBackend) this.assertBackendNotBackedOff(path)
    const headers = await this.withTelegramHeaders(init.headers, includeTelegramAuth)
    const requestInit = await this.withEncryptedJsonBody(init, headers, includeTelegramAuth)
    const controller = new AbortController()
    const timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
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
        throw new Error(REQUEST_TIMEOUT_MESSAGE(timeoutMs))
      }
      throw new Error(BACKEND_UNREACHABLE_MESSAGE)
    } finally {
      clearTimeout(timer)
    }
    if (ownBackend) this.noteBackendResult(response.status === 502 || response.status === 503 || response.status === 504)
    const text = await this.responseText(response, includeTelegramAuth)
    if (!response.ok) throw new Error(readableErrorText(response.status, text))
    return JSON.parse(text) as T
  }

  private async streamUpdates(
    signal: AbortSignal,
    onUpdate: (update: TelegramUpdate | TelegramTypingUpdate) => void,
    onOpen?: () => void,
  ) {
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
        throw new Error(BACKEND_UNREACHABLE_MESSAGE)
      }
      if (!response.ok) throw new Error(readableErrorText(response.status, await this.responseText(response, true)))
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
          throw new Error(payload.detail || 'Update stream failed')
        }
      }
    }
  }

  private async withTelegramHeaders(headers: HeadersInit | undefined, includeTelegramAuth: boolean) {
    const merged = new Headers(headers)
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
      const response = await fetch(`${this.baseUrl}/health`)
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

/** Missing settings never fix themselves by retrying; everything else (network, restart, 5xx) does. */
function isUnrecoverableStreamError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return message.includes('shared secret is required') || message.includes('Encrypted auth requires')
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
