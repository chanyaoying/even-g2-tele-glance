import { describe, expect, it, vi } from 'vitest'
import { LruMap } from '../src/controller/lruMap'
import {
  MAX_LOADED_MESSAGES, ThreadStore, messageThreadKey, normalizeMessagePage, oldestMessageId, windowNewestMessages,
} from '../src/controller/threadStore'
import { clearUnreadForThread, hasUnreadForThread } from '../src/controller/unreadState'
import type { AppState } from '../src/controller/model'
import type { Chat, Message, Topic } from '../src/types'

const chat = (id: number, unreadCount = 0): Chat => ({ id, title: `Chat ${id}`, kind: 'group', unreadCount })
const msg = (id: number, outgoing = false): Message => ({ id, sender: outgoing ? 'Me' : 'A', text: `m${id}`, outgoing })
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i))

describe('LruMap', () => {
  it('evicts the least recently used entry, where a read counts as a use', () => {
    const map = new LruMap<string, number>(2)
    map.set('a', 1).set('b', 2)
    expect(map.get('a')).toBe(1)
    map.set('c', 3)
    expect(map.has('b')).toBe(false)
    expect([...map.keys()]).toEqual(['a', 'c'])
    expect(map.size).toBe(2)
  })

  it('does not refresh an entry on has(), and re-setting a key moves it to the newest end', () => {
    const map = new LruMap<string, number>(2)
    map.set('a', 1).set('b', 2)
    map.has('a')
    map.set('b', 20)
    map.set('c', 3)
    expect(map.has('a')).toBe(false)
    expect(map.get('b')).toBe(20)
  })

  it('rejects a limit below one', () => {
    expect(() => new LruMap(0)).toThrow()
  })
})

describe('ThreadStore', () => {
  it('keeps at most `limit` threads, forgetting the least recently used', () => {
    const store = new ThreadStore(undefined, 2)
    store.putPage({ chat: chat(1) }, [msg(1)])
    store.putPage({ chat: chat(2) }, [msg(2)])
    store.page({ chat: chat(1) })
    store.putPage({ chat: chat(3) }, [msg(3)])
    expect(store.page({ chat: chat(2) })).toBeUndefined()
    expect(store.page({ chat: chat(1) })?.messages).toEqual([msg(1)])
    store.putTopics(1, [{ id: 7, title: 't' }])
    store.putTopics(2, [])
    store.putTopics(3, [])
    expect(store.topics(1)).toBeUndefined()
  })

  it('writes pages through to the phone cache unless asked not to, keeping only the newest window', () => {
    const putThread = vi.fn()
    const store = new ThreadStore({ putThread, getThread: async () => undefined })
    const long = range(1, MAX_LOADED_MESSAGES + 10)
    const entry = store.putPage({ chat: chat(1) }, long)
    expect(entry.messages).toHaveLength(MAX_LOADED_MESSAGES)
    expect(entry.cursor).toBe(11)
    expect(putThread).toHaveBeenCalledWith('1:', entry)
    store.putPage({ chat: chat(2) }, [msg(1)], { persist: false })
    expect(putThread).toHaveBeenCalledTimes(1)
  })

  it('opens stored pages only for threads with nothing unread, and never throws on storage trouble', async () => {
    const getThread = vi.fn(async () => ({ messages: [msg(4), msg(5)] }))
    const store = new ThreadStore({ putThread: () => undefined, getThread })
    expect(await store.loadStoredPage({ chat: chat(1, 2) })).toBeUndefined()
    expect(getThread).not.toHaveBeenCalled()
    expect(await store.loadStoredPage({ chat: chat(1) })).toEqual({ messages: [msg(4), msg(5)], cursor: 4 })
    expect(store.page({ chat: chat(1) })?.cursor).toBe(4)
    const broken = new ThreadStore({ putThread: () => undefined, getThread: async () => { throw new Error('io') } })
    expect(await broken.loadStoredPage({ chat: chat(1) })).toBeUndefined()
  })

  it('flags the first unread message (skipping my own) and remembers it for refreshed pages', () => {
    const store = new ThreadStore()
    const ref = { chat: chat(1, 2) }
    const messages = [msg(1), msg(2), msg(3, true), msg(4)]
    const plan = store.planUnreadOpen(ref, messages)
    expect(plan.messages.find((m) => m.firstUnread)?.id).toBe(2)
    expect(plan.scrollOffset).toBeGreaterThanOrEqual(0)
    expect(store.hasUnreadBoundary(ref)).toBe(true)
    expect(store.flagUnread(ref, [msg(2), msg(5)])[0].firstUnread).toBe(true)
    // Opening it again with nothing unread clears the point.
    store.planUnreadOpen({ chat: chat(1) }, messages)
    expect(store.hasUnreadBoundary(ref)).toBe(false)
  })

  it('sends a read mark only when it moves forward', () => {
    const store = new ThreadStore()
    const ref = { chat: chat(1), topic: { id: 9, title: 'T' } as Topic }
    expect(store.needsReadAck(ref, 5)).toBe(true)
    store.noteReadAck(ref, 5)
    expect(store.needsReadAck(ref, 5)).toBe(false)
    expect(store.needsReadAck(ref, 4)).toBe(false)
    expect(store.needsReadAck(ref, 6)).toBe(true)
  })

  it('clearCaches drops pages and topics', () => {
    const store = new ThreadStore()
    store.putPage({ chat: chat(1) }, [msg(1)])
    store.putTopics(1, [])
    store.clearCaches()
    expect(store.page({ chat: chat(1) })).toBeUndefined()
    expect(store.topics(1)).toBeUndefined()
  })
})

