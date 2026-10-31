import { describe, expect, it } from 'vitest'
import { PersistentCache, cacheAccountStamp, shortHash } from '../src/cache/persistentCache'
import type { Chat, Message } from '../src/types'

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial))
  return {
    data,
    getLocalStorage: async (key: string) => data.get(key) ?? '',
    setLocalStorage: async (key: string, value: string) => {
      if (value === '') data.delete(key)
      else data.set(key, value)
      return true
    },
  }
}

const chat = (id: number): Chat => ({ id: String(id), title: `Chat ${id}`, kind: 'group' } as Chat)
const messages = (count: number, prefix = 'm'): Message[] =>
  Array.from({ length: count }, (_, i) => ({ id: String(i + 1), sender: 'Alice', text: `${prefix} ${i + 1}` }))

async function opened(storage = fakeStorage(), options = {}, account = 'acct') {
  let time = 1_000
  const cache = new PersistentCache(storage, { flushDelayMs: 1, now: () => time, ...options })
  await cache.open(account)
  return { cache, storage, tick: (ms: number) => { time += ms } }
}

describe('PersistentCache', () => {
  it('stores the chat list and a thread and reads them back after reopening', async () => {
    const { cache, storage } = await opened()
    cache.putChats([chat(1), chat(2)])
    cache.putThread('1', { messages: messages(3), cursor: '1' })
    await cache.flush()

    const again = new PersistentCache(storage, { flushDelayMs: 1, now: () => 1_000 })
    await again.open('acct')
    expect((await again.getChats())?.map((c) => c.id)).toEqual(['1', '2'])
    const thread = await again.getThread('1')
    expect(thread?.messages.map((m) => m.text)).toEqual(['m 1', 'm 2', 'm 3'])
    expect(thread?.cursor).toBe('1')
  })

  it('never stores the session-local last-read marker', async () => {
    const { cache } = await opened()
    cache.putThread('7', { messages: [{ id: '1', text: 'a', firstUnread: true } as Message] })
    await cache.flush()
    expect((await cache.getThread('7'))?.messages[0]).not.toHaveProperty('firstUnread')
  })

  it('keeps only the newest messages of a long thread', async () => {
    const { cache } = await opened(undefined, { maxMessagesPerThread: 5 })
    cache.putThread('9', { messages: messages(12) })
    await cache.flush()
    expect((await cache.getThread('9'))?.messages.map((m) => m.id)).toEqual(['8', '9', '10', '11', '12'])
  })

  it('discards everything when the account stamp changes', async () => {
    const { cache, storage } = await opened(undefined, {}, 'acct-a')
    cache.putChats([chat(1)])
    cache.putThread('1', { messages: messages(2) })
    await cache.flush()
    expect(storage.data.size).toBeGreaterThan(0)

    const other = new PersistentCache(storage, { flushDelayMs: 1 })
    await other.open('acct-b')
    expect(await other.getChats()).toBeUndefined()
    expect(await other.getThread('1')).toBeUndefined()
    expect(storage.data.size).toBe(0)
  })

  it('drops entries older than the maximum age', async () => {
    const { cache, storage, tick } = await opened(undefined, { maxAgeMs: 10_000 })
    cache.putThread('1', { messages: messages(2) })
    await cache.flush()
    tick(20_000)

    const later = new PersistentCache(storage, { flushDelayMs: 1, maxAgeMs: 10_000, now: () => 1_000 + 20_000 })
    await later.open('acct')
    expect(await later.getThread('1')).toBeUndefined()
  })

  it('evicts the least recently used thread when over budget', async () => {
    const { cache, tick } = await opened(undefined, { budgetBytes: 1_800 })
    const big = (label: string) => messages(8, label.repeat(40))
    cache.putThread('old', { messages: big('a') })
    await cache.flush()
    tick(10)
    cache.putThread('mid', { messages: big('b') })
    await cache.flush()
    tick(10)
    cache.putThread('new', { messages: big('c') })
    await cache.flush()

    expect(await cache.getThread('old')).toBeUndefined()
    expect(await cache.getThread('new')).toBeDefined()
    expect(cache.stats().bytes).toBeLessThanOrEqual(1_800)
  })

  it('refuses a single thread larger than half the budget', async () => {
    const { cache } = await opened(undefined, { budgetBytes: 1_000 })
    cache.putThread('huge', { messages: messages(20, 'x'.repeat(100)) })
    await cache.flush()
    expect(await cache.getThread('huge')).toBeUndefined()
  })

  it('clear() removes every stored key', async () => {
    const { cache, storage } = await opened()
    cache.putChats([chat(1)])
    cache.putThread('1', { messages: messages(2) })
    await cache.flush()
    await cache.clear()
    expect(storage.data.size).toBe(0)
    expect(await cache.getChats()).toBeUndefined()
  })

  it('does nothing and never throws without storage or when storage fails', async () => {
    const none = new PersistentCache(undefined)
    await none.open('x')
    none.putChats([chat(1)])
    await none.flush()
    expect(await none.getChats()).toBeUndefined()

    const broken = new PersistentCache({
      getLocalStorage: async () => { throw new Error('bridge down') },
      setLocalStorage: async () => { throw new Error('bridge down') },
    }, { flushDelayMs: 1 })
    await broken.open('x')
    broken.putThread('1', { messages: messages(1) })
    await expect(broken.flush()).resolves.toBeUndefined()
    expect(await broken.getThread('1')).toBeUndefined()
  })

  it('ignores a corrupt stored index or thread', async () => {
    const storage = fakeStorage({ 'teleGlance.cache.v1.index': '{not json', 'teleGlance.cache.v1.chats': 'also bad' })
    const { cache } = await opened(storage)
    expect(await cache.getChats()).toBeUndefined()
  })

  it('waits while the user is interacting before writing', async () => {
    let quiet = false
    const storage = fakeStorage()
    const cache = new PersistentCache(storage, { flushDelayMs: 5, canWrite: () => quiet })
    await cache.open('acct')
    cache.putChats([chat(1)])
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(storage.data.has('teleGlance.cache.v1.chats')).toBe(false)
    quiet = true
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(storage.data.has('teleGlance.cache.v1.chats')).toBe(true)
  })
})

describe('cache account stamp', () => {
  it('changes with the session and is not the session itself', () => {
    const a = cacheAccountStamp({ apiId: '1', apiHash: 'h', session: 'secret-session', backend: 'https://x' })
    const b = cacheAccountStamp({ apiId: '1', apiHash: 'h', session: 'other-session', backend: 'https://x' })
    expect(a).not.toBe(b)
    expect(a).not.toContain('secret')
    expect(shortHash('x')).toHaveLength(8)
  })
})
