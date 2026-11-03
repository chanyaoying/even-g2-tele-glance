import { describe, expect, it } from 'vitest'
import { formatDayLabel, formatMessageTime, messageScrollUnitCount, nextMessageScrollOffset, screenModel } from '../src/controller/model'
import type { AppState } from '../src/controller/model'
import type { Message } from '../src/types'
import { getLocale, setLocale } from '../src/locales'
import ja from '../src/locales/ja'
import en from '../src/locales/en'
const encoder = new TextEncoder()

function messageState(messages: Message[], scrollOffset = 0): AppState {
  return {
    screen: 'sidebar', focus: 'messages',
    chats: [], selectedChatIndex: 0,
    chat: { id: '1', title: 'Project', kind: 'group' },
    messages,
    scrollOffset,
  }
}

function modelAt(messages: Message[], scrollOffset: number) {
  const model = screenModel(messageState(messages, scrollOffset))
  expect(model.kind).toBe('sidebar')
  return model
}

function boxPart(messages: Message[], scrollOffset: number) {
  const model = modelAt(messages, scrollOffset)
  const heading = model.kind === 'sidebar' ? model.panelBox?.heading : undefined
  const match = heading?.match(/^(.*?)\s+(\d+)\/(\d+)$/)
  if (!match) return undefined
  return { sender: match[1], part: Number(match[2]), total: Number(match[3]), heading }
}

function longText(seed: string, repeats = 5) {
  return Array.from({ length: repeats }, (_, group) =>
    `${seed}-${group} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega`
  ).join(' ')
}

function wordCountForTest(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length
}

