import type { Chat, Message } from '../types'

/** The slice of the Even App SDK storage the cache needs (string key/value, async, no documented size limit). */
export interface CacheStorageBridge {
  getLocalStorage?(key: string): Promise<string>
  setLocalStorage?(key: string, value: string): Promise<boolean>
}

export interface ThreadEntry {
  messages: Message[]
  cursor?: string | number
}

export interface CacheOptions {
  /** Total size of everything kept, in UTF-8 bytes. The SDK documents no limit, so stay small. */
  budgetBytes?: number
  /** Entries older than this are dropped when the cache is opened or read. */
  maxAgeMs?: number
  /** Writes are batched; this is how long to wait after the first change. */
  flushDelayMs?: number
  /** At most this many (newest) messages are kept per thread. */
  maxMessagesPerThread?: number
  now?: () => number
  /** Return false while the user is interacting; the flush then waits and tries again. */
  canWrite?: () => boolean
}

const VERSION = 1
const PREFIX = `teleGlance.cache.v${VERSION}.`
const INDEX_KEY = `${PREFIX}index`
const CHATS_KEY = `${PREFIX}chats`

const DEFAULTS = {
  budgetBytes: 400_000,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  flushDelayMs: 2000,
  maxMessagesPerThread: 24,
}

interface Index {
  version: number
  account: string
  chatsBytes: number
  threads: Record<string, { bytes: number; usedAt: number }>
}

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : undefined

function byteLength(value: string): number {
  return encoder ? encoder.encode(value).length : value.length
}

