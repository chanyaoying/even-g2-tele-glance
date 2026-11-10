import { isTeleGlanceFixtureMode } from '../testMode'
import type { Chat, Id, Message, Topic } from '../types'
import { getLocale } from '../locales'
import { GLASSES_DEFAULT_GLYPH_WIDTH, GLASSES_GLYPH_WIDTHS, GLASSES_ROW_PITCH_PX } from '../glassesFont'

const TEXT_CONTAINER_BYTE_LIMIT = 999
const MESSAGE_ROW_BYTE_LIMIT = 120
/** Characters per message row in character mode (unit tests and the simulator fixture flow). */
let MESSAGE_ROW_CHAR_LIMIT = 44
/**
 * Pixel mode (the real app): rows are wrapped by their measured width in the glasses font instead of by character
 * count, so lines use the whole screen whatever the letters are. `fontScale` corrects the measured widths if the
 * real glasses font turns out wider (>1) or narrower (<1) than the simulator's; undefined = character mode.
 */
const ROW_TEXT_WIDTH_PX = 556
let fontScale: number | undefined
export function setGlassesFontWidthPercent(percent: number | undefined) {
  const next = percent === undefined ? undefined : Math.max(70, Math.min(150, Math.round(percent) || 100)) / 100
  if (next === fontScale) return
  fontScale = next
  resetMessageCaches()
}
export function setMessageRowChars(chars: number) {
  const next = Math.max(36, Math.min(80, Math.round(chars) || 44))
  if (next === MESSAGE_ROW_CHAR_LIMIT) return
  MESSAGE_ROW_CHAR_LIMIT = next
  resetMessageCaches()
}
function resetMessageCaches() {
  messagePageCache = new WeakMap()
  messageBlocksCache = new WeakMap()
  perMessageBlocks = new WeakMap()
}
/** Estimated width in px of `value` on the glasses (pixel mode), from the simulator-measured glyph advances. */
export function glassesTextWidthPx(value: string): number {
  let total = 0
  for (const char of value) total += GLASSES_GLYPH_WIDTHS[char] ?? GLASSES_DEFAULT_GLYPH_WIDTH
  return total * (fontScale ?? 1)
}
/** Whether `candidate` fits one row after a prefix that already takes `prefixPx`. */
function rowFits(candidate: string, maxChars: number, maxBytes: number, prefixPx: number): boolean {
  if (utf8ByteLength(candidate) > maxBytes) return false
  if (fontScale === undefined) return candidate.length <= maxChars
  return prefixPx + glassesTextWidthPx(candidate) <= ROW_TEXT_WIDTH_PX
}
/** Cut `value` to one row after a prefix of `prefixPx` (character mode: `maxChars` characters), ending in ".." if cut. */
function clipToRow(value: string, maxChars: number, prefixPx: number): string {
  if (rowFits(value, maxChars, Number.MAX_SAFE_INTEGER, prefixPx)) return value
  let out = ''
  for (const char of value) {
    if (!rowFits(`${out}${char}..`, maxChars, Number.MAX_SAFE_INTEGER, prefixPx)) break
    out += char
  }
  return `${out}..`
}
// A photo page puts the text in a narrow left column (about 282 px) and the picture on the right.
const MESSAGE_VISIBLE_ROW_LIMIT = 7
const encoder = new TextEncoder()
let messagePageCache = new WeakMap<Message[], MessageDisplayPage[]>()

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
  | { type: 'longPress'; eventSource?: number }
  | { type: 'longPressRelease'; eventSource?: number }
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
      panelImage?: PanelImage;
      popup?: PopupOverlay;
      fullWidth?: boolean;
      focus: 'sidebar' | 'panel'; }

/**
 * A picture shown inline with the messages: the text leaves a blank gap and the picture container sits over it.
 * The controller fetches the pixels and sends them to the glasses.
 */
export type PanelImage = {
  chatId: string
  messageId: string
  /** Text rows above the gap in the visible page; positions the picture vertically. */
  topLine: number
}

/** Blank text rows reserved for a picture, and the picture size that fits them (rows are ~26 px tall). */
export const INLINE_IMAGE_GAP_ROWS = 5
export const INLINE_IMAGE_HEIGHT = 120
export const INLINE_IMAGE_WIDTH = 288
/** Measured in the simulator's glasses framebuffer (the probe in scripts/simulator-flow.mjs); the real glasses are unverified. */
export const MESSAGE_ROW_HEIGHT_PX = GLASSES_ROW_PITCH_PX

