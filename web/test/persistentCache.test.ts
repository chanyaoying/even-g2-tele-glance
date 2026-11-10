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

  it('does not delete expired threads during open() (it runs before the first page), only at the next flush', async () => {
    const { cache, storage } = await opened(undefined, { maxAgeMs: 10_000 })
    cache.putThread('1', { messages: messages(2) })
    await cache.flush()
    const threadKey = [...storage.data.keys()].find((key) => key.includes('.t.'))!
    const writes: string[] = []
    const watched = { ...storage, setLocalStorage: async (key: string, value: string) => { writes.push(key); return storage.setLocalStorage(key, value) } }

    const later = new PersistentCache(watched, { flushDelayMs: 1, maxAgeMs: 10_000, now: () => 1_000 + 20_000 })
    await later.open('acct')
    expect(writes).toEqual([])
    expect(await later.getThread('1')).toBeUndefined()
    await later.flush()
    expect(storage.data.has(threadKey)).toBe(false)
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

  describe('forum topic lists', () => {
    const topicList = (count: number, label = 'Topic') => Array.from({ length: count }, (_, i) => ({ id: String(i + 1), title: `${label} ${i + 1}` }))

    it('stores a topic list and reads it back after reopening, counted in the budget', async () => {
      const { cache, storage } = await opened()
      cache.putTopics('5', topicList(3))
      await cache.flush()
      expect(cache.stats().bytes).toBeGreaterThan(0)

      const again = new PersistentCache(storage, { flushDelayMs: 1, now: () => 1_000 })
      await again.open('acct')
      expect((await again.getTopics('5'))?.map((t) => t.title)).toEqual(['Topic 1', 'Topic 2', 'Topic 3'])
      expect(await again.getTopics('6')).toBeUndefined()
    })

    it('forgets topic lists on clear(), on another account and after the maximum age', async () => {
      const { cache, storage } = await opened(undefined, { maxAgeMs: 10_000 })
      cache.putTopics('5', topicList(2))
      await cache.flush()

      const later = new PersistentCache(storage, { flushDelayMs: 1, maxAgeMs: 10_000, now: () => 1_000 + 20_000 })
      await later.open('acct')
      expect(await later.getTopics('5')).toBeUndefined()

      const fresh = await opened(fakeStorage())
      fresh.cache.putTopics('5', topicList(2))
      await fresh.cache.flush()
      const other = new PersistentCache(fresh.storage, { flushDelayMs: 1, now: () => 1_000 })
      await other.open('someone-else')
      expect(await other.getTopics('5')).toBeUndefined()
      expect(fresh.storage.data.size).toBe(0)

      const cleared = await opened(fakeStorage())
      cleared.cache.putTopics('5', topicList(2))
      await cleared.cache.flush()
      await cleared.cache.clear()
      expect(cleared.storage.data.size).toBe(0)
    })

    it('evicts the least recently used topic lists and threads together to stay in budget', async () => {
      const { cache, tick } = await opened(undefined, { budgetBytes: 1_800 })
      cache.putTopics('old', topicList(8, 'a'.repeat(60)))
      await cache.flush()
      tick(10)
      cache.putThread('mid', { messages: messages(8, 'b'.repeat(40)) })
      await cache.flush()
      tick(10)
      cache.putTopics('new', topicList(8, 'c'.repeat(60)))
      await cache.flush()

      expect(await cache.getTopics('old')).toBeUndefined()
      expect(await cache.getTopics('new')).toBeDefined()
      expect(cache.stats().bytes).toBeLessThanOrEqual(1_800)
    })
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

  describe('photos', () => {
    const photo = (tag: string) => ({ width: 288, height: 120, format: 'png', data: tag.repeat(100) })

    it('keeps pictures across a restart and forgets them on clear', async () => {
      const { cache, storage } = await opened()
      cache.putPhoto('1:10', photo('a'))
      await cache.flush()

      const again = new PersistentCache(storage, { flushDelayMs: 1, now: () => 1_000 })
      await again.open('acct')
      expect((await again.getPhoto('1:10'))?.data).toBe('a'.repeat(100))
      expect(await again.getPhoto('1:11')).toBeUndefined()

      await again.clear()
      expect(await again.getPhoto('1:10')).toBeUndefined()
      expect([...storage.data.keys()].filter((key) => key.includes('.p.'))).toEqual([])
    })

    it('drops the least recently used pictures when over the photo budget, without touching threads', async () => {
      const { cache, tick } = await opened(fakeStorage(), { photoBudgetBytes: 1_000 })
      cache.putThread('1', { messages: messages(2) })
      for (const key of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
        cache.putPhoto(key, photo(key))
        tick(10)
        await cache.flush()
      }
      expect(cache.photoStats().bytes).toBeLessThanOrEqual(1_000)
      expect(await cache.getPhoto('a')).toBeUndefined()
      expect(await cache.getPhoto('h')).toBeDefined()
      expect(await cache.getThread('1')).toBeDefined()
    })

    it('does not show another account the stored pictures', async () => {
      const { cache, storage } = await opened()
      cache.putPhoto('1:10', photo('a'))
      await cache.flush()
      const other = new PersistentCache(storage, { flushDelayMs: 1, now: () => 1_000 })
      await other.open('someone-else')
      expect(await other.getPhoto('1:10')).toBeUndefined()
    })
  })
})
