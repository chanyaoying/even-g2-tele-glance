export type Id = string | number

export type AuthStatus = {
  configured?: boolean
  authorized: boolean
}

export type PhoneAuthStart = {
  phone: string
  sent: boolean
  message?: string | null
  phoneCodeHash?: string | null
}

export type PhoneAuthStatus = {
  authorized: boolean
  message?: string | null
  sessionString?: string | null
  passwordRequired?: boolean
}

export type Chat = {
  id: Id
  title: string
  kind: 'user' | 'group' | 'channel'
  unreadCount?: number
  isForum?: boolean
  lastMessage?: string | null
}

export type Folder = {
  id: Id
  title: string
}

export type Topic = {
  id: Id
  title: string
  topMessageId?: Id
  unreadCount?: number
  lastMessage?: string | null
}

export type Message = {
  id: Id
  sender?: string | null
  text: string
  sentAt?: string | null
  outgoing?: boolean
  /** "photo" or "sticker" when the message carries a picture the glasses can show inline. */
  media?: string | null
  /** Set locally on the oldest unread message when a thread is opened; drives the "last read" divider. */
  firstUnread?: boolean
  /** The message this one replies to (sender and a short preview of it). */
  replyTo?: { messageId: number | string; sender?: string | null; preview?: string } | null
  /** Who a forwarded message originally came from. */
  forwardedFrom?: string | null
  poll?: MessagePoll | null
  /** Link-preview card shown under the message text. */
  link?: { title?: string | null; domain?: string | null; description?: string | null } | null
}

export type MessagePoll = {
  question: string
  options: Array<{ text: string; percent?: number | null; voters?: number | null; chosen?: boolean; correct?: boolean }>
  totalVoters?: number | null
  closed?: boolean
  quiz?: boolean
  multiple?: boolean
}

export type Photo = {
  width: number
  height: number
  /** Base64 greyscale PNG already fitted to the glasses image container. */
  data: string
}

export type TelegramUpdate = {
  type: 'message'
  chatId: Id
  topicId?: Id | null
  message: Message
}

export type TelegramTypingUpdate = {
  type: 'typing'
  chatId: Id
  topicId?: Id | null
  userName?: string | null
  action: 'typing' | 'cancel'
}

export type SendMessageRequest = {
  text: string
  topicId?: Id
}

export type MarkReadRequest = {
  topicId?: Id
  maxId?: Id
}

export type SendMessageResponse = {
  id: Id
  status: 'sent'
}

export type TranscriptionResult = {
  text: string
  language?: string
}