/** A dialog drawn over the page (a bordered container stacked above everything else). */
export type PopupOverlay = {
  title: string
  body: string
}

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
      /** Shown above the transcript when the last send attempt failed; Send retries it. */
      sendError?: string;
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

/** Short glasses statuses without locale entries yet: shown as-is (English fallback) until locales add them. */
export const DIDNT_CATCH_STATUS = "Didn't catch that"
export const UPDATING_STATUS = 'Updating...'

type MessagesState = Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>
type ThreadSource = Extract<AppState, { focus: 'messages' }>

/**
 * The message view for a thread-carrying state (recording, transcribing, confirm, sending, sent...).
 * Copies the thread fields across so every "return to the thread" path stays in one place;
 * `overrides` replaces any of them (for example `status`, `messages`, `scrollOffset`).
 */
export function backToMessages(state: ThreadSource, overrides: Partial<MessagesState> = {}): MessagesState {
  return {
    screen: 'sidebar', focus: 'messages',
    chats: state.chats, selectedChatIndex: state.selectedChatIndex,
    chat: state.chat,
    topic: state.topic,
    messages: state.messages,
    back: state.back,
    status: state.status,
    newerPages: state.newerPages,
    isNewestPage: state.isNewestPage,
    scrollOffset: state.scrollOffset,
    typing: state.typing,
    ...overrides,
  }
}

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
              : footerText(state.status, scrollControls(state.scrollOffset ?? 0)),
            panelBox: loadingBody ? undefined : msg.box,
            panelImage: loadingBody || !msg.imageMessageId
              ? undefined
              : { chatId: String(state.chat.id), messageId: msg.imageMessageId, topLine: msg.imageTopLine ?? 0 },
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
        title: `REC ${l.titleRecordingReply}`,
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
      // A dialog over the thread: the conversation stays visible underneath (as plain text; the native
      // box container would collide with the dialog).
      const msg = formatMessages(state.messages, state.scrollOffset ?? 0)
      const send = `${state.selectedIndex === 0 ? '> ' : '  '}${l.confirmSend}`
      const cancel = `${state.selectedIndex === 1 ? '> ' : '  '}${l.confirmCancel}`
      return {
        kind: 'sidebar',
        title: state.topic ? state.topic.title.slice(0, 20) : state.chat.title.slice(0, 20),
        sidebarTitle: state.topic ? l.titleTopics : l.titleChats,
        sidebarItems: state.topic ? [] : state.chats.map(chatLabel),
        sidebarSelected: state.selectedChatIndex,
        panelTitle: '',
        panelBody: msg.body,
        panelFooter: l.footerSwipeSelect,
        fullWidth: true,
        focus: 'panel',
        popup: {
          title: l.titleConfirmReply,
          body: `${state.sendError ? `${sanitizeGlassesText(localizeStatus(state.sendError))}\n` : ''}${clampTranscript(sanitizeGlassesText(state.transcript))}\n\n${send}\n${cancel}`,
        },
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

function formatFullWidthChatList(labels: string[], selected: number): string {
  if (labels.length === 0) return ' '
  const clamped = Math.max(0, Math.min(selected, labels.length - 1))
  const start = Math.max(0, Math.min(clamped - Math.floor(CHAT_LIST_VISIBLE_ROWS / 2), labels.length - CHAT_LIST_VISIBLE_ROWS))
  const body = labels
    .slice(start, start + CHAT_LIST_VISIBLE_ROWS)
    .map((label, i) => `${start + i === clamped ? '> ' : '  '}${clipToRow(label, MESSAGE_ROW_CHAR_LIMIT - 2, glassesTextWidthPx('> '))}`)
    .join('\n')
  return trimUtf8Bytes(body, TEXT_CONTAINER_BYTE_LIMIT)
}

// The unread count leads the label: the glasses cut long labels at the end, and the count is the part that matters.
function chatLabel(chat: Chat) {
  const unread = chat.unreadCount ? `(${chat.unreadCount}) ` : ''
  return sanitizeGlassesText(`${unread}${chat.title}`)
}

const POPUP_TRANSCRIPT_CHARS = 110

/** Keep a long transcript inside the dialog (about three rows); the full text is still what gets sent. */
function clampTranscript(text: string) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= POPUP_TRANSCRIPT_CHARS ? flat : `${flat.slice(0, POPUP_TRANSCRIPT_CHARS - 3).trimEnd()}...`
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
  const unread = topic.unreadCount ? `(${topic.unreadCount}) ` : ''
  return sanitizeGlassesText(`${unread}${topic.title}`)
}

