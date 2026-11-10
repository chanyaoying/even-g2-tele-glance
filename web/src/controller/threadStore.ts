import type { PersistentCache } from '../cache/persistentCache'
import type { Chat, Id, Message, Topic } from '../types'
import { LruMap } from './lruMap'
import { unreadScrollOffset } from './model'

/** Threads (chat or forum topic) whose latest page, topics, unread point and read mark are kept in memory. */
export const THREAD_CACHE_LIMIT = 50
/**
 * The most messages kept for one thread once the user is back at the newest message. Scrolling up loads older
 * pages without limit (the view needs them), but returning to the bottom drops all but this many, so a long
 * reading session does not keep the whole history (and its page layout) in memory.
 */
export const MAX_LOADED_MESSAGES = 240

export type ThreadRef = { chat: Chat; topic?: Topic }
export type ThreadEntry = { messages: Message[]; cursor?: Id }

/**
 * In-memory knowledge about message threads, every map capped at THREAD_CACHE_LIMIT threads (least recently
 * used goes first):
 * - the latest page of each thread (the single source for opening a thread instantly and for topic previews),
 *   written through to the on-phone cache;
 * - the topic list of each forum chat;
 * - where a thread's unread messages start (the "last read" divider) while it is being read from there;
 * - the newest message id already acknowledged as read, so the same read mark is not sent twice.
 */
export class ThreadStore {
  private readonly pages: LruMap<string, ThreadEntry>
  private readonly topicLists: LruMap<string, Topic[]>
  private readonly unreadBoundaries: LruMap<string, string>
  private readonly readAckMaxIds: LruMap<string, Id>

  constructor(
    private readonly persistent?: Pick<PersistentCache, 'getThread' | 'putThread'>,
    limit = THREAD_CACHE_LIMIT,
  ) {
    this.pages = new LruMap(limit)
    this.topicLists = new LruMap(limit)
    this.unreadBoundaries = new LruMap(limit)
    this.readAckMaxIds = new LruMap(limit)
  }

  /** The cached latest page of a thread. */
  page(ref: ThreadRef): ThreadEntry | undefined {
    return this.pages.get(messageThreadKey(ref))
  }

  /**
   * Remember a thread's latest messages (only the newest MAX_LOADED_MESSAGES), and store them on the phone unless
   * `persist` is false (topic previews are only kept in memory).
   */
  putPage(ref: ThreadRef, messages: Message[], options: { persist?: boolean } = {}): ThreadEntry {
    const kept = windowNewestMessages(messages)
    const key = messageThreadKey(ref)
    const entry = { messages: kept, cursor: oldestMessageId(kept) }
    this.pages.set(key, entry)
    if (options.persist !== false) this.persistent?.putThread(key, entry)
    return entry
  }

  /**
   * The last stored page of a thread, for opening it instantly while a fresh page is fetched. Only used for
   * threads with nothing unread: the "last read" divider depends on the unread count, which a stale page
   * cannot place correctly. Never throws; storage trouble just means a fetch.
   */
  async loadStoredPage(ref: ThreadRef): Promise<ThreadEntry | undefined> {
    if (!this.persistent || (ref.topic ?? ref.chat).unreadCount) return undefined
    const key = messageThreadKey(ref)
    const stored = await this.persistent.getThread(key).catch(() => undefined)
    if (!stored || stored.messages.length === 0) return undefined
    const entry = { messages: stored.messages, cursor: stored.cursor ?? oldestMessageId(stored.messages) }
    this.pages.set(key, entry)
    return entry
  }

  topics(chatId: Id): Topic[] | undefined {
    return this.topicLists.get(String(chatId))
  }

  putTopics(chatId: Id, topics: Topic[]) {
    this.topicLists.set(String(chatId), topics)
  }

