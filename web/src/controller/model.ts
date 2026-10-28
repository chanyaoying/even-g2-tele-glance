import { isTeleGlanceFixtureMode } from '../testMode'
import type { Chat, Id, Message, Topic } from '../types'
import { getLocale } from '../locales'

const TEXT_CONTAINER_BYTE_LIMIT = 999
const MESSAGE_ROW_BYTE_LIMIT = 120
const MESSAGE_ROW_CHAR_LIMIT = 44
const MESSAGE_VISIBLE_ROW_LIMIT = 7
const MESSAGE_BOX_WIDTH = 42
const MESSAGE_BOX_CONTENT_WIDTH = MESSAGE_BOX_WIDTH - 4
const MESSAGE_BOX_CONTENT_ROWS = MESSAGE_VISIBLE_ROW_LIMIT - 4
const MESSAGE_BOX_PAD = ' '
const MESSAGE_BOX_WORD_THRESHOLD = 25
const encoder = new TextEncoder()
const messagePageCache = new WeakMap<Message[], MessageDisplayPage[]>()

/**
 * One user-visible input gesture. `eventSource` carries the raw
 * `EventSourceType` value from the underlying Even Hub event when
 * available, so the controller can distinguish user gestures
 * (`TOUCH_EVENT_FROM_GLASSES_R` is `1` on the G2) from the idle
 * system `doublePress` events that the firmware and simulator
 * emit on screen-timeout. See `AGENTS.md` "Idle doublePress
 * events on the G2 / simulator can mimic user input."
 */
export type AppInput =
  | { type: 'press'; index?: number; itemName?: string; eventSource?: number }
  | { type: 'doublePress'; index?: number; itemName?: string; eventSource?: number }
  | { type: 'swipeUp'; eventSource?: number }
  | { type: 'swipeDown'; eventSource?: number }
  | { type: 'selectIndex'; index?: number; itemName?: string; eventSource?: number }
  | { type: 'audioChunk'; pcm: Uint8Array; injected?: boolean }
  | { type: 'foreground'; eventSource?: number }

export type ScreenModel =
  | { kind: 'text'; title: string; body: string; footer?: string; box?: BoxedText }
  | { kind: 'list'; title: string; items: string[]; selectedIndex: number }
  | { kind: 'sidebar';
      title: string;
      sidebarTitle: string; sidebarItems: string[]; sidebarSelected: number;
      panelTitle: string; panelBody: string; panelFooter: string;
      panelBox?: BoxedText;
      fullWidth?: boolean;
      focus: 'sidebar' | 'panel'; }

export type BoxedText = {
  heading: string
  content: string
}