/** While scrolled back, lead the controls with how far from the newest message the view is. */
function scrollControls(scrollOffset: number) {
  const l = getLocale()
  return scrollOffset > 0 ? `${l.statusNewerCount.replace('{n}', String(scrollOffset))} | ${l.footerSwipeScroll}` : l.footerSwipeScroll
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

  // Continuous scrolling: one page per block, each a window of blocks that ends at that block. A swipe
  // therefore moves the view by a single message instead of jumping a whole screenful.
  // Per-block line and byte counts, so growing a window costs a few additions instead of re-joining text.
  const blockLines = blocks.map((block) => block.text.split('\n').length)
  const blockBytes = blocks.map((block) => utf8ByteLength(block.text))
  for (let endExclusive = 1; endExclusive <= blocks.length; endExclusive += 1) {
    const selected: MessageDisplayBlock[] = []
    let linesAll = 0
    let bytesAll = 0

    for (let index = endExclusive - 1; index >= 0; index -= 1) {
      const block = blocks[index]
      if (block.box) {
        if (selected.length === 0) selected.unshift(block)
        break
      }

      // Same limits as measuring the joined candidate: gap blocks at either end of a page take no row.
      const count = endExclusive - index
      const nextLinesAll = linesAll + blockLines[index]
      const nextBytesAll = bytesAll + blockBytes[index] + (count > 1 ? 1 : 0)
      let lines = nextLinesAll
      const first = blocks[index]
      const last = blocks[endExclusive - 1]
      if (first.gap) lines -= blockLines[index]
      if (count > 1 && last.gap) lines -= blockLines[endExclusive - 1]
      if (lines > MESSAGE_VISIBLE_ROW_LIMIT) break
      if (nextBytesAll > TEXT_CONTAINER_BYTE_LIMIT) break

      linesAll = nextLinesAll
      bytesAll = nextBytesAll
      selected.unshift(block)
    }

    if (selected.length === 0) {
      selected.unshift({ text: trimUtf8Bytes(blocks[endExclusive - 1].text, TEXT_CONTAINER_BYTE_LIMIT) })
    }

    pages.push(formatPage(selected))
  }

  messagePageCache.set(messages, pages)
  return pages
}

type MessageDisplayPage = {
  body: string
  imageMessageId?: string
  /** Text rows above the picture gap within this page's body. */
  imageTopLine?: number
  box?: BoxedText
  boxGroupId?: string
  boxPartIndex?: number
  boxPartCount?: number
}

let messageBlocksCache = new WeakMap<Message[], MessageDisplayBlock[]>()
// Formatting one message is pure in (message, day label, locale), so keep the result with the message
// object: loading an older page then only formats the new messages, not the whole loaded thread again.
let perMessageBlocks = new WeakMap<Message, { locale: unknown; byDay: Map<string, MessageDisplayBlock[]> }>()

function blocksForMessage(message: Message, dayLabel: string): MessageDisplayBlock[] {
  const locale = getLocale()
  let entry = perMessageBlocks.get(message)
  if (!entry || entry.locale !== locale) {
    entry = { locale, byDay: new Map() }
    perMessageBlocks.set(message, entry)
  }
  let blocks = entry.byDay.get(dayLabel)
  if (!blocks) {
    blocks = formatMessageBlocks(message, dayLabel)
    entry.byDay.set(dayLabel, blocks)
  }
  return blocks
}