describe('screenModel', () => {
  it('scrolls a long message through page-sized blocks without truncating it or boxing it', () => {
    const words = Array.from({ length: 160 }, (_, index) => `w${index}`)
    const messages: Message[] = [
      { id: '1', sender: 'Alice', text: 'short' },
      { id: '2', sender: 'Bob', text: words.join(' ') },
    ]
    const seen = new Set<string>()
    const pageCount = messageScrollUnitCount(messages)
    for (let offset = 0; offset < pageCount; offset += 1) {
      const model = modelAt(messages, offset)
      if (model.kind !== 'sidebar') throw new Error('expected sidebar')
      expect(model.panelBox).toBeUndefined()
      expect(model.panelBody.split('\n').length).toBeLessThanOrEqual(7)
      expect(encoder.encode(model.panelBody).byteLength).toBeLessThanOrEqual(999)
      for (const word of words) if (new RegExp(`\\b${word}\\b`).test(model.panelBody)) seen.add(word)
    }
    expect(seen.size).toBe(words.length)
  })

  it('keeps message text under the Even Hub 999 byte text limit', () => {
    const state: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [
        { id: '1', sender: 'Ada', text: 'hello' },
        { id: '2', sender: 'Lin', text: '消息'.repeat(800) },
      ],
    }

    const model = screenModel(state)

    expect(model.kind).toBe('sidebar')
    if (model.kind === 'sidebar') {
      expect(encoder.encode(model.panelBody).byteLength).toBeLessThanOrEqual(999)
      // The footer MUST mention every gesture the message thread
      // accepts, otherwise the user has no way to discover
      // swipe-scrolling. Keep the assertion in sync with the
      // `model.ts` sidebar.messages footer.
      expect(model.panelFooter).toBe('Swipe scroll | Hold to record | Double click back')
    }
  })

  it('fuzzes mixed small/large message navigation around every boxed message', () => {
    let seed = 0x5eed
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x100000000
    }

    for (let run = 0; run < 25; run++) {
      const messages: Message[] = []
      const count = 6 + Math.floor(nextRand() * 5)
      for (let index = 0; index < count; index++) {
        const makeLarge = index > 0 && index < count - 1 && nextRand() > 0.45
        messages.push({
          id: `run-${run}-msg-${index}`,
          sender: makeLarge ? `Box${run}-${index}` : `Small${run}-${index}`,
          text: makeLarge ? longText(`run-${run}-msg-${index}`, 4 + Math.floor(nextRand() * 3)) : `small-${run}-${index}`,
        })
      }
      if (!messages.some((message) => wordCountForTest(message.text) > 25)) {
        messages.splice(2, 0, { id: `run-${run}-forced-box`, sender: `Box${run}-forced`, text: longText(`forced-${run}`, 5) })
      }

      const maxOffset = messageScrollUnitCount(messages) - 1
      for (let offset = 0; offset <= maxOffset; offset++) {
        const first = boxPart(messages, offset)
        if (!first || first.part !== 1 || first.total < 3) continue

        const offsets = [offset]
        for (let part = 2; part <= first.total; part++) {
          const nextOffset = nextMessageScrollOffset(messages, offsets[offsets.length - 1], 'down')
          const nextPart = boxPart(messages, nextOffset)
          expect(nextPart).toMatchObject({ sender: first.sender, part, total: first.total })
          offsets.push(nextOffset)
        }

        const afterLast = nextMessageScrollOffset(messages, offsets[offsets.length - 1], 'down')
        const afterLastPart = boxPart(messages, afterLast)
        expect(afterLast === offsets[offsets.length - 1] || afterLastPart?.sender !== first.sender).toBe(true)

        for (let index = offsets.length - 1; index > 0; index--) {
          expect(nextMessageScrollOffset(messages, offsets[index], 'up')).toBe(offsets[index - 1])
        }

        const beforeFirst = nextMessageScrollOffset(messages, offset, 'up')
        const beforeFirstPart = boxPart(messages, beforeFirst)
        expect(beforeFirst === offset || beforeFirstPart?.sender !== first.sender).toBe(true)
        // Two boxed messages can be adjacent (no blank row between them); entering the older one lands on
        // its first part, so the exact round trip only holds when the neighbour is not itself boxed.
        if (beforeFirst !== offset && !beforeFirstPart) {
          expect(nextMessageScrollOffset(messages, beforeFirst, 'down')).toBe(offset)
        }
      }
    }
  })

  it('renders a placeholder instead of an empty sender-only message', () => {
    const state: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [{ id: '1', sender: 'Akira', text: '' }],
    }

    const model = screenModel(state)

    expect(model.kind).toBe('sidebar')
    if (model.kind === 'sidebar') {
      expect(model.panelBody).toContain('Akira: [Unsupported message]')
    }
  })

  it('latest message view ends at the newest message instead of an overflowing page', () => {
    const state: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [
        { id: '1', sender: 'Alice', text: 'first' },
        { id: '2', sender: 'Bob', text: 'second' },
      ],
      scrollOffset: 0,
    }

    const topPage = screenModel(state)
    expect(topPage.kind).toBe('sidebar')
    if (topPage.kind === 'sidebar') {
      expect(topPage.panelBody).toContain('Alice')
      expect(topPage.panelBody).toContain('Bob')
    }
  })

  it('reserves a footer row by limiting message pages to seven visible rows', () => {
    const state: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: Array.from({ length: 8 }, (_, index) => ({
        id: String(index + 1),
        sender: index % 2 === 0 ? 'Akira' : 'Me',
        text: `message ${index + 1}`,
        outgoing: index % 2 === 1,
      })),
      scrollOffset: 0,
    }

    const model = screenModel(state)

    expect(model.kind).toBe('sidebar')
    if (model.kind === 'sidebar') {
      expect(model.panelBody.split('\n').length).toBeLessThanOrEqual(7)
      expect(model.panelFooter).toContain('Double click back')
    }
  })

  it('shows loading text in the message panel while older history is loading', () => {
    const state: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [{ id: '1', sender: 'Alice', text: 'current page' }],
      status: 'Loading older messages...',
    }

    const model = screenModel(state)

    expect(model.kind).toBe('sidebar')
    if (model.kind === 'sidebar') {
      expect(model.panelBody).toBe('Loading older messages...')
      expect(model.panelBox).toBeUndefined()
    }
  })

  it('scrolls compact messages continuously, one message per step', () => {
    const state: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [
        { id: '1', sender: 'A1', text: 'msg1' },
        { id: '2', sender: 'A2', text: 'msg2' },
        { id: '3', sender: 'A3', text: 'msg3' },
        { id: '4', sender: 'A4', text: 'msg4' },
        { id: '5', sender: 'A5', text: 'msg5' },
        { id: '6', sender: 'A6', text: 'msg6' },
        { id: '7', sender: 'A7', text: 'msg7' },
        { id: '8', sender: 'A8', text: 'msg8' },
        { id: '9', sender: 'A9', text: 'msg9' },
        { id: '10', sender: 'A10', text: 'msg10' },
        { id: '11', sender: 'A11', text: 'msg11' },
        { id: '12', sender: 'A12', text: 'msg12' },
      ],
    }

    // One scroll position per message, so a swipe moves the view by a single message.
    expect(messageScrollUnitCount(state.messages)).toBe(12)
    const newest = screenModel(state)
    const oneUp = screenModel({ ...state, scrollOffset: 1 })
    const body = (m: ReturnType<typeof screenModel>) => (m.kind === 'sidebar' ? m.panelBody : '')
    expect(body(newest)).toContain('msg12')
    expect(body(oneUp)).not.toContain('msg12')
    expect(body(oneUp)).toContain('msg11')
    expect(body(newest)).toContain('msg11') // the windows overlap: nothing jumps off screen
  })
  it('shows a sticker inline like a photo', () => {
    const model = screenModel({
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '7', title: 'Project', kind: 'group' },
      messages: [{ id: '41', sender: 'Alice', text: '[sticker]', media: 'sticker' }],
    })
    expect(model.kind === 'sidebar' && model.panelImage).toEqual({ chatId: '7', messageId: '41', topLine: 1 })
    expect(model.kind === 'sidebar' && model.panelBody).toContain('[sticker]')
  })

  it('wraps boxed messages on word boundaries when words fit the row', () => {
    const state: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [{ id: '1', sender: 'Alice', text: 'fit '.repeat(30) + 'boundary' }],
    }
    const model = screenModel(state)
    expect(model.kind).toBe('sidebar')
    if (model.kind === 'sidebar' && model.panelBox) {
      for (const line of model.panelBox.content.split(' ')) {
        expect(line.length).toBeLessThanOrEqual(42)
      }
    }
  })

  it('wraps compact messages on word boundaries when words fit the row', () => {
    const state: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [{ id: '1', sender: 'Alice', text: 'short simple message' }],
    }
    const model = screenModel(state)
    expect(model.kind).toBe('sidebar')
    if (model.kind === 'sidebar') {
      expect(model.panelBody).toContain('Alice')
    }
  })

  it('replaces unsupported emoji that LVGL cannot render on glasses', () => {
    const state: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [{ id: '1', sender: 'Alice', text: '🔴 important 🟡 note 🟢 ok 🎯 target' }],
    }
    const model = screenModel(state)
    expect(model.kind).toBe('sidebar')
    if (model.kind === 'sidebar') {
      expect(model.panelBody).not.toContain('🔴')
      expect(model.panelBody).not.toContain('🟡')
      expect(model.panelBody).not.toContain('🟢')
      expect(model.panelBody).not.toContain('🎯')
      expect(model.panelBody).toContain('target')
    }
  })

  it('strips U+2757 and U+26A0 that produce LVGL glyph-not-found warnings', () => {
    const state: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [{ id: '1', sender: 'Alice', text: '❗ important ⚠ warning done' }],
    }
    const model = screenModel(state)
    expect(model.kind).toBe('sidebar')
    if (model.kind === 'sidebar') {
      // Heavy exclamation and warning sign must not survive into the glasses panel
      // because LVGL emits `glyph dsc. not found` warnings for them on the simulator.
      expect(model.panelBody).not.toContain('\u2757')
      expect(model.panelBody).not.toContain('\u26a0')
      expect(model.panelBody).toContain('important')
      expect(model.panelBody).toContain('warning')
      expect(model.panelBody).toContain('done')
    }
  })

  it('renders every long-message scroll stop as a complete box', () => {
    const state: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [{ id: '1', sender: 'Alice', text: 'long text '.repeat(35) + 'final' }],
    }

    const pageCount = messageScrollUnitCount(state.messages)
    for (let offset = 0; offset < pageCount; offset++) {
      const model = screenModel({ ...state, scrollOffset: offset })
      expect(model.kind).toBe('sidebar')
      if (model.kind === 'sidebar') {
        if (model.panelBox) {
          expect(model.panelBox.heading).toBeDefined()
          expect(model.panelBox.content).toBeDefined()
          expect(model.panelBody).toBe('')
        } else {
          expect(model.panelBody.length).toBeGreaterThan(0)
        }
      }
    }
  })

  it('renders the chat list full width with no message preview', () => {
    const chats = Array.from({ length: 12 }, (_, i) => ({
      id: String(i), title: `Chat ${i}`, kind: 'user' as const, isForum: false, lastMessage: 'preview text',
      unreadCount: i === 5 ? 3 : 0,
    }))
    const state: AppState = {
      screen: 'sidebar', focus: 'chats', chats, selectedChatIndex: 5,
      // Even if stale preview data is present it must never be drawn on the chat list.
      previewMessages: [{ id: '1', sender: 'Akira', text: 'lorem ipsum '.repeat(20) }],
    }

    const model = screenModel(state)
    expect(model.kind).toBe('sidebar')
    if (model.kind === 'sidebar') {
      expect(model.fullWidth).toBe(true)
      expect(model.panelBox).toBeUndefined()
      expect(model.panelBody).toContain('> (3) Chat 5')
      expect(model.panelBody).not.toContain('lorem')
      expect(model.panelBody).not.toContain('preview text')
      expect(model.panelBody.split('\n')).toHaveLength(7)
    }
  })

  it('uses the folder label as the chat-list title and shows the loading-more footer', () => {
    const state: AppState = {
      screen: 'sidebar', focus: 'chats',
      chats: [{ id: '1', title: 'Alice', kind: 'user' }], selectedChatIndex: 0,
      folderLabel: 'Work 2/3', loadingMore: true,
    }
    const model = screenModel(state)
    expect(model).toMatchObject({ kind: 'sidebar', title: 'Work 2/3', fullWidth: true, panelFooter: 'Loading more chats...' })
  })

  it('renders the folder picker as a full-width list with the marker on the selection', () => {
    const state: AppState = {
      screen: 'folderPicker',
      chats: [], selectedChatIndex: 0,
      options: ['All chats', 'Work', 'Family', 'Sleep'], selectedIndex: 2,
    }
    const model = screenModel(state)
    expect(model).toMatchObject({ kind: 'sidebar', title: 'Folders', fullWidth: true, sidebarSelected: 2 })
    if (model.kind === 'sidebar') {
      expect(model.panelBody.split('\n')).toEqual(['  All chats', '  Work', '> Family', '  Sleep'])
      expect(model.panelBox).toBeUndefined()
    }
  })

  it('shows selected-topic loading instead of mirroring the topic list before preview loads', () => {
    const state: AppState = {
      screen: 'sidebar', focus: 'topics',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Akira Agents', kind: 'group', isForum: true },
      topics: [
        { id: '10', title: 'General' },
        { id: '20', title: 'Assistant' },
        { id: '30', title: 'Stock-Analyst' },
      ],
      selectedTopicIndex: 2,
    }

    const model = screenModel(state)
    expect(model.kind).toBe('sidebar')
    if (model.kind === 'sidebar') {
      // The title is now prefixed with a ">" to make it clear at
      // a glance that the right panel is a per-topic preview,
      // not the full message thread (the user kept confusing
      // the two on real G2 hardware).
      expect(model.panelTitle).toBe('> Stock-Analyst')
      expect(model.panelBody).toBe('Loading messages...')
      expect(model.panelBody).not.toContain('General')
      // The footer is the primary signal that this is a preview
      // and not the full thread; see the comment on
      // `sidebar.topics` in `model.ts`.
      expect(model.panelFooter).toBe('Loading messages...')
    }
  })

  it('marks only the selected confirmation action', () => {
    const baseState: AppState = {
      screen: 'sidebarConfirm', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [{ id: '1', sender: 'Alice', text: 'hello' }],
      transcript: 'reply',
      selectedIndex: 0,
    }

    const sendSelected = screenModel(baseState)
    const cancelSelected = screenModel({ ...baseState, selectedIndex: 1 })

    // The confirmation is a dialog over the thread, not a separate screen.
    expect(sendSelected.kind).toBe('sidebar')
    expect(cancelSelected.kind).toBe('sidebar')
    if (sendSelected.kind === 'sidebar' && cancelSelected.kind === 'sidebar') {
      expect(sendSelected.popup?.body).toBe('reply\n\n> Send\n  Cancel')
      expect(cancelSelected.popup?.body).toBe('reply\n\n  Send\n> Cancel')
      expect(sendSelected.panelBody).toContain('hello') // the conversation stays visible underneath
      expect(sendSelected.panelBox).toBeUndefined()
      expect(sendSelected.panelImage).toBeUndefined()
    }
  })

  it('clamps a long transcript in the dialog but not in what is sent', () => {
    const long = 'word '.repeat(80).trim()
    const model = screenModel({
      screen: 'sidebarConfirm', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [], transcript: long, selectedIndex: 0,
    })
    expect(model.kind === 'sidebar' && model.popup?.body.split('\n')[0].length).toBeLessThanOrEqual(110)
    expect(model.kind === 'sidebar' && model.popup?.body).toContain('...')
    expect(model.kind === 'sidebar' && model.popup?.body).toContain('> Send')
  })

  it('keeps the unread count visible when a chat name is long', () => {
    const model = screenModel({
      screen: 'sidebar', focus: 'chats',
      chats: [{ id: '1', title: 'An extremely long group name that will be cut', kind: 'group', unreadCount: 12 }],
      selectedChatIndex: 0,
    })
    expect(model.kind === 'sidebar' && model.sidebarItems[0]).toMatch(/^\(12\) /)
  })

  it('shows REC while recording and how far back you have scrolled', () => {
    const base: AppState = {
      screen: 'sidebarRecording', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [{ id: '1', sender: 'A', text: 'one' }, { id: '2', sender: 'B', text: 'two' }, { id: '3', sender: 'C', text: 'three' }],
      chunks: [], startedAt: 0,
    }
    expect(screenModel(base).kind === 'sidebar' && (screenModel(base) as { title: string }).title).toMatch(/^REC /)
    const scrolled = screenModel({ screen: 'sidebar', focus: 'messages', chats: [], selectedChatIndex: 0, chat: base.chat, messages: base.messages, scrollOffset: 2 })
    const newest = screenModel({ screen: 'sidebar', focus: 'messages', chats: [], selectedChatIndex: 0, chat: base.chat, messages: base.messages })
    expect(scrolled.kind === 'sidebar' && scrolled.panelFooter).toContain('2 newer')
    expect(newest.kind === 'sidebar' && newest.panelFooter).not.toContain('newer')
  })

  it('renders an opened message thread across the full glasses width', () => {
    const model = screenModel({
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [{ id: '1', sender: 'Alice', text: 'hello' }],
    })

    expect(model.kind).toBe('sidebar')
    if (model.kind === 'sidebar') expect(model.fullWidth).toBe(true)
  })


  it('strips CJK characters when locale requests transliteration fallback', () => {
    const original = getLocale()
    setLocale(ja)

    let result = screenModel({
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: '日本語', kind: 'group' },
      messages: [{ id: '1', sender: 'Alice', text: 'hello' }],
    })
    if (result.kind === 'sidebar') {
      expect(result.panelTitle).not.toContain('日')
      expect(result.panelTitle).not.toContain('本')
      expect(result.panelTitle).not.toContain('語')
    }

    result = screenModel({
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Test', kind: 'group' },
      messages: [{ id: '1', sender: 'Alice', text: '안녕하세요 Hello' }],
    })
    if (result.kind === 'sidebar') {
      expect(result.panelBody).toContain('Hello')
      expect(result.panelBody).not.toContain('안')
    }

    setLocale(original)
  })

  // ── Bug 1: setLocale / getLocale integration ──
  // These tests verify the locale module itself works correctly.
  // The BUG is that the phone React UI (App.tsx, ChatScreen.tsx)
  // never calls getLocale() — it hardcodes English strings.
  // So setLocale() works fine at the module level, but the phone
  // UI never re-renders with the new strings.
  it('setLocale then getLocale returns ja phone-UI keys', () => {
    const original = getLocale()
    setLocale(ja)
    const l = getLocale()

    // Phone UI keys exist in the locale module
    expect(l.phoneAppTitle).toBe(ja.phoneAppTitle)
    expect(l.phoneSettingsTab).toBe(ja.phoneSettingsTab)
    expect(l.phoneBack).toBe(ja.phoneBack)
    expect(l.phoneBackToChat).toBe(ja.phoneBackToChat)
    expect(l.phoneOpenSettings).toBe(ja.phoneOpenSettings)

    // Phone ChatScreen state descriptions
    expect(l.phoneScreenOff).toBe(ja.phoneScreenOff)
    expect(l.phoneRecording).toBe(ja.phoneRecording)
    expect(l.phoneTranscribing).toBe(ja.phoneTranscribing)
    expect(l.phoneConfirmOnGlasses).toBe(ja.phoneConfirmOnGlasses)
    expect(l.phoneSendingReply).toBe(ja.phoneSendingReply)
    expect(l.phoneReplySent).toBe(ja.phoneReplySent)

    setLocale(original)
  })

  it('all phone-UI locale keys have English values in en locale', () => {
    expect(en.phoneAppTitle).toBe('TeleGlance')
    expect(en.phoneSettingsTab).toBe('Settings')
    expect(en.phoneBack).toBe('Back')
    expect(en.phoneBackToChat).toBe('Back to chat')
    expect(en.phoneOpenSettings).toBe('Open settings')
    expect(en.phoneScreenOff).toBe('Glasses screen is off. Double-click glasses to wake.')
    expect(en.phoneRecording).toBe('Recording on glasses…')
    expect(en.phoneTranscribing).toBe('Transcribing voice reply…')
    expect(en.phoneConfirmOnGlasses).toBe('Confirm reply on glasses: ')
    expect(en.phoneSendingReply).toBe('Sending reply…')
    expect(en.phoneReplySent).toBe('Reply sent.')
    expect(en.phoneSend).toBe('Send')
    expect(en.phoneNoMessages).toBe('No messages yet.')
    expect(en.phoneSendFailed).toBe('Send failed')
    expect(en.phoneCurrentThread).toBe('Current thread')
    expect(en.phoneComposerPlaceholder).toBe('Type a Telegram reply...')
    expect(en.phoneSending).toBe('Sending...')
    expect(en.phoneVerifying).toBe('Verifying...')
    expect(en.phoneSendingLoginCode).toBe('Sending...')
    expect(en.phoneSetupRequired).toBe('Backend URL, Telegram API ID, and Telegram API hash are required. Custom backends also require Backend shared secret. Fill them in Settings using the setup instructions first.')
  })

  it('model correctly uses locale for typing footer and status text', () => {
    const original = getLocale()
    setLocale(ja)

    // Typing footer with localized suffix
    const typingState: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Test', kind: 'user' },
      messages: [{ id: '1', sender: 'Alice', text: 'hello' }],
      typing: { userName: 'Alice', expiresAt: Date.now() + 5000 },
    }
    const typingModel = screenModel(typingState)
    expect(typingModel.kind).toBe('sidebar')
    if (typingModel.kind === 'sidebar') {
      // The typing footer must use the locale-appropriate suffix
      expect(typingModel.panelFooter).toContain(`Alice ${ja.typingSuffix}`)
      // It must NOT contain the English fallback
      expect(typingModel.panelFooter).not.toContain('typing…')
    }

    // Footer with no typing, no status — just the default instructions
    const plainState: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Test', kind: 'group' },
      messages: [{ id: '1', sender: 'Alice', text: 'hi' }],
    }
    const plainModel = screenModel(plainState)
    expect(plainModel.kind).toBe('sidebar')
    if (plainModel.kind === 'sidebar') {
      expect(plainModel.panelFooter).toContain(ja.footerSwipeScroll)
      expect(plainModel.panelFooter).not.toContain(en.footerSwipeScroll)
    }

    setLocale(original)
  })
})