export type AppState =
  | { screen: 'loading'; message: string }
  | { screen: 'auth'; mode: 'needsSetup' | 'signedOut' | 'phonePending'; message: string; phone?: string; phoneCodeHash?: string | null; passwordRequired?: boolean }
  | { screen: 'sidebar'; focus: 'chats'; chats: Chat[]; selectedChatIndex: number; status?: string; folderLabel?: string; loadingMore?: boolean; previewMessages?: Message[]; previewCursor?: Id; previewScrollOffset?: number; previewNewerPages?: Message[][]; previewIsNewestPage?: boolean }
  | { screen: 'folderPicker'; chats: Chat[]; selectedChatIndex: number; folderLabel?: string; options: string[]; selectedIndex: number }
  | { screen: 'asleep'; chats: Chat[]; selectedChatIndex: number }
  | { screen: 'newMessage'; chat: Chat; topic?: Topic; message: string; chats: Chat[]; selectedChatIndex: number }
  | { screen: 'sidebar'; focus: 'topics';
      chats: Chat[]; selectedChatIndex: number;
      chat: Chat; topics: Topic[]; selectedTopicIndex: number;
      previewTopic?: Topic; previewMessages?: Message[];
      previewCursor?: Id; previewScrollOffset?: number;
      previewNewerPages?: Message[][]; previewIsNewestPage?: boolean; }
  | { screen: 'sidebarRecording'; focus: 'messages';
      chats: Chat[]; selectedChatIndex: number;
      chat: Chat; topic?: Topic;
      messages: Message[]; scrollOffset?: number;
      chunks: Uint8Array[]; startedAt: number;
      back?: RecoverableState; status?: string;
      newerPages?: Message[][]; isNewestPage?: boolean; typing?: { userName: string; expiresAt: number } | null; }
  | { screen: 'sidebarTranscribing'; focus: 'messages';
      chats: Chat[]; selectedChatIndex: number;
      chat: Chat; topic?: Topic;
      messages: Message[]; scrollOffset?: number;
      back?: RecoverableState; status?: string;
      newerPages?: Message[][]; isNewestPage?: boolean; typing?: { userName: string; expiresAt: number } | null; }
  | { screen: 'sidebar'; focus: 'messages';
      chats: Chat[]; selectedChatIndex: number;
      chat: Chat; topic?: Topic;
      messages: Message[]; cursor?: Id; scrollOffset?: number;
      back?: RecoverableState; status?: string;
      newerPages?: Message[][]; isNewestPage?: boolean;
      topics?: Topic[]; selectedTopicIndex?: number; typing?: { userName: string; expiresAt: number } | null; }
  | { screen: 'sidebarConfirm'; focus: 'messages';
      chats: Chat[]; selectedChatIndex: number;
      chat: Chat; topic?: Topic;
      messages: Message[]; transcript: string; selectedIndex: number;
      scrollOffset?: number; back?: RecoverableState; status?: string;
      newerPages?: Message[][]; isNewestPage?: boolean; typing?: { userName: string; expiresAt: number } | null; }
  | { screen: 'sidebarSending'; focus: 'messages';
      chats: Chat[]; selectedChatIndex: number;
      chat: Chat; topic?: Topic;
      messages: Message[]; transcript: string;
      scrollOffset?: number; back?: RecoverableState; status?: string;
      newerPages?: Message[][]; isNewestPage?: boolean; typing?: { userName: string; expiresAt: number } | null; }
  | { screen: 'sidebarSent'; focus: 'messages';
      chats: Chat[]; selectedChatIndex: number;
      chat: Chat; topic?: Topic;
      messages: Message[]; scrollOffset?: number;
      back?: RecoverableState; status?: string;
      newerPages?: Message[][]; isNewestPage?: boolean; typing?: { userName: string; expiresAt: number } | null; }
  | { screen: 'error'; message: string; previous?: RecoverableState }

export type RecoverableState = Extract<
  AppState,
  { screen: 'auth' | 'sidebar' | 'asleep' | 'newMessage' | 'sidebarConfirm' | 'sidebarSent' }
>