function messageDisplayBlocks(messages: Message[]): MessageDisplayBlock[] {
  const cachedBlocks = messageBlocksCache.get(messages)
  if (cachedBlocks && cachedBlocks.length > 0) return cachedBlocks
  const blocks: MessageDisplayBlock[] = []
  const now = new Date()
  for (let i = 0; i < messages.length; i++) {
    // No blank separator row: the time at the start of each line already separates messages, and the
    // fixed firmware font means every row saved is room for more text.
    const startsDay = i === 0 || dayKey(messages[i].sentAt) !== dayKey(messages[i - 1].sentAt)
    const dayLabel = startsDay ? formatDayLabel(messages[i].sentAt, now) : ''
    if (messages[i].firstUnread) blocks.push({ text: `----- ${getLocale().dividerLastRead} -----` })
    const id = String(messages[i].id)
    blocks.push(...blocksForMessage(messages[i], dayLabel).map((block) => ({ ...block, messageId: id })))
  }
  messageBlocksCache.set(messages, blocks)
  return blocks
}

/** How many blocks past the divider the opening view reaches, so a few unread messages show below it. */
const UNREAD_LOOKAHEAD_BLOCKS = 2

/** Scroll offset that opens a thread at its "last read" divider, or 0 when no message is flagged. */
export function unreadScrollOffset(messages: Message[]): number {
  if (!messages.some((message) => message.firstUnread)) return 0
  const blocks = messageDisplayBlocks(messages)
  const flagged = String(messages.find((message) => message.firstUnread)!.id)
  let last = -1
  blocks.forEach((block, index) => { if (block.messageId === flagged) last = index })
  if (last < 0) return 0
  const anchor = Math.min(blocks.length - 1, last + UNREAD_LOOKAHEAD_BLOCKS)
  return blocks.length - 1 - anchor
}

/** The message at the bottom of the view for a scroll offset (used to keep a place across refreshes). */
export function anchorMessageId(messages: Message[], scrollOffset: number): string | undefined {
  const blocks = messageDisplayBlocks(messages)
  for (let index = blocks.length - 1 - scrollOffset; index >= 0; index -= 1) {
    if (blocks[index]?.messageId) return blocks[index].messageId
  }
  return undefined
}

/** Scroll offset that puts the given message at the bottom of the view, if it is loaded. */
export function offsetForAnchorMessage(messages: Message[], messageId: string): number | undefined {
  const blocks = messageDisplayBlocks(messages)
  let last = -1
  blocks.forEach((block, index) => { if (block.messageId === messageId) last = index })
  return last < 0 ? undefined : blocks.length - 1 - last
}

type MessageDisplayBlock = {
  text: string
  messageId?: string
  /** Index of the first picture-gap row inside this block's text. */
  imageGapLine?: number
  imageMessageId?: string
  box?: BoxedText
  boxGroupId?: string
  boxPartIndex?: number
  boxPartCount?: number
  gap?: true
}