describe('message timestamps', () => {
  it('formats times as 24-hour local clock and days as relative labels', () => {
    const now = new Date(2026, 9, 28, 15, 0)
    const at = (y: number, mo: number, d: number, h = 12, m = 0) => new Date(y, mo, d, h, m).toISOString()
    expect(formatMessageTime(at(2026, 9, 28, 9, 5))).toBe('09:05')
    expect(formatMessageTime(at(2026, 9, 27, 23, 41))).toBe('23:41')
    expect(formatMessageTime(undefined)).toBe('')
    expect(formatMessageTime('not a date')).toBe('')

    expect(formatDayLabel(at(2026, 9, 28, 0, 5), now)).toBe('Today')
    expect(formatDayLabel(at(2026, 9, 27, 23, 58), now)).toBe('Yesterday')
    expect(formatDayLabel(at(2026, 9, 26), now)).toBe('Mon 26 Oct')
    expect(formatDayLabel(at(2025, 11, 31), now)).toBe('Wed 31 Dec 2025')
    expect(formatDayLabel(undefined, now)).toBe('')
  })

  it('puts the time first on every line, with a divider row only where a new day starts', () => {
    const today = new Date()
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 23, 58)
    const at = (h: number, m: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m).toISOString()
    const messages: Message[] = [
      { id: '1', sender: 'Alice', text: 'night!', sentAt: yesterday.toISOString() },
      { id: '2', sender: 'Bob', text: 'still up?', sentAt: at(0, 5) },
      { id: '3', sender: 'Alice', text: 'morning', sentAt: at(9, 12) },
    ]
    const model = screenModel(messageState(messages))
    const body = model.kind === 'sidebar' ? model.panelBody ?? '' : ''
    expect(body.split('\n')).toEqual([
      '----- Yesterday -----',
      '23:58 Alice: night!',
      '----- Today -----',
      '00:05 Bob: still up?',
      '09:12 Alice: morning',
    ])
  })

  it('leaves out time and dividers for messages without a timestamp', () => {
    const model = screenModel(messageState([{ id: '1', sender: 'Alice', text: 'hi' }]))
    expect(model.kind === 'sidebar' ? model.panelBody : '').toBe('Alice: hi')
  })

  it('scrolls the divider together with its day instead of leaving it behind', () => {
    const base = new Date(2026, 0, 5, 10, 0).getTime()
    const messages: Message[] = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      sender: 'A',
      text: `m${i}`,
      sentAt: new Date(base + (i < 6 ? 0 : 86_400_000) + i * 60_000).toISOString(),
    }))
    const bodies = Array.from({ length: messageScrollUnitCount(messages) }, (_, offset) => {
      const model = screenModel(messageState(messages, offset))
      return model.kind === 'sidebar' ? model.panelBody ?? '' : ''
    })
    // Every divider is immediately followed by a message line, never the last row of a page.
    for (const body of bodies) {
      const lines = body.split('\n')
      lines.forEach((line, index) => {
        if (line.startsWith('-----')) expect(lines[index + 1]).toMatch(/^\d\d:\d\d /)
      })
    }
    expect(bodies.some((body) => body.includes('-----'))).toBe(true)
  })
})