export function screenModel(state: AppState): ScreenModel {
  const l = getLocale()
  switch (state.screen) {
    case 'loading':
      return { kind: 'text', title: l.titleTelegram, body: state.message }
    case 'auth':
      return {
        kind: 'text',
        title: state.mode === 'phonePending' ? l.titleTelegramLogin : 'Telegram',
        body: state.message,
      }
    case 'sidebar': {
      switch (state.focus) {
        case 'chats': {
          // Full-width list with no message preview. Previews only appear on the topic screen.
          // The list is drawn into the (stable-id) panel body so the app-owned marker stays in sync.
          return {
            kind: 'sidebar',
            title: sanitizeGlassesText(state.folderLabel ?? l.titleChats),
            sidebarTitle: l.titleChats,
            sidebarItems: state.chats.map(chatLabel),
            sidebarSelected: state.selectedChatIndex,
            panelTitle: '',
            panelBody: formatFullWidthChatList(state.chats.map(chatLabel), state.selectedChatIndex),
            panelFooter: state.loadingMore ? l.statusLoadingMoreChats : (state.status ?? l.footerSwipeChats),
            fullWidth: true,
            focus: 'panel',
          }
        }
        case 'topics': {
          // The topics state shows the chat's topic list on the
          // left and a per-topic preview on the right. The preview
          // looks very similar to a full message thread (same
          // container, same body shape) which has caused users on
          // the G2 to think they're inside the message thread and
          // to swipe expecting the right panel to scroll older
          // messages — but the state is still `sidebar.topics`, so
          // the swipes actually scroll the left list. The fix is to
          // make the preview visibly distinct from the full
          // thread: prefix the title with a ">" indicator and
          // replace the existing footer wording with a more
          // emphatic "TAP TO OPEN" cue that leaves no doubt the
          // user is on a preview and needs to press to open the
          // thread. Once the thread is open the footer switches
          // to the full "Swipe scroll | Click record | Double click
          // back" copy. We deliberately keep `formatMessages` so
          // the boxed rendering path is preserved for long
          // previews (this also keeps the long-content `panelBox`
          // branch that the evenBridge renders natively).
          const previewMessages = state.previewMessages
          const previewLoaded = previewMessages !== undefined
          const scrollOffset = state.previewScrollOffset ?? 0
          const msg = previewMessages ? formatMessages(previewMessages, scrollOffset) : undefined
          const selectedTopic = state.topics[state.selectedTopicIndex]
          const topicTitle = state.previewTopic
            ? sanitizeGlassesText(state.previewTopic.title.slice(0, 18))
            : selectedTopic
              ? sanitizeGlassesText(selectedTopic.title.slice(0, 18))
              : l.titleTopics
          return {
            kind: 'sidebar',
            title: sanitizeGlassesText(state.chat.title.slice(0, 20)),
            sidebarTitle: l.titleTopics,
            sidebarItems: state.topics.map(topicLabel),
            sidebarSelected: state.selectedTopicIndex,
            // Prefix the preview title with a ">" so the user can
            // tell at a glance that the right panel is a preview
            // and not the full thread.
            panelTitle: `> ${topicTitle}`,
            panelBody: previewLoaded
              ? (msg?.box ? '' : trimUtf8Bytes(msg?.body ?? '', TEXT_CONTAINER_BYTE_LIMIT))
              : selectedTopic
                ? l.statusLoadingMessages
                : formatTopicPreviews(state.topics),
            // The footer is the primary signal. "TAP TO OPEN" is
            // unambiguous and the previous "Swipe topics" wording
            // was being misread as "the right side scrolls".
            panelFooter: previewLoaded ? l.footerTapToOpenTopic : l.statusLoadingMessages,
            panelBox: msg?.box,
            focus: 'sidebar',
          }
        }
        case 'messages': {
          const msg = formatMessages(state.messages, state.scrollOffset ?? 0)
          const loadingBody = loadingMessageBody(state.status)
          return {
            kind: 'sidebar',
            title: sanitizeGlassesText(state.topic ? state.topic.title.slice(0, 20) : state.chat.title.slice(0, 20)),
            sidebarTitle: state.topic ? l.titleTopics : l.titleChats,
            sidebarItems: state.topics?.length
              ? state.topics.map(topicLabel)
              : state.chats.map(chatLabel),
            sidebarSelected: state.topic ? (state.selectedTopicIndex ?? 0) : state.selectedChatIndex,
            panelTitle: '',
            panelBody: loadingBody ?? (msg.box ? '' : msg.body),
            // The footer MUST mention every gesture the message
            // thread accepts, otherwise the user has no way to
            // discover swipe-scrolling. Keep the labels short so
            // they still fit the 180-byte footer container; the
            // `Swipe` / `Click` / `Double click` shorthand matches
            // the chats list footer at line 139 for consistency.
            panelFooter: state.typing
              ? typingFooter(state.typing.userName, l.typingSuffix)
              : footerText(state.status, l.footerSwipeScroll),
            panelBox: loadingBody ? undefined : msg.box,
            fullWidth: true,
            focus: 'panel',
          }
        }
      }
    }
    case 'folderPicker':
      return {
        kind: 'sidebar',
        title: l.titleFolders,
        sidebarTitle: l.titleFolders,
        sidebarItems: state.options,
        sidebarSelected: state.selectedIndex,
        panelTitle: '',
        panelBody: formatFullWidthChatList(state.options, state.selectedIndex),
        panelFooter: l.footerFolderPicker,
        fullWidth: true,
        focus: 'panel',
      }
    case 'asleep':
      return {
        kind: 'text',
        title: '',
        body: '',
      }
    case 'newMessage':
      return {
        kind: 'text',
        title: l.titleNewTelegram,
        body: sanitizeGlassesText(`${state.topic ? `${state.chat.title} / ${state.topic.title}` : state.chat.title}\n\n${state.message || l.bodyNewMessage}\n\n${l.bodyClickToOpen}`),
        footer: l.footerDoubleClickDismiss,
      }
    case 'sidebarRecording': {
      const msg = formatMessages(state.messages, state.scrollOffset ?? 0)
      return {
        kind: 'sidebar',
        title: l.titleRecordingReply,
        sidebarTitle: state.topic ? l.titleTopics : l.titleChats,
        sidebarItems: state.topic ? [] : state.chats.map(chatLabel),
        sidebarSelected: state.selectedChatIndex,
        panelTitle: l.titleRecording,
        panelBody: msg.box ? '' : msg.body,
        panelFooter: footerText(state.status, l.footerClickStop),
        panelBox: msg.box,
        fullWidth: true,
        focus: 'panel',
      }
    }
    case 'sidebarTranscribing':
      return {
        kind: 'text',
        title: l.titleTranscribing,
        body: l.bodyConvertingVoice,
      }
    case 'sidebarConfirm': {
      const actions = `${state.selectedIndex === 0 ? '> ' : '  '}${l.confirmSend}\n${state.selectedIndex === 1 ? '> ' : '  '}${l.confirmCancel}`
      return {
        kind: 'text',
        title: l.titleConfirmReply,
        body: trimUtf8Bytes(`${sanitizeGlassesText(state.transcript)}\n\n${actions}`, TEXT_CONTAINER_BYTE_LIMIT),
        footer: l.footerSwipeSelect,
      }
    }
    case 'sidebarSending':
      return {
        kind: 'text',
        title: l.titleSendingReply,
        body: sanitizeGlassesText(`Sending...\n\n${state.transcript}`),
      }
    case 'sidebarSent': {
      const msg = formatMessages(state.messages, state.scrollOffset ?? 0)
      return {
        kind: 'sidebar',
        title: l.titleReplySent,
        sidebarTitle: state.topic ? l.titleTopics : l.titleChats,
        sidebarItems: state.topic ? [] : state.chats.map(chatLabel),
        sidebarSelected: state.selectedChatIndex,
        panelTitle: '',
        panelBody: msg.box ? '' : msg.body,
        // Same footer wording as the active message thread so the
        // user knows they can swipe-scroll even after sending.
        panelFooter: footerText(state.status, l.footerSwipeScroll),
        panelBox: msg.box,
        fullWidth: true,
        focus: 'panel',
      }
    }
    case 'error':
      return {
        kind: 'text',
        title: l.titleError,
        body: `${state.message}\n\nPress to retry. Double press back.`,
      }
  }
}
const CHAT_LIST_VISIBLE_ROWS = 7
const CHAT_LIST_ROW_CHARS = 44

