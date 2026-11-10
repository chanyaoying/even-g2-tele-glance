import type { Chat, Topic } from '../types'
import type { AppState, RecoverableState } from './model'

/*
 * Unread counts live in several copies inside an AppState (the chat list, the open chat, its topics, the
 * screen to go back to). These pure helpers read and clear them for one thread consistently.
 */

export function clearUnreadForThread(state: AppState, chat: Chat, topic: Topic | undefined): AppState {
  const remainingTopicUnread = topic ? remainingUnreadForOtherTopics(state, topic) : undefined
  let changed = false
  const updateBack = (back: RecoverableState | undefined) => {
    if (!back) return back
    const nextBack = clearUnreadForThread(back, chat, topic) as RecoverableState
    if (nextBack !== back) changed = true
    return nextBack
  }
  const updateChat = (item: Chat) => {
    if (String(item.id) !== String(chat.id)) return item
    if (!item.unreadCount) return item
    if (!topic) {
      changed = true
      return { ...item, unreadCount: 0 }
    }
    const nextUnread = remainingTopicUnread ?? 0
    if (item.unreadCount === nextUnread) return item
    changed = true
    return { ...item, unreadCount: nextUnread }
  }
  const updateTopic = (item: Topic) => {
    if (String(item.id) !== String(topic?.id) || !item.unreadCount) return item
    changed = true
    return { ...item, unreadCount: 0 }
  }
  const maybePreviewTopic = (item: Topic | undefined) => {
    if (!item || String(item.id) !== String(topic?.id) || !item.unreadCount) return item
    changed = true
    return { ...item, unreadCount: 0 }
  }

  let next: AppState
  switch (state.screen) {
    case 'sidebar':
      if (state.focus === 'topics') {
        next = {
          ...state,
          chats: state.chats.map(updateChat),
          chat: updateChat(state.chat),
          topics: state.topics.map(updateTopic),
          previewTopic: maybePreviewTopic(state.previewTopic),
        }
        break
      }
      if (state.focus === 'messages') {
        next = {
          ...state,
          chats: state.chats.map(updateChat),
          chat: updateChat(state.chat),
          topic: maybePreviewTopic(state.topic),
          topics: state.topics?.map(updateTopic),
          back: updateBack(state.back),
        }
        break
      }
      next = { ...state, chats: state.chats.map(updateChat) }
      break
    case 'asleep':
      next = { ...state, chats: state.chats.map(updateChat) }
      break
    case 'newMessage':
      next = { ...state, chats: state.chats.map(updateChat), chat: updateChat(state.chat), topic: maybePreviewTopic(state.topic) }
      break
    case 'sidebarRecording':
    case 'sidebarTranscribing':
    case 'sidebarConfirm':
    case 'sidebarSending':
    case 'sidebarSent':
      next = {
        ...state,
        chats: state.chats.map(updateChat),
        chat: updateChat(state.chat),
        topic: maybePreviewTopic(state.topic),
        back: updateBack(state.back),
      }
      break
    default:
      return state
  }
  return changed ? next : state
}

export function hasUnreadForThread(state: AppState, chat: Chat, topic: Topic | undefined) {
  if (topic) return unreadForTopic(state, topic) > 0
  return unreadForChat(state, chat) > 0
}

function unreadForChat(state: AppState, chat: Chat) {
  const values: number[] = []
  const collect = (item: Chat | undefined) => {
    if (item && String(item.id) === String(chat.id)) values.push(Number(item.unreadCount ?? 0) || 0)
  }
  switch (state.screen) {
    case 'sidebar':
      state.chats.forEach(collect)
      if (state.focus === 'topics' || state.focus === 'messages') collect(state.chat)
      break
    case 'asleep':
      state.chats.forEach(collect)
      break
    case 'newMessage':
      state.chats.forEach(collect)
      collect(state.chat)
      break
    case 'sidebarRecording':
    case 'sidebarTranscribing':
    case 'sidebarConfirm':
    case 'sidebarSending':
    case 'sidebarSent':
      state.chats.forEach(collect)
      collect(state.chat)
      break
    default:
      break
  }
  return Math.max(0, ...values)
}

function unreadForTopic(state: AppState, topic: Topic) {
  const values: number[] = []
  const collect = (item: Topic | undefined) => {
    if (item && String(item.id) === String(topic.id)) values.push(Number(item.unreadCount ?? 0) || 0)
  }
  if (state.screen === 'sidebar' && state.focus === 'topics') {
    state.topics.forEach(collect)
    collect(state.previewTopic)
  }
  if (state.screen === 'sidebar' && state.focus === 'messages') {
    state.topics?.forEach(collect)
    collect(state.topic)
  }
  if (
    state.screen === 'newMessage' ||
    state.screen === 'sidebarRecording' ||
    state.screen === 'sidebarTranscribing' ||
    state.screen === 'sidebarConfirm' ||
    state.screen === 'sidebarSending' ||
    state.screen === 'sidebarSent'
  ) {
    collect(state.topic)
  }
  return Math.max(0, ...values)
}

function remainingUnreadForOtherTopics(state: AppState, topic: Topic) {
  const topics = state.screen === 'sidebar' && (state.focus === 'topics' || state.focus === 'messages')
    ? state.topics
    : undefined
  if (!topics) return undefined
  return topics
    .filter((item) => String(item.id) !== String(topic.id))
    .reduce((total, item) => total + Math.max(0, Number(item.unreadCount ?? 0) || 0), 0)
}