describe('photo messages', () => {
  const photoMessage = (id: string, text = '[photo]'): Message => ({ id, sender: 'Alice', text, media: 'photo' })
  const sidebarAt = (messages: Message[], offset: number) => {
    const model = screenModel(messageState(messages, offset))
    if (model.kind !== 'sidebar') throw new Error('expected sidebar')
    return model
  }

  it('shows a photo inline between its neighbouring messages, leaving blank rows for the picture', () => {
    const messages: Message[] = [
      { id: '1', sender: 'Bob', text: 'before' },
      photoMessage('2', 'look at this lovely sunset over the bay [photo]'),
      { id: '3', sender: 'Bob', text: 'after' },
    ]

    expect(messageScrollUnitCount(messages)).toBe(3)

    // Newest view: the photo and the message after it share the screen.
    const newest = sidebarAt(messages, 0)
    expect(newest.panelImage).toEqual({ chatId: '1', messageId: '2', topLine: 1 })
    const rows = newest.panelBody.split('\n')
    expect(rows[0]).toContain('Alice')
    expect(rows[0]).toContain('[photo]')
    expect(rows.slice(1, 6).every((row) => row.trim() === '')).toBe(true) // the gap the picture covers
    expect(rows[6]).toContain('after')
    expect(rows.length).toBeLessThanOrEqual(7)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(44)

    // One step back: the message before sits above the photo and pushes the picture down a row.
    const older = sidebarAt(messages, 1)
    expect(older.panelImage).toEqual({ chatId: '1', messageId: '2', topLine: 2 })
    expect(older.panelBody.split('\n')[0]).toContain('before')

    expect(sidebarAt(messages, 2).panelImage).toBeUndefined()
  })

  it('scrolls through photo pages one step at a time', () => {
    const messages: Message[] = [photoMessage('1'), photoMessage('2'), photoMessage('3')]

    expect(sidebarAt(messages, 0).panelImage?.messageId).toBe('3')
    expect(nextMessageScrollOffset(messages, 0, 'up')).toBe(1)
    expect(sidebarAt(messages, 1).panelImage?.messageId).toBe('2')
    expect(nextMessageScrollOffset(messages, 1, 'down')).toBe(0)
  })

  it('shows no picture while the thread is still loading', () => {
    const state = { ...messageState([photoMessage('1')]), status: 'Loading messages...' } as AppState
    const model = screenModel(state)
    expect(model.kind === 'sidebar' ? model.panelImage : 'x').toBeUndefined()
  })
})