function formatFullWidthChatList(labels: string[], selected: number): string {
  if (labels.length === 0) return ' '
  const clamped = Math.max(0, Math.min(selected, labels.length - 1))
  const start = Math.max(0, Math.min(clamped - Math.floor(CHAT_LIST_VISIBLE_ROWS / 2), labels.length - CHAT_LIST_VISIBLE_ROWS))
  const body = labels
    .slice(start, start + CHAT_LIST_VISIBLE_ROWS)
    .map((label, i) => `${start + i === clamped ? '> ' : '  '}${label.slice(0, CHAT_LIST_ROW_CHARS)}`)
    .join('\n')
  return trimUtf8Bytes(body, TEXT_CONTAINER_BYTE_LIMIT)
}

function chatLabel(chat: Chat) {
  const unread = chat.unreadCount ? ` (${chat.unreadCount})` : ''
  return sanitizeGlassesText(`${chat.title}${unread}`)
}

function formatTopicPreviews(topics: Topic[]) {
  if (topics.length === 0) return ' '
  const lines = topics.map((topic) => {
    const name = sanitizeGlassesText(topic.title.slice(0, 24))
    const preview = topic.lastMessage
      ? sanitizeGlassesText(topic.lastMessage.slice(0, 60))
      : ''
    return preview ? `${name}: ${preview}` : name
  })
  return trimUtf8Bytes(lines.join('\n'), TEXT_CONTAINER_BYTE_LIMIT)
}

function topicLabel(topic: Topic) {
  const unread = topic.unreadCount ? ` (${topic.unreadCount})` : ''
  return sanitizeGlassesText(`${topic.title}${unread}`)
}

