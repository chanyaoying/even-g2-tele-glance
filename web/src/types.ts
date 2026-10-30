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