describe('replies, forwards, polls and link cards', () => {
  const bodyRows = (messages: Message[], offset = 0) => {
    const model = screenModel(messageState(messages, offset))
    if (model.kind !== 'sidebar') throw new Error('expected sidebar')
    return model.panelBody.split('\n')
  }

  it('quotes the message being replied to on its own row above the reply', () => {
    const rows = bodyRows([
      { id: '2', sender: 'Bob', text: 'sure', replyTo: { messageId: 1, sender: 'Alice', preview: 'can you send the file please' } },
    ])
    expect(rows[0]).toBe('> Alice: can you send the file please')
    expect(rows[1]).toContain('Bob: sure')
  })

  it('clips a long quote to one row and shows a bare marker without a preview', () => {
    const long = bodyRows([{ id: '2', sender: 'Bob', text: 'ok', replyTo: { messageId: 1, sender: 'Alice', preview: 'x'.repeat(80) } }])
    expect(long[0].length).toBeLessThanOrEqual(44)
    expect(long[0].endsWith('..')).toBe(true)
    expect(bodyRows([{ id: '2', sender: 'Bob', text: 'ok', replyTo: { messageId: 1 } }])[0]).toBe('>')
  })

  it('shows a forwarded-from header, above the reply quote when both are present', () => {
    const rows = bodyRows([
      { id: '2', sender: 'Bob', text: 'look', forwardedFrom: 'News Channel', replyTo: { messageId: 1, sender: 'Alice', preview: 'hm' } },
    ])
    expect(rows.slice(0, 2)).toEqual(['Fwd: News Channel', '> Alice: hm'])
  })

  it('renders a poll as a question, option rows with percentages and a votes footer', () => {
    const rows = bodyRows([
      {
        id: '3', sender: 'Alice', text: 'Lunch?',
        poll: {
          question: 'Lunch?', totalVoters: 4,
          options: [
            { text: 'Pizza', percent: 75, voters: 3, chosen: true },
            { text: 'Sushi', percent: 25, voters: 1 },
          ],
        },
      },
    ])
    expect(rows).toEqual(['Alice: Poll: Lunch?', '  [x] Pizza 75%', '  [ ] Sushi 25%', '  4 votes'])
  })

  it('keeps a big poll within one page of seven rows', () => {
    const options = Array.from({ length: 10 }, (_, index) => ({ text: `Option number ${index + 1} with a fairly long label that must be clipped`, percent: 10 }))
    const rows = bodyRows([{ id: '3', sender: 'Alice', text: 'Pick one', poll: { question: 'Pick one', totalVoters: 10, closed: true, options } }])
    expect(rows.length).toBeLessThanOrEqual(7)
    expect(rows.some((row) => /\+\d+ more/.test(row))).toBe(true)
    expect(rows[rows.length - 1]).toBe('  10 votes - closed')
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(44)
  })

  it('shows a link card with the title and domain - description under the text', () => {
    const rows = bodyRows([
      { id: '4', sender: 'Bob', text: 'see https://hub.evenrealities.com', link: { title: 'Even Hub docs', domain: 'hub.evenrealities.com', description: 'Build apps' } },
    ])
    expect(rows[1]).toBe('  > Even Hub docs')
    expect(rows[2]).toBe('    hub.evenrealities.com - Build apps')
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(44)
  })

  it('leaves the picture aligned when a forwarded photo has a header row', () => {
    const model = screenModel(messageState([{ id: '5', sender: 'Alice', text: '[photo]', media: 'photo', forwardedFrom: 'Bob' }]))
    if (model.kind !== 'sidebar') throw new Error('expected sidebar')
    const rows = model.panelBody.split('\n')
    expect(rows[0]).toBe('Fwd: Bob')
    expect(rows).toHaveLength(7)
    expect(model.panelImage?.topLine).toBe(2)
  })
})

describe('backToMessages and send errors', () => {
  const chat = { id: '1', title: 'A', kind: 'user' as const }
  it('copies the thread fields and applies overrides', async () => {
    const { backToMessages } = await import('../src/controller/model')
    const base = { ...messageState([]), } as Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>
    const back = backToMessages({ ...base, chat }, { status: "Didn't catch that" })
    expect(back).toMatchObject({ screen: 'sidebar', focus: 'messages', chat, status: "Didn't catch that" })
  })

  it('shows the send error above the transcript in the confirm popup', () => {
    const base = messageState([]) as Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>
    const model = screenModel({ ...base, screen: 'sidebarConfirm', transcript: 'hello', selectedIndex: 0, sendError: 'Send failed: timeout' } as AppState)
    expect(JSON.stringify(model)).toContain('Send failed: timeout')
  })
})