  /**
   * Work out where this thread's unread messages start, flag that message (it gets the "last read" divider) and
   * return where the view should open. Unread messages are the newest incoming ones, so the Nth incoming message
   * from the newest is the first unread. If more are unread than are loaded the start cannot be found and the
   * thread opens at the newest message.
   */
  planUnreadOpen(ref: ThreadRef, messages: Message[]): { messages: Message[]; scrollOffset: number } {
    const key = messageThreadKey(ref)
    const unread = Number((ref.topic ? ref.topic.unreadCount : ref.chat.unreadCount) ?? 0) || 0
    this.unreadBoundaries.delete(key)
    if (unread <= 0) return { messages, scrollOffset: 0 }
    let seen = 0
    let firstUnread: Message | undefined
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].outgoing) continue
      seen += 1
      if (seen === unread) {
        firstUnread = messages[index]
        break
      }
    }
    if (!firstUnread) return { messages, scrollOffset: 0 }
    this.unreadBoundaries.set(key, String(firstUnread.id))
    const flagged = this.flagUnread(ref, messages)
    return { messages: flagged, scrollOffset: unreadScrollOffset(flagged) }
  }

  /** Re-apply the "last read" flag to a freshly fetched message list. */
  flagUnread(ref: ThreadRef, messages: Message[]): Message[] {
    const id = this.unreadBoundaries.get(messageThreadKey(ref))
    if (!id) return messages
    return messages.map((message) => (String(message.id) === id ? { ...message, firstUnread: true } : message))
  }

  hasUnreadBoundary(ref: ThreadRef) {
    return this.unreadBoundaries.has(messageThreadKey(ref))
  }

  /** True unless a read mark at or after `maxId` was already sent for this thread. */
  needsReadAck(ref: ThreadRef, maxId: Id) {
    const previous = this.readAckMaxIds.get(messageThreadKey(ref))
    return previous === undefined || !idAtOrAfter(previous, maxId)
  }

  noteReadAck(ref: ThreadRef, maxId: Id) {
    this.readAckMaxIds.set(messageThreadKey(ref), maxId)
  }

  /** Forget the cached pages and topic lists (unread points and read marks stay: they describe this session). */
  clearCaches() {
    this.pages.clear()
    this.topicLists.clear()
  }
}

export function topicThreadId(topic: Topic | undefined) {
  return topic?.id
}

export function messageThreadKey(state: ThreadRef) {
  return `${String(state.chat.id)}:${String(topicThreadId(state.topic) ?? '')}`
}

/** The newest MAX_LOADED_MESSAGES of a sorted message list (the same array when it is short enough). */
export function windowNewestMessages(messages: Message[], limit = MAX_LOADED_MESSAGES): Message[] {
  return messages.length > limit ? messages.slice(messages.length - limit) : messages
}

/** De-duplicate by id and sort oldest first. */
export function normalizeMessagePage(messages: Message[]) {
  const byId = new Map<string, Message>()
  for (const message of messages) byId.set(String(message.id), message)
  return [...byId.values()].sort(compareMessages)
}

function compareMessages(left: Message, right: Message) {
  const leftId = Number(left.id)
  const rightId = Number(right.id)
  if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
    return leftId - rightId
  }

  const leftTime = left.sentAt ? Date.parse(left.sentAt) : Number.NaN
  const rightTime = right.sentAt ? Date.parse(right.sentAt) : Number.NaN
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime
  }

  return String(left.id).localeCompare(String(right.id))
}

export function oldestMessageId(messages: { id: string | number }[]) {
  if (messages.length === 0) return undefined
  const numericIds = messages.map((message) => Number(message.id)).filter(Number.isFinite)
  if (numericIds.length === messages.length) return Math.min(...numericIds)
  return messages[messages.length - 1]?.id
}

export function newestMessageId(messages: { id: string | number }[]) {
  if (messages.length === 0) return undefined
  const numericIds = messages.map((message) => Number(message.id)).filter(Number.isFinite)
  if (numericIds.length === messages.length) return Math.max(...numericIds)
  return messages[messages.length - 1]?.id
}

export function hasMessageChanges(current: Message[], next: Message[]) {
  if (current.length !== next.length) return true
  return current.some((message, index) => {
    const nextMessage = next[index]
    return !nextMessage || String(message.id) !== String(nextMessage.id) || message.text !== nextMessage.text
  })
}

export function hasIncomingChange(current: Message[], next: Message[]) {
  const currentIds = new Set(current.map((message) => String(message.id)))
  return next.some((message) => !message.outgoing && !currentIds.has(String(message.id)))
}

export function idAtOrAfter(previous: Id, next: Id) {
  const previousNumber = Number(previous)
  const nextNumber = Number(next)
  if (Number.isFinite(previousNumber) && Number.isFinite(nextNumber)) return previousNumber >= nextNumber
  return String(previous) === String(next)
}