/** Short non-cryptographic hash (FNV-1a, 32 bit) used for storage key names and the account stamp. */
export function shortHash(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Stamp identifying whose messages are cached, so a different account never sees them. Not reversible to the session. */
export function cacheAccountStamp(parts: { apiId: string; apiHash: string; session: string; backend: string }): string {
  return shortHash(`${parts.apiId}|${parts.apiHash}|${parts.session}|${parts.backend}`)
}

function threadStorageKey(threadKey: string): string {
  return `${PREFIX}t.${shortHash(threadKey)}`
}

/**
 * Persists the chat list and the latest page of recent threads so they can be shown immediately on the
 * next launch, then refreshed from the network. Everything is best effort: a missing, failing or
 * unreliable storage only means the cache stays empty.
 */
export class PersistentCache {
  private readonly options: Required<Omit<CacheOptions, 'canWrite'>> & Pick<CacheOptions, 'canWrite'>
  private index: Index | undefined
  private account = ''
  private readonly dirty = new Map<string, { kind: 'chats' } | { kind: 'thread'; key: string; entry: ThreadEntry }>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private chain: Promise<void> = Promise.resolve()
  private indexDirty = false

  constructor(private readonly storage: CacheStorageBridge | undefined, options: CacheOptions = {}) {
    this.options = {
      budgetBytes: options.budgetBytes ?? DEFAULTS.budgetBytes,
      maxAgeMs: options.maxAgeMs ?? DEFAULTS.maxAgeMs,
      flushDelayMs: options.flushDelayMs ?? DEFAULTS.flushDelayMs,
      maxMessagesPerThread: options.maxMessagesPerThread ?? DEFAULTS.maxMessagesPerThread,
      now: options.now ?? Date.now,
      canWrite: options.canWrite,
    }
  }

  get available(): boolean {
    return Boolean(this.storage?.getLocalStorage && this.storage?.setLocalStorage)
  }

  /** Load the index. A different account, an old format or expired entries are discarded here. */
  async open(account: string): Promise<void> {
    this.account = account
    this.index = { version: VERSION, account, chatsBytes: 0, threads: {} }
    if (!this.available) return
    const raw = await this.read(INDEX_KEY)
    const stored = raw ? safeParse<Index>(raw) : undefined
    if (!stored || stored.version !== VERSION || stored.account !== account || typeof stored.threads !== 'object') {
      if (stored) await this.wipe(stored)
      return
    }
    this.index = { ...stored, threads: stored.threads ?? {}, chatsBytes: stored.chatsBytes ?? 0 }
    const cutoff = this.options.now() - this.options.maxAgeMs
    for (const [id, meta] of Object.entries(this.index.threads)) {
      if (meta.usedAt < cutoff) {
        delete this.index.threads[id]
        this.indexDirty = true
        await this.write(`${PREFIX}t.${id}`, '')
      }
    }
    if (this.indexDirty) this.scheduleFlush()
  }

  async getChats(): Promise<Chat[] | undefined> {
    if (!this.available || !this.index) return undefined
    const raw = await this.read(CHATS_KEY)
    const stored = raw ? safeParse<{ at: number; chats: Chat[] }>(raw) : undefined
    if (!stored || !Array.isArray(stored.chats) || this.options.now() - stored.at > this.options.maxAgeMs) return undefined
    return stored.chats
  }

  async getThread(threadKey: string): Promise<ThreadEntry | undefined> {
    if (!this.available || !this.index) return undefined
    const id = shortHash(threadKey)
    if (!this.index.threads[id]) return undefined
    const raw = await this.read(`${PREFIX}t.${id}`)
    const stored = raw ? safeParse<{ at: number; key: string; entry: ThreadEntry }>(raw) : undefined
    if (!stored || stored.key !== threadKey || !Array.isArray(stored.entry?.messages)) return undefined
    if (this.options.now() - stored.at > this.options.maxAgeMs) return undefined
    this.index.threads[id].usedAt = this.options.now()
    this.indexDirty = true
    this.scheduleFlush()
    return stored.entry
  }

  putChats(chats: Chat[]): void {
    if (!this.available || !this.index) return
    this.dirty.set(CHATS_KEY, { kind: 'chats' })
    this.pendingChats = chats
    this.scheduleFlush()
  }

  putThread(threadKey: string, entry: ThreadEntry): void {
    if (!this.available || !this.index) return
    const kept = entry.messages.slice(-this.options.maxMessagesPerThread)
    const messages = kept
      // The "last read" marker is local to a session, so it is never stored.
      .map(({ firstUnread: _firstUnread, ...message }) => message as Message)
    // Trimming moves the oldest stored message, and older pages are fetched from there.
    const cursor = kept.length < entry.messages.length ? kept[0]?.id : entry.cursor
    this.dirty.set(threadStorageKey(threadKey), { kind: 'thread', key: threadKey, entry: { messages, cursor } })
    this.scheduleFlush()
  }

  stats(): { threads: number; bytes: number } {
    const threads = Object.values(this.index?.threads ?? {})
    return { threads: threads.length, bytes: threads.reduce((sum, meta) => sum + meta.bytes, 0) + (this.index?.chatsBytes ?? 0) }
  }

  /** Delete everything this cache stored. */
  async clear(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    this.dirty.clear()
    this.pendingChats = undefined
    const index = this.index
    this.index = { version: VERSION, account: this.account, chatsBytes: 0, threads: {} }
    this.indexDirty = false
    if (!this.available) return
    await this.chain
    if (index) await this.wipe(index)
    else await this.write(INDEX_KEY, '')
  }

  /** Write pending changes now (tests, and the moment the app is about to go away). */
  flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    this.chain = this.chain.then(() => this.doFlush()).catch(() => undefined)
    return this.chain
  }

  private pendingChats: Chat[] | undefined

  private scheduleFlush() {
    if (this.flushTimer || !this.available) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      if (this.options.canWrite && !this.options.canWrite()) {
        this.scheduleFlush()
        return
      }
      void this.flush()
    }, this.options.flushDelayMs)
    const maybeNodeTimer = this.flushTimer as unknown as { unref?: () => void }
    maybeNodeTimer.unref?.()
  }

  private async doFlush() {
    const index = this.index
    if (!index || !this.available) return
    const entries = [...this.dirty.entries()]
    this.dirty.clear()
    for (const [storageKey, item] of entries) {
      if (item.kind === 'chats') {
        const chats = this.pendingChats
        this.pendingChats = undefined
        if (!chats) continue
        const value = JSON.stringify({ at: this.options.now(), chats })
        if (await this.write(CHATS_KEY, value)) {
          index.chatsBytes = byteLength(value)
          this.indexDirty = true
        }
        continue
      }
      const value = JSON.stringify({ at: this.options.now(), key: item.key, entry: item.entry })
      const id = shortHash(item.key)
      if (byteLength(value) > this.options.budgetBytes / 2) continue // never let one thread crowd out the rest
      if (await this.write(storageKey, value)) {
        index.threads[id] = { bytes: byteLength(value), usedAt: this.options.now() }
        this.indexDirty = true
      }
    }
    await this.evict(index)
    if (this.indexDirty) {
      this.indexDirty = false
      await this.write(INDEX_KEY, JSON.stringify(index))
    }
  }

  /** Drop the least recently used threads until the total fits the budget. */
  private async evict(index: Index) {
    let total = index.chatsBytes + Object.values(index.threads).reduce((sum, meta) => sum + meta.bytes, 0)
    if (total <= this.options.budgetBytes) return
    const oldestFirst = Object.entries(index.threads).sort((a, b) => a[1].usedAt - b[1].usedAt)
    for (const [id, meta] of oldestFirst) {
      if (total <= this.options.budgetBytes) break
      delete index.threads[id]
      total -= meta.bytes
      this.indexDirty = true
      await this.write(`${PREFIX}t.${id}`, '')
    }
  }

  private async wipe(index: Index) {
    for (const id of Object.keys(index.threads ?? {})) await this.write(`${PREFIX}t.${id}`, '')
    await this.write(CHATS_KEY, '')
    await this.write(INDEX_KEY, '')
  }

  private async read(key: string): Promise<string | undefined> {
    try {
      const value = await this.storage?.getLocalStorage?.(key)
      return value ? value : undefined
    } catch {
      return undefined
    }
  }

  private async write(key: string, value: string): Promise<boolean> {
    try {
      const result = await this.storage?.setLocalStorage?.(key, value)
      return result !== false
    } catch {
      return false
    }
  }
}

function safeParse<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}
