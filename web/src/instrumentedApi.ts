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
  TelegramTypingUpdate,
  TelegramUpdate,
  Topic,
  TranscriptionResult,
} from './types'
import type { ListChatsOptions, TelegramApi } from './api'
import { isTeleGlanceFixtureMode, logApiEvent, logApiTiming } from './testMode'

export class InstrumentedTelegramApi implements TelegramApi {
  constructor(private readonly inner: TelegramApi) {}

  async authStatus(): Promise<AuthStatus> {
    return this.wrap('authStatus', undefined, () => this.inner.authStatus())
  }

  async startPhoneAuth(phone: string): Promise<PhoneAuthStart> {
    return this.wrap('startPhoneAuth', { phone }, () => this.inner.startPhoneAuth(phone))
  }

  async verifyPhoneAuth(phone: string, code: string, phoneCodeHash?: string | null, password?: string): Promise<PhoneAuthStatus> {
    return this.wrap('verifyPhoneAuth', { phone, code, hasPhoneCodeHash: Boolean(phoneCodeHash), hasPassword: Boolean(password) }, () => this.inner.verifyPhoneAuth(phone, code, phoneCodeHash, password))
  }

  async logout(): Promise<void> {
    return this.wrap('logout', undefined, () => this.inner.logout())
  }

  async listChats(limit = 5, options: ListChatsOptions = {}): Promise<Chat[]> {
    return this.wrap('listChats', { limit, ...options }, () => this.inner.listChats(limit, options))
  }

  async listFolders(): Promise<Folder[]> {
    return this.wrap('listFolders', undefined, () => this.inner.listFolders())
  }

  async listTopics(chatId: Id): Promise<Topic[]> {
    return this.wrap('listTopics', { chatId }, () => this.inner.listTopics(chatId))
  }

  async listMessages(chatId: Id, options: { topicId?: Id; beforeId?: Id; limit?: number } = {}): Promise<Message[]> {
    return this.wrap('listMessages', { chatId, options }, () => this.inner.listMessages(chatId, options))
  }

  async getPhoto(chatId: Id, messageId: Id): Promise<Photo> {
    return this.wrap('getPhoto', { chatId, messageId }, () => this.inner.getPhoto(chatId, messageId))
  }

  async sendMessage(chatId: Id, request: SendMessageRequest): Promise<Message> {
    return this.wrap('sendMessage', { chatId, request }, () => this.inner.sendMessage(chatId, request))
  }

  async markRead(chatId: Id, request: MarkReadRequest): Promise<void> {
    return this.wrap('markRead', { chatId, request }, () => this.inner.markRead(chatId, request))
  }

  async transcribe(wav: Blob, language?: string): Promise<TranscriptionResult> {
    return this.wrap('transcribe', { size: wav.size, language }, () => this.inner.transcribe(wav, language))
  }

  subscribeUpdates(onUpdate: (update: TelegramUpdate | TelegramTypingUpdate) => void, onError?: (error: Event | Error) => void): () => void {
    if (isTeleGlanceFixtureMode()) {
      const startedAt = Date.now()
      const unsubscribe = this.inner.subscribeUpdates(onUpdate, onError)
      logApiEvent('subscribeUpdates', undefined, startedAt, Date.now(), true)
      return () => {
        const stopAt = Date.now()
        unsubscribe()
        logApiEvent('unsubscribeUpdates', undefined, stopAt, Date.now(), true)
      }
    }
    return this.inner.subscribeUpdates(onUpdate, onError)
  }

  private async wrap<T>(call: string, args: unknown, fn: () => Promise<T>): Promise<T> {
    if (!isTeleGlanceFixtureMode()) {
      // Real-mode: log timing only. Never include phone, code, message text, or any
      // sensitive payload. Chat/topic/message ids are public identifiers, not secrets.
      const startedAt = Date.now()
      try {
        const result = await fn()
        logApiTiming(call, sanitizeArgsForRealMode(args), startedAt, Date.now(), true, resultSummary(result))
        return result
      } catch (error) {
        logApiTiming(call, sanitizeArgsForRealMode(args), startedAt, Date.now(), false, undefined, error)
        throw error
      }
    }
    const startedAt = Date.now()
    try {
      const result = await fn()
      logApiEvent(call, args, startedAt, Date.now(), true, result)
      return result
    } catch (error) {
      logApiEvent(call, args, startedAt, Date.now(), false, undefined, error)
      throw error
    }
  }
}

/**
 * Strip sensitive arguments for real-mode harness logs. Phone numbers, login codes,
 * session strings, and message text are all excluded; chat/topic ids and array sizes
 * are kept so the harness can attribute latency to specific API calls and pagination.
 */
function sanitizeArgsForRealMode(args: unknown): unknown {
  if (!args || typeof args !== 'object') return args
  const source = args as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key === 'phone' || key === 'code' || key === 'sessionString' || key === 'stringSession') {
      out[key] = '[redacted]'
      continue
    }
    if (key === 'request' && value && typeof value === 'object') {
      const req = value as Record<string, unknown>
      out.request = {
        textLength: typeof req.text === 'string' ? req.text.length : undefined,
        topicId: req.topicId,
      }
      continue
    }
    out[key] = value
  }
  return out
}

function resultSummary(result: unknown): unknown {
  if (result === undefined || result === null) return result
  if (Array.isArray(result)) return { __array: true, length: result.length }
  if (typeof result === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
      if (key === 'text' || key === 'transcript' || key === 'sessionString' || key === 'stringSession') {
        out[key] = '[redacted]'
      } else {
        out[key] = value
      }
    }
    return out
  }
  return result
}