function formatMessageBlocks(message: Message, dayLabel = ''): MessageDisplayBlock[] {
  const l = getLocale()
  const sender = sanitizeGlassesText(message.outgoing ? l.senderMe : message.sender || l.senderUnknown)
  const text = sanitizeGlassesText(message.text || '').trim() || l.messageUnsupported
  const time = formatMessageTime(message.sentAt)
  if (message.service) {
    // Join/leave/pin notices: one centred-looking divider row with the full sentence, no sender or time.
    const rows = splitDisplayWordRows(text, MESSAGE_ROW_CHAR_LIMIT - 6, MESSAGE_ROW_BYTE_LIMIT - 6, glassesTextWidthPx('-- ') + glassesTextWidthPx(' --'))
      .map((row, index, all) => (all.length === 1 ? `-- ${row} --` : index === 0 ? `-- ${row}` : `   ${row}`))
    if (dayLabel) rows.unshift(`----- ${dayLabel} -----`)
    return [{ text: rows.slice(0, MESSAGE_VISIBLE_ROW_LIMIT).join('\n') }]
  }
  const before = messageHeaderRows(message)
  if (message.media === 'photo' || message.media === 'sticker') {
    // The picture flows with the conversation. A page holds 7 rows and the picture needs 5 blank ones, so only 2 text
    // rows fit beside it. The whole caption is kept: the caption reads as ordinary text pages and the picture appears
    // on the last page, beside the final 2 caption rows (a short caption is just one page with its picture).
    const captionRows = formatCompactMessageRows(time ? `${time} ${sender}` : sender, text)
    const lead: string[] = []
    if (dayLabel) lead.push(`----- ${dayLabel} -----`)
    else if (before.length > 0) lead.push(before[0])
    const allRows = [...lead, ...captionRows]
    const beside = MESSAGE_VISIBLE_ROW_LIMIT - INLINE_IMAGE_GAP_ROWS
    // Never leave a lone divider/header row on a page of its own: keep one more caption row with it.
    const keep = allRows.length <= beside ? allRows.length : allRows.length - beside <= lead.length ? allRows.length - lead.length - 1 : beside
    const textRows = allRows.slice(0, allRows.length - keep)
    const pictureRows = [...allRows.slice(allRows.length - keep), ...Array.from({ length: INLINE_IMAGE_GAP_ROWS }, () => ' ')]
    const blocks: MessageDisplayBlock[] = []
    for (let start = 0; start < textRows.length; start += MESSAGE_VISIBLE_ROW_LIMIT) {
      blocks.push({ text: textRows.slice(start, start + MESSAGE_VISIBLE_ROW_LIMIT).join('\n') })
    }
    blocks.push({ text: pictureRows.join('\n'), imageMessageId: String(message.id), imageGapLine: pictureRows.length - INLINE_IMAGE_GAP_ROWS })
    return blocks
  }

  const rows = formatCompactMessageRows(time ? `${time} ${sender}` : sender, message.poll ? `Poll: ${text}` : text)
  if (message.poll) rows.splice(2) // the question never needs more than two rows
  const used = rows.length + before.length + (dayLabel ? 1 : 0)
  rows.unshift(...before)
  if (message.poll) rows.push(...pollRows(message.poll, MESSAGE_VISIBLE_ROW_LIMIT - used))
  else if (message.link) rows.push(...linkRows(message.link, MESSAGE_VISIBLE_ROW_LIMIT - used))
  // The divider is part of the day's first message block, so it can never be split from that message.
  if (dayLabel) rows.unshift(`----- ${dayLabel} -----`)
  // A message taller than one page is cut into page-sized blocks, so it scrolls like the rest of the thread.
  const blocks: MessageDisplayBlock[] = []
  for (let start = 0; start < rows.length; start += MESSAGE_VISIBLE_ROW_LIMIT) {
    blocks.push({ text: rows.slice(start, start + MESSAGE_VISIBLE_ROW_LIMIT).join('\n') })
  }
  return blocks
}

function clipRow(value: string, indent = ''): string {
  const clean = sanitizeGlassesText(value).replace(/\s+/g, ' ').trim()
  return indent + clipToRow(clean, MESSAGE_ROW_CHAR_LIMIT - indent.length, glassesTextWidthPx(indent))
}

/** "Fwd: Bob" and "> Alice: quoted text" rows shown above a message (each exactly one row). */
function messageHeaderRows(message: Message): string[] {
  const rows: string[] = []
  if (message.forwardedFrom) rows.push(clipRow(`Fwd: ${message.forwardedFrom}`))
  if (message.replyTo) {
    const who = message.replyTo.sender ? `${message.replyTo.sender}: ` : ''
    rows.push(clipRow(`> ${who}${message.replyTo.preview ?? ''}`))
  }
  return rows
}

/** Title and "domain - description" rows for a link preview, limited to the rows left on the page. */
function linkRows(link: NonNullable<Message['link']>, room: number): string[] {
  const rows: string[] = []
  const title = link.title ?? ''
  const detail = [link.domain, link.description].filter(Boolean).join(' - ')
  if (title) rows.push(clipRow(title, '  > '))
  if (detail) rows.push(clipRow(detail, '    '))
  return rows.slice(0, Math.max(0, room))
}