function footerText(status: string | undefined, controls: string) {
  return sanitizeGlassesText(status ? `${localizeStatus(status)} | ${controls}` : controls)
}

function typingFooter(userName: string, suffix: string): string {
  const raw = `${userName} ${suffix}`
  if (utf8ByteLength(raw) <= MESSAGE_ROW_BYTE_LIMIT) return sanitizeGlassesText(raw)
  const suffixBytes = utf8ByteLength(` ${suffix}`)
  const maxNameBytes = MESSAGE_ROW_BYTE_LIMIT - suffixBytes
  return sanitizeGlassesText(trimUtf8Bytes(userName, maxNameBytes) + ` ${suffix}`)
}

function loadingMessageBody(status: string | undefined) {
  if (!status) return undefined
  return status.startsWith('Loading ') ? sanitizeGlassesText(localizeStatus(status)) : undefined
}

/**
 * Translate well-known English status strings from the controller into the
 * active locale. Unknown strings pass through unchanged, so custom error
 * messages and backend-provided text are never swallowed.
 */
function localizeStatus(status: string): string {
  const l = getLocale()
  return {
    'Sent': l.statusSent,
    'Older messages': l.statusOlderMessages,
    'Newer messages': l.statusNewerMessages,
    'No older messages': l.statusNoOlderMessages,
    'New reply': l.statusNewReply,
    'Loading older messages...': l.statusLoadingOlderMessages,
    'Loading messages...': l.statusLoadingMessages,
  }[status] ?? status
}
function formatMessages(messages: Message[], scrollOffset = 0) {
  const l = getLocale()
  if (messages.length === 0) return { body: trimUtf8Bytes(l.phoneNoMessages, TEXT_CONTAINER_BYTE_LIMIT) }

  const pages = messageDisplayPages(messages)
  const pageIndex = Math.max(0, Math.min(pages.length - 1, pages.length - 1 - scrollOffset))
  return pages[pageIndex]
}

export function messageScrollUnitCount(messages: Message[]) {
  return messageDisplayPages(messages).length
}

export function nextMessageScrollOffset(messages: Message[], scrollOffset = 0, direction: 'up' | 'down') {
  const pages = messageDisplayPages(messages)
  if (pages.length === 0) return 0
  const maxOffset = pages.length - 1
  const currentOffset = Math.max(0, Math.min(maxOffset, scrollOffset))
  const currentPage = pages[pages.length - 1 - currentOffset]

  if (!currentPage.boxGroupId || currentPage.boxPartIndex === undefined || currentPage.boxPartCount === undefined) {
    const nextOffset = direction === 'up'
      ? Math.min(currentOffset + 1, maxOffset)
      : Math.max(currentOffset - 1, 0)
    const nextPage = pages[pages.length - 1 - nextOffset]
    if (nextPage?.boxGroupId) {
      return offsetForBoxPart(pages, nextPage.boxGroupId, 0) ?? nextOffset
    }
    return nextOffset
  }

  const groupOffsets = boxGroupOffsets(pages, currentPage.boxGroupId)

  if (direction === 'down') {
    if (currentPage.boxPartIndex < currentPage.boxPartCount - 1) {
      return offsetForBoxPart(pages, currentPage.boxGroupId, currentPage.boxPartIndex + 1) ?? currentOffset
    }
    const newerOffset = groupOffsets[0] - 1
    if (newerOffset < 0) return currentOffset
    // Two boxed messages can now sit side by side: enter the newer one at its first part.
    const newerPage = pages[pages.length - 1 - newerOffset]
    if (newerPage?.boxGroupId) return offsetForBoxPart(pages, newerPage.boxGroupId, 0) ?? newerOffset
    return newerOffset
  }

  if (currentPage.boxPartIndex > 0) {
    return offsetForBoxPart(pages, currentPage.boxGroupId, currentPage.boxPartIndex - 1) ?? currentOffset
  }
  const olderOffset = groupOffsets[groupOffsets.length - 1] + 1
  return olderOffset <= maxOffset ? olderOffset : currentOffset
}

function offsetForBoxPart(pages: MessageDisplayPage[], boxGroupId: string, boxPartIndex: number) {
  const match = pages
    .map((page, index) => ({ page, offset: pages.length - 1 - index }))
    .find(({ page }) => page.boxGroupId === boxGroupId && page.boxPartIndex === boxPartIndex)
  return match?.offset
}