describe('message page helpers', () => {
  it('normalises, keys and windows message lists', () => {
    expect(normalizeMessagePage([msg(3), msg(1), msg(3), msg(2)]).map((m) => m.id)).toEqual([1, 2, 3])
    expect(messageThreadKey({ chat: chat(5), topic: { id: 2, title: 't' } })).toBe('5:2')
    expect(messageThreadKey({ chat: chat(5) })).toBe('5:')
    const short = range(1, 3)
    expect(windowNewestMessages(short)).toBe(short)
    expect(windowNewestMessages(range(1, 10), 4).map((m) => m.id)).toEqual([7, 8, 9, 10])
    expect(oldestMessageId(range(4, 9))).toBe(4)
  })
})

describe('unread state helpers', () => {
  it('clears a chat\'s unread count in every copy of the state, including the screen to go back to', () => {
    const unread = chat(1, 3)
    const back: AppState = { screen: 'sidebar', focus: 'chats', chats: [unread, chat(2, 1)], selectedChatIndex: 0 }
    const state: AppState = {
      screen: 'sidebar', focus: 'messages', chats: [unread], selectedChatIndex: 0, chat: unread, messages: [],
      back: back as Extract<AppState, { screen: 'sidebar'; focus: 'chats' }>,
    }
    expect(hasUnreadForThread(state, unread, undefined)).toBe(true)
    const cleared = clearUnreadForThread(state, unread, undefined) as Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>
    expect(cleared.chat.unreadCount).toBe(0)
    expect(cleared.chats[0].unreadCount).toBe(0)
    expect((cleared.back as Extract<AppState, { screen: 'sidebar'; focus: 'chats' }>).chats.map((c) => c.unreadCount)).toEqual([0, 1])
    expect(hasUnreadForThread(cleared, unread, undefined)).toBe(false)
    // Nothing to clear: the same object comes back, so callers can skip a re-render.
    expect(clearUnreadForThread(cleared, unread, undefined)).toBe(cleared)
  })

  it('leaves the chat badge at the unread total of the other topics when one topic is read', () => {
    const forum = { ...chat(1, 5), isForum: true }
    const topics: Topic[] = [{ id: 1, title: 'a', unreadCount: 2 }, { id: 2, title: 'b', unreadCount: 3 }]
    const state: AppState = { screen: 'sidebar', focus: 'topics', chats: [forum], selectedChatIndex: 0, chat: forum, topics, selectedTopicIndex: 0 }
    const cleared = clearUnreadForThread(state, forum, topics[0]) as Extract<AppState, { screen: 'sidebar'; focus: 'topics' }>
    expect(cleared.topics.map((t) => t.unreadCount)).toEqual([0, 3])
    expect(cleared.chat.unreadCount).toBe(3)
  })
})