/** Option rows ("  [x] Pizza 75%") plus a votes footer, squeezed into the rows left on the page. */
function pollRows(poll: NonNullable<Message['poll']>, room: number): string[] {
  const footerParts = [
    poll.totalVoters != null ? `${poll.totalVoters} ${poll.totalVoters === 1 ? 'vote' : 'votes'}` : '',
    poll.quiz ? 'quiz' : '',
    poll.multiple ? 'multi' : '',
    poll.closed ? 'closed' : '',
  ].filter(Boolean)
  const footer = footerParts.length > 0 ? [clipRow(footerParts.join(' - '), '  ')] : []
  const optionRoom = Math.max(1, room - footer.length)
  const shown = poll.options.length > optionRoom ? poll.options.slice(0, optionRoom - 1) : poll.options
  const rows = shown.map((option) => {
    const mark = option.chosen ? '[x]' : option.correct ? '[+]' : '[ ]'
    const suffix = option.percent != null ? ` ${option.percent}%` : ''
    const room = MESSAGE_ROW_CHAR_LIMIT - 2 - mark.length - 1 - suffix.length
    const label = sanitizeGlassesText(option.text).replace(/\s+/g, ' ').trim()
    const clipped = clipToRow(label, room, glassesTextWidthPx(`  ${mark} ${suffix}`))
    return `  ${mark} ${clipped}${suffix}`
  })
  if (shown.length < poll.options.length) rows.push(`  +${poll.options.length - shown.length} more`)
  return [...rows, ...footer]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function parseSentAt(sentAt: string | null | undefined): Date | undefined {
  // Fixture runs (simulator goldens) must not depend on the machine's timezone or clock.
  if (!sentAt || isTeleGlanceFixtureMode()) return undefined
  const date = new Date(sentAt)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** "14:32" in the device's local time (24-hour). Empty when unknown. */
export function formatMessageTime(sentAt: string | null | undefined): string {
  const date = parseSentAt(sentAt)
  if (!date) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function dayKey(sentAt: string | null | undefined): string {
  const date = parseSentAt(sentAt)
  return date ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : ''
}

/** "Today", "Yesterday", "Mon 26 Oct" (or with the year for other years). Empty when unknown. */
export function formatDayLabel(sentAt: string | null | undefined, now: Date = new Date()): string {
  const date = parseSentAt(sentAt)
  if (!date) return ''
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const label = `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`
  return date.getFullYear() === now.getFullYear() ? label : `${label} ${date.getFullYear()}`
}

/** One row: "14:32 Alice: caption [photo]", shortening the caption (never the [photo]/[sticker] tag) to fit. */
function formatCompactMessageRows(sender: string, text: string) {
  const firstPrefix = `${sender}: `
  const firstRows = splitDisplayWordRows(
    text,
    Math.max(1, MESSAGE_ROW_CHAR_LIMIT - firstPrefix.length),
    Math.max(1, MESSAGE_ROW_BYTE_LIMIT - utf8ByteLength(firstPrefix)),
    glassesTextWidthPx(firstPrefix),
  )
  const [firstRow = '', ...rest] = firstRows
  const rows = [`${firstPrefix}${firstRow}`]
  for (const row of rest) {
    rows.push(...splitDisplayWordRows(row, MESSAGE_ROW_CHAR_LIMIT - 2, MESSAGE_ROW_BYTE_LIMIT - 2, glassesTextWidthPx('  ')).map((part) => `  ${part}`))
  }
  return rows
}
/**
 * The glasses font has no emoji. Common ones become a short text equivalent (":+1:", ":<3:"), every other one
 * becomes "[emoji]" (a run of them collapses to one), so a message is never blank or silently missing something.
 */
const EMOJI_TEXT: Record<string, string> = {
  '😀': 'grin', '😃': 'grin', '😄': 'grin', '😁': 'grin', '😆': 'laugh', '😂': 'joy', '🤣': 'rofl', '😊': 'smile', '🙂': 'smile', '😉': 'wink',
  '😍': 'heart_eyes', '🥰': 'love', '😘': 'kiss', '😎': 'cool', '🤔': 'thinking', '😐': 'neutral', '😢': 'cry', '😭': 'sob', '😞': 'sad', '🙁': 'sad', '☹': 'sad',
  '😡': 'angry', '😠': 'angry', '😮': 'open_mouth', '😱': 'scream', '😴': 'zzz', '😅': 'sweat_smile', '🙃': 'upside_down', '😜': 'wink_tongue', '😛': 'tongue', '🤗': 'hug',
  '👍': '+1', '👎': '-1', '👌': 'ok', '🙏': 'pray', '👏': 'clap', '🙌': 'raised_hands', '💪': 'muscle', '👋': 'wave', '✌': 'peace',
  '❤': '<3', '♥': '<3', '💕': '<3', '💖': '<3', '💗': '<3', '💙': '<3', '💚': '<3', '💛': '<3', '🧡': '<3', '💜': '<3', '🖤': '<3', '💔': '</3',
  '🔥': 'fire', '✨': 'sparkles', '⭐': 'star', '🌟': 'star', '🎉': 'tada', '🎂': 'cake', '💯': '100', '✅': 'check', '✔': 'check',
  '❌': 'x', '❎': 'x', '👀': 'eyes', '🤝': 'handshake', '☀': 'sun', '🌙': 'moon', '☕': 'coffee', '🍕': 'pizza', '🍺': 'beer', '🎁': 'gift',
  '😳': 'flushed', '🤦': 'facepalm', '🤷': 'shrug', '😇': 'angel', '😈': 'devil', '🤩': 'star_struck', '🥳': 'party', '🤞': 'crossed_fingers',
}
const EMOJI_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\ufe0f|\u{1f3fb}-\u{1f3ff}|[\u{1f3fb}-\u{1f3ff}])*(?:\u200d(?:\p{Extended_Pictographic})(?:\ufe0f|[\u{1f3fb}-\u{1f3ff}])*)*/gu

export function emojiToText(value: string): string {
  let sawEmoji = false
  const replaced = value.replace(EMOJI_RE, (match) => {
    const base = Array.from(match)[0] ?? ''
    // (c), (r), (tm) and similar old symbols are pictographic too but are ordinary text.
    if ((base.codePointAt(0) ?? 0) < 0x2300) return match
    sawEmoji = true
    const name = EMOJI_TEXT[base]
    return ` ${name ? `:${name}:` : '[emoji]'} `
  })
  if (!sawEmoji) return value
  return replaced.replace(/(\[emoji\]\s*){2,}/g, '[emoji] ').replace(/[ \t]{2,}/g, ' ').replace(/^ | $/g, '')
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
  result = emojiToText(result)
    .replace(/\ufe0f/g, '')
    // The glasses font has no backtick (LVGL: glyph not found), so use the apostrophe.
    .replace(/`/g, "'")
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

function formatPage(blocks: MessageDisplayBlock[]): MessageDisplayPage {
  const content = blocks.filter((block, i) => {
    if (!block.gap) return true
    return i > 0 && i < blocks.length - 1
  })
  let imageMessageId: string | undefined
  let imageTopLine: number | undefined
  let linesBefore = 0
  for (const block of content) {
    if (block.imageMessageId !== undefined && imageMessageId === undefined) {
      imageMessageId = block.imageMessageId
      imageTopLine = linesBefore + (block.imageGapLine ?? 0)
    }
    linesBefore += block.text.split('\n').length
  }
  return {
    body: content.map((block) => block.text).join('\n'),
    imageMessageId,
    imageTopLine,
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

function splitDisplayRows(value: string, prefix: string, maxChars = MESSAGE_ROW_CHAR_LIMIT, maxBytes = MESSAGE_ROW_BYTE_LIMIT, prefixPx = 0) {
  if (value.length === 0) return ['']
  const chunks: string[] = []
  let chunk = ''
  const byteLimit = Math.max(1, maxBytes - utf8ByteLength(prefix))
  const charLimit = Math.max(1, maxChars - prefix.length)
  for (const char of value) {
    const candidate = chunk + char
    if (chunk.length > 0 && !rowFits(candidate, charLimit, byteLimit, prefixPx)) {
      chunks.push(chunk)
      chunk = char
      continue
    }
    chunk = candidate
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}

function splitDisplayWordRows(value: string, maxChars: number, maxBytes: number, prefixPx = 0) {
  const words = value.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const rows: string[] = []
  let row = ''
  const startRowWith = (word: string) => {
    if (rowFits(word, maxChars, maxBytes, prefixPx)) {
      row = word
      return
    }
    const chunks = splitDisplayRows(word, '', maxChars, maxBytes, prefixPx)
    rows.push(...chunks.slice(0, -1))
    row = chunks[chunks.length - 1] ?? ''
  }
  for (const word of words) {
    if (row.length === 0) {
      startRowWith(word)
      continue
    }
    const candidate = `${row} ${word}`
    if (rowFits(candidate, maxChars, maxBytes, prefixPx)) {
      row = candidate
      continue
    }
    rows.push(row)
    startRowWith(word)
  }
  if (row.length > 0) rows.push(row)
  return rows
}