function boxGroupOffsets(pages: MessageDisplayPage[], boxGroupId: string) {
  return pages
    .map((page, index) => ({ page, offset: pages.length - 1 - index }))
    .filter(({ page }) => page.boxGroupId === boxGroupId)
    .map(({ offset }) => offset)
    .sort((a, b) => a - b)
}

function messageDisplayPages(messages: Message[]): MessageDisplayPage[] {
  const cached = messagePageCache.get(messages)
  if (cached) return cached

  const blocks = messageDisplayBlocks(messages)
  const pages: MessageDisplayPage[] = []
  let endExclusive = blocks.length

  while (endExclusive > 0) {
    const selected: MessageDisplayBlock[] = []
    let start = endExclusive

    for (let index = endExclusive - 1; index >= 0; index -= 1) {
      const block = blocks[index]
      if (block.box) {
        if (selected.length === 0) {
          selected.unshift(block)
          start = index
        }
        break
      }

      const candidate = [block, ...selected]
      if (lineCount(candidate) > MESSAGE_VISIBLE_ROW_LIMIT) break
      if (utf8ByteLength(candidate.map((item) => item.text).join('\n')) > TEXT_CONTAINER_BYTE_LIMIT) break

      selected.unshift(block)
      start = index
    }

    if (selected.length === 0) {
      selected.unshift({ text: trimUtf8Bytes(blocks[endExclusive - 1].text, TEXT_CONTAINER_BYTE_LIMIT) })
      start = endExclusive - 1
    }

    pages.unshift(formatPage(selected))
    endExclusive = start
  }

  messagePageCache.set(messages, pages)
  return pages
}

type MessageDisplayPage = {
  body: string
  box?: BoxedText
  boxGroupId?: string
  boxPartIndex?: number
  boxPartCount?: number
}

function messageDisplayBlocks(messages: Message[]): MessageDisplayBlock[] {
  const blocks: MessageDisplayBlock[] = []
  for (let i = 0; i < messages.length; i++) {
    // No blank separator row: the timestamp in each header already separates messages, and the fixed
    // firmware font means every row saved is room for more text.
    blocks.push(...formatMessageBlocks(messages[i]))
  }
  return blocks
}

type MessageDisplayBlock = {
  text: string
  box?: BoxedText
  boxGroupId?: string
  boxPartIndex?: number
  boxPartCount?: number
  gap?: true
}

function formatMessageBlocks(message: Message): MessageDisplayBlock[] {
  const l = getLocale()
  const sender = sanitizeGlassesText(message.outgoing ? l.senderMe : message.sender || l.senderUnknown)
  const text = sanitizeGlassesText(message.text || '').trim() || l.messageUnsupported
  const header = withTimestamp(sender, message.sentAt)
  if (wordCount(text) > MESSAGE_BOX_WORD_THRESHOLD) return formatMessageBox(String(message.id), header, text)

  return [{ text: formatCompactMessageRows(header, text).join('\n') }]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "14:32" for today, "Oct 27 14:32" for other days (device local time). Empty when unknown. */
export function formatMessageTime(sentAt: string | null | undefined, now: Date = new Date()): string {
  // Fixture runs (simulator goldens) must not depend on the machine's timezone or clock.
  if (!sentAt || isTeleGlanceFixtureMode()) return ''
  const date = new Date(sentAt)
  if (Number.isNaN(date.getTime())) return ''
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  return sameDay ? clock : `${MONTHS[date.getMonth()]} ${date.getDate()} ${clock}`
}

function withTimestamp(sender: string, sentAt: string | null | undefined) {
  const time = formatMessageTime(sentAt)
  return time ? `${sender} ${time}` : sender
}

function formatCompactMessageRows(sender: string, text: string) {
  const firstPrefix = `${sender}: `
  const firstRows = splitDisplayWordRows(
    text,
    Math.max(1, MESSAGE_ROW_CHAR_LIMIT - firstPrefix.length),
    Math.max(1, MESSAGE_ROW_BYTE_LIMIT - utf8ByteLength(firstPrefix)),
  )
  const [firstRow = '', ...rest] = firstRows
  const rows = [`${firstPrefix}${firstRow}`]
  for (const row of rest) {
    rows.push(...splitDisplayWordRows(row, MESSAGE_ROW_CHAR_LIMIT - 2, MESSAGE_ROW_BYTE_LIMIT - 2).map((part) => `  ${part}`))
  }
  return rows
}
function formatMessageBox(messageId: string, sender: string, text: string): MessageDisplayBlock[] {
  const topBorder = `+${'-'.repeat(MESSAGE_BOX_WIDTH - 2)}+`
  const midBorder = `+${'-'.repeat(MESSAGE_BOX_WIDTH - 2)}+`
  const bottomBorder = `+${'-'.repeat(MESSAGE_BOX_WIDTH - 2)}+`
  const rows = splitBoxRows(text)
  const pages: MessageDisplayBlock[] = []
  const partCount = Math.ceil(rows.length / MESSAGE_BOX_CONTENT_ROWS)
  const boxGroupId = `${messageId}:${sender}:${text}`
  for (let index = 0; index < rows.length; index += MESSAGE_BOX_CONTENT_ROWS) {
    const pageRows = rows.slice(index, index + MESSAGE_BOX_CONTENT_ROWS)
    const partIndex = Math.floor(index / MESSAGE_BOX_CONTENT_ROWS)
    const pageNumber = rows.length > MESSAGE_BOX_CONTENT_ROWS ? ` ${partIndex + 1}/${partCount}` : ''
    const heading = trimBoxText(`${sender}${pageNumber}`)
    const content = pageRows.join(' ')
    pages.push({
      text: [
        topBorder,
        boxLine(heading),
        midBorder,
        ...pageRows.map((row) => boxLine(row)),
        bottomBorder,
      ].join('\n'),
      box: {
        heading,
        content,
      },
      boxGroupId,
      boxPartIndex: partIndex,
      boxPartCount: partCount,
    })
  }
  return pages.reverse()
}

function sanitizeGlassesText(value: string) {
  const l = getLocale()
  let result = value
    .replace(/\u{1f534}/gu, l.sanitizeRed)
    .replace(/\u{1f7e1}/gu, l.sanitizeYellow)
    .replace(/\u{1f7e2}/gu, l.sanitizeGreen)
    // Heavy exclamation (U+2757) and warning sign (U+26A0) emit LVGL `glyph dsc. not found`
    // warnings on the Even Hub simulator. Strip them rather than render unsupported glyphs.
    .replace(/[\u{2757}\u{26a0}]/gu, '')
    .replace(/[\u{1f000}-\u{1faff}]/gu, '')
    .replace(/\ufe0f/g, '')
  // CJK character set stripping — the Even Hub firmware only supports basic Latin
  // glyphs. UI strings are already in Rōmaji/Romaja/Pīnyīn for ja/ko/zh locales,
  // but Telegram message content and chat/topic names may still carry CJK characters
  // that produce LVGL `glyph dsc. not found` warnings. Strip the full CJK block
  // when the locale requests transliteration fallback.
  if (l._cjkTransliterate) {
    result = result
      // CJK Unified Ideographs (U+4E00–U+9FFF): Chinese, Japanese kanji, Korean hanja
      .replace(/[\u{4e00}-\u{9fff}]/gu, '')
      // CJK Unified Ideographs Extension A (U+3400–U+4DBF)
      .replace(/[\u{3400}-\u{4dbf}]/gu, '')
      // Hiragana (U+3040–U+309F)
      .replace(/[\u{3040}-\u{309f}]/gu, '')
      // Katakana (U+30A0–U+30FF)
      .replace(/[\u{30a0}-\u{30ff}]/gu, '')
      // Hangul Syllables (U+AC00–U+D7AF)
      .replace(/[\u{ac00}-\u{d7af}]/gu, '')
      // CJK Compatibility Ideographs (U+F900–U+FAFF)
      .replace(/[\u{f900}-\u{faff}]/gu, '')
      // CJK Symbols and Punctuation (U+3000–U+303F)
      .replace(/[\u{3000}-\u{303f}]/gu, '')
      // Fullwidth forms (U+FF00–U+FFEF)
      .replace(/[\u{ff00}-\u{ffef}]/gu, '')
      // Hangul Jamo (U+1100–U+11FF)
      .replace(/[\u{1100}-\u{11ff}]/gu, '')
      // Bopomofo (U+3100–U+312F)
      .replace(/[\u{3100}-\u{312f}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return result
}

function boxLine(value: string) {
  const padding = MESSAGE_BOX_PAD.repeat(Math.max(0, MESSAGE_BOX_CONTENT_WIDTH - value.length))
  return `| ${value}${padding} |`
}

function trimBoxText(value: string) {
  if (value.length <= MESSAGE_BOX_CONTENT_WIDTH) return value
  return `${value.slice(0, MESSAGE_BOX_CONTENT_WIDTH - 3)}...`
}

function splitBoxRows(value: string) {
  return splitDisplayWordRows(value, MESSAGE_BOX_CONTENT_WIDTH, MESSAGE_ROW_BYTE_LIMIT).map(trimBoxText)
}

function lineCount(blocks: MessageDisplayBlock[]) {
  const content = blocks.filter((block, i) => {
    if (!block.gap) return true
    return i > 0 && i < blocks.length - 1
  })
  if (content.length === 0) return 0
  return content.map((block) => block.text).join('\n').split('\n').length
}

function wordCount(value: string) {
  return value.trim().split(/\s+/).filter(Boolean).length
}

function formatPage(blocks: MessageDisplayBlock[]): MessageDisplayPage {
  const content = blocks.filter((block, i) => {
    if (!block.gap) return true
    return i > 0 && i < blocks.length - 1
  })
  return {
    body: content.map((block) => block.text).join('\n'),
    box: content.length === 1 ? content[0].box : undefined,
    boxGroupId: content.length === 1 ? content[0].boxGroupId : undefined,
    boxPartIndex: content.length === 1 ? content[0].boxPartIndex : undefined,
    boxPartCount: content.length === 1 ? content[0].boxPartCount : undefined,
  }
}

function utf8ByteLength(value: string) {
  return encoder.encode(value).byteLength
}

function trimUtf8Bytes(value: string, maxBytes: number) {
  if (maxBytes <= 0) return ''
  if (utf8ByteLength(value) <= maxBytes) return value

  const suffix = '...'
  const contentLimit = Math.max(0, maxBytes - utf8ByteLength(suffix))
  let output = ''
  for (const char of value) {
    const candidate = output + char
    if (utf8ByteLength(candidate) > contentLimit) break
    output = candidate
  }
  return `${output}${suffix}`
}

function splitDisplayRows(value: string, prefix: string, maxChars = MESSAGE_ROW_CHAR_LIMIT, maxBytes = MESSAGE_ROW_BYTE_LIMIT) {
  if (value.length === 0) return ['']
  const chunks: string[] = []
  let chunk = ''
  const byteLimit = Math.max(1, maxBytes - utf8ByteLength(prefix))
  const charLimit = Math.max(1, maxChars - prefix.length)
  for (const char of value) {
    const candidate = chunk + char
    if (chunk.length > 0 && (candidate.length > charLimit || utf8ByteLength(candidate) > byteLimit)) {
      chunks.push(chunk)
      chunk = char
      continue
    }
    chunk = candidate
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}

function splitDisplayWordRows(value: string, maxChars: number, maxBytes: number) {
  const words = value.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const rows: string[] = []
  let row = ''
  for (const word of words) {
    if (row.length === 0) {
      if (word.length <= maxChars && utf8ByteLength(word) <= maxBytes) {
        row = word
      } else {
        const chunks = splitDisplayRows(word, '', maxChars, maxBytes)
        rows.push(...chunks.slice(0, -1))
        row = chunks[chunks.length - 1] ?? ''
      }
      continue
    }

    const candidate = `${row} ${word}`
    if (candidate.length <= maxChars && utf8ByteLength(candidate) <= maxBytes) {
      row = candidate
      continue
    }
    rows.push(row)
    if (word.length <= maxChars && utf8ByteLength(word) <= maxBytes) {
      row = word
    } else {
      const chunks = splitDisplayRows(word, '', maxChars, maxBytes)
      rows.push(...chunks.slice(0, -1))
      row = chunks[chunks.length - 1] ?? ''
    }
  }
  if (row.length > 0) rows.push(row)
  return rows
}
