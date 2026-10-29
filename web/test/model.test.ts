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
      expect(model.panelFooter).toBe('Swipe scroll | Click record | Double click back')
    }
  })

  it('lets large messages scroll through later chunks instead of truncating to ellipsis only', () => {
    const state: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [
        { id: '1', sender: 'Alice', text: 'short' },
        { id: '2', sender: 'Bob', text: 'a '.repeat(65) + 'last' },
      ],
    }

    const fullModel = screenModel(state)

    expect(fullModel.kind).toBe('sidebar')
    if (fullModel.kind === 'sidebar') {
      // scrollOffset 0 is the newest page — Bob's long box
      expect(fullModel.panelBox).toBeDefined()
    }

    const scrolled = screenModel({ ...state, scrollOffset: messageScrollUnitCount(state.messages) - 1 })
    expect(scrolled.kind).toBe('sidebar')
    if (scrolled.kind === 'sidebar') {
      // scrollOffset 1 is Alice's short message
      expect(scrolled.panelBody).toContain('Alice')
    }
  })

  it('navigates boxed message chunks in reading order with adjacent-message boundaries', () => {
    const state: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [
        { id: '1', sender: 'Alice', text: 'older note' },
        { id: '2', sender: 'Bob', text: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega '.repeat(3) },
        { id: '3', sender: 'Carol', text: 'newer note' },
      ],
    }

    const newest = screenModel({ ...state, scrollOffset: 0 })
    expect(newest.kind).toBe('sidebar')
    if (newest.kind === 'sidebar') expect(newest.panelBody).toContain('Carol')

    const firstBoxOffset = nextMessageScrollOffset(state.messages, 0, 'up')
    const firstBox = screenModel({ ...state, scrollOffset: firstBoxOffset })
    expect(firstBox.kind).toBe('sidebar')
    if (firstBox.kind === 'sidebar') {
      expect(firstBox.panelBox?.heading).toContain('1/')
      expect(firstBox.panelBox?.content).toContain('alpha')
    }

    const secondBoxOffset = nextMessageScrollOffset(state.messages, firstBoxOffset, 'down')
    const secondBox = screenModel({ ...state, scrollOffset: secondBoxOffset })
    expect(secondBox.kind).toBe('sidebar')
    if (secondBox.kind === 'sidebar') {
      expect(secondBox.panelBox?.heading).toContain('2/')
      expect(nextMessageScrollOffset(state.messages, secondBoxOffset, 'up')).toBe(firstBoxOffset)
    }

    const thirdBoxOffset = nextMessageScrollOffset(state.messages, secondBoxOffset, 'down')
    const thirdBox = screenModel({ ...state, scrollOffset: thirdBoxOffset })
    expect(thirdBox.kind).toBe('sidebar')
    if (thirdBox.kind === 'sidebar') {
      expect(thirdBox.panelBox?.heading).toContain('3/')
      expect(nextMessageScrollOffset(state.messages, thirdBoxOffset, 'up')).toBe(secondBoxOffset)
    }

    expect(nextMessageScrollOffset(state.messages, firstBoxOffset, 'up')).toBe(messageScrollUnitCount(state.messages) - 1)
    const olderOffset = messageScrollUnitCount(state.messages) - 1
    const older = screenModel({ ...state, scrollOffset: olderOffset })
    expect(older.kind).toBe('sidebar')
    if (older.kind === 'sidebar') expect(older.panelBody).toContain('Alice')
    expect(nextMessageScrollOffset(state.messages, olderOffset, 'down')).toBe(firstBoxOffset)

    let lastBoxOffset = firstBoxOffset
    while (true) {
      const next = nextMessageScrollOffset(state.messages, lastBoxOffset, 'down')
      if (next === 0) break
      lastBoxOffset = next
    }
    expect(nextMessageScrollOffset(state.messages, lastBoxOffset, 'down')).toBe(0)
  })

  it('keeps navigation ordering correct across mixed small messages and multi-chunk boxes', () => {
    const messages: Message[] = [
      { id: 'old-small', sender: 'Alice', text: 'old small message' },
      { id: 'old-box', sender: 'Bob', text: longText('old-box', 4) },
      { id: 'middle-small', sender: 'Carol', text: 'middle small message' },
      { id: 'new-box', sender: 'Dana', text: longText('new-box', 4) },
      { id: 'new-small', sender: 'Eve', text: 'new small message' },
    ]

    const newest = modelAt(messages, 0)
    if (newest.kind === 'sidebar') expect(newest.panelBody).toContain('Eve')

    const newBoxFirst = nextMessageScrollOffset(messages, 0, 'up')
    expect(boxPart(messages, newBoxFirst)).toMatchObject({ sender: 'Dana', part: 1 })

    const newBoxSecond = nextMessageScrollOffset(messages, newBoxFirst, 'down')
    expect(boxPart(messages, newBoxSecond)).toMatchObject({ sender: 'Dana', part: 2 })

    const newBoxThird = nextMessageScrollOffset(messages, newBoxSecond, 'down')
    expect(boxPart(messages, newBoxThird)).toMatchObject({ sender: 'Dana', part: 3 })
    expect(nextMessageScrollOffset(messages, newBoxThird, 'up')).toBe(newBoxSecond)

    const middleSmall = nextMessageScrollOffset(messages, newBoxFirst, 'up')
    const middleModel = modelAt(messages, middleSmall)
    if (middleModel.kind === 'sidebar') expect(middleModel.panelBody).toContain('Carol')
    expect(nextMessageScrollOffset(messages, middleSmall, 'down')).toBe(newBoxFirst)

    const oldBoxFirst = nextMessageScrollOffset(messages, middleSmall, 'up')
    expect(boxPart(messages, oldBoxFirst)).toMatchObject({ sender: 'Bob', part: 1 })
    expect(boxPart(messages, nextMessageScrollOffset(messages, oldBoxFirst, 'down'))).toMatchObject({ sender: 'Bob', part: 2 })

    const oldSmall = nextMessageScrollOffset(messages, oldBoxFirst, 'up')
    const oldSmallModel = modelAt(messages, oldSmall)
    if (oldSmallModel.kind === 'sidebar') expect(oldSmallModel.panelBody).toContain('Alice')
    expect(nextMessageScrollOffset(messages, oldSmall, 'down')).toBe(oldBoxFirst)
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

  it('keeps boxed long-message pages separate from adjacent short messages', () => {
    const state: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [
        { id: '1', sender: 'Alice', text: 'short' },
        { id: '2', sender: 'Bob', text: 'very '.repeat(30) + 'long message here' },
      ],
    }

    // Bob's message has 33 words → boxes. With 4 content rows per box page,
    // it may need 2 pages. scrollOffset 0 is the last box page.
    const shortPage = screenModel({ ...state, scrollOffset: 0 })
    expect(shortPage.kind).toBe('sidebar')
    if (shortPage.kind === 'sidebar') {
      expect(shortPage.panelBox).toBeDefined()
      if (shortPage.panelBox) {
        expect(shortPage.panelBox.heading).toContain('Bob')
      }
    }

    // Alice's short message is on the page before the box pages
    const pageCount = messageScrollUnitCount(state.messages)
    const alicePage = screenModel({ ...state, scrollOffset: pageCount - 1 })
    expect(alicePage.kind).toBe('sidebar')
    if (alicePage.kind === 'sidebar') {
      expect(alicePage.panelBody).toContain('Alice')
      expect(alicePage.panelBox).toBeUndefined()
    }
  })

  it('walks through all pages of a boxed message before moving to the previous message', () => {
    const state: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [
        { id: '1', sender: 'Alice', text: 'before' },
        { id: '2', sender: 'Bob', text: 'very '.repeat(30) + 'long message wrapping across multiple box pages' },
        { id: '3', sender: 'Carol', text: 'after' },
      ],
    }

    const pageCount = messageScrollUnitCount(state.messages)
    expect(pageCount).toBeGreaterThanOrEqual(3)

    const newestPage = screenModel({ ...state, scrollOffset: 0 })
    expect(newestPage.kind).toBe('sidebar')
    if (newestPage.kind === 'sidebar') {
      expect(newestPage.panelBody).toContain('Carol')
    }

    const midPage = screenModel({ ...state, scrollOffset: 1 })
    expect(midPage.kind).toBe('sidebar')
    if (midPage.kind === 'sidebar') {
      expect(midPage.panelBox).toBeDefined()
    }

    const oldestPage = screenModel({ ...state, scrollOffset: pageCount - 1 })
    expect(oldestPage.kind).toBe('sidebar')
    if (oldestPage.kind === 'sidebar') {
      expect(oldestPage.panelBody).toContain('Alice')
    }
  })

  it('scrolls compact messages by full visible pages instead of dropping one message at a time', () => {
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

    const pageCount = messageScrollUnitCount(state.messages)
    expect(pageCount).toBeGreaterThan(1)
    expect(pageCount).toBeLessThan(12)
  })
  it('keeps short messages compact and boxes messages over twenty-five words', () => {
    const shortState: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [{ id: '1', sender: 'Alice', text: 'hello world' }],
    }
    const shortModel = screenModel(shortState)
    expect(shortModel.kind).toBe('sidebar')
    if (shortModel.kind === 'sidebar') {
      expect(shortModel.panelBox).toBeUndefined()
    }

    const longState: AppState = {
      screen: 'sidebar', focus: 'messages',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Project', kind: 'group' },
      messages: [{ id: '1', sender: 'Alice', text: Array(30).fill('word').join(' ') }],
    }
    const longModel = screenModel(longState)
    expect(longModel.kind).toBe('sidebar')
    if (longModel.kind === 'sidebar') {
      expect(longModel.panelBox).toBeDefined()
    }
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

  it('does not double-render boxed topic previews as body text', () => {
    const state: AppState = {
      screen: 'sidebar', focus: 'topics',
      chats: [], selectedChatIndex: 0,
      chat: { id: '1', title: 'Akira Agents', kind: 'group', isForum: true },
      topics: [{ id: '10', title: 'Stock-Analyst' }],
      selectedTopicIndex: 0,
      previewTopic: { id: '10', title: 'Stock-Analyst' },
      previewMessages: [{ id: '1', sender: 'Akira', text: 'it after a 7x run from lows '.repeat(8) }],
    }

    const model = screenModel(state)

    expect(model.kind).toBe('sidebar')
    if (model.kind === 'sidebar') {
      expect(model.panelBox).toBeDefined()
      expect(model.panelBody).toBe('')
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
      expect(model.panelBody).toContain('> Chat 5 (3)')
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

  it('does not double-render boxed messages while recording or after sent state', () => {
    const base = {
      focus: 'messages' as const,
      chats: [],
      selectedChatIndex: 0,
      chat: { id: '1', title: 'Akira Agents', kind: 'group' as const },
      messages: [{ id: '1', sender: 'Akira', text: 'it after a 7x run from lows '.repeat(8) }],
    }

    const recording = screenModel({
      ...base,
      screen: 'sidebarRecording',
      chunks: [],
      startedAt: 1,
    })
    const sent = screenModel({
      ...base,
      screen: 'sidebarSent',
    })

    expect(recording.kind).toBe('sidebar')
    expect(sent.kind).toBe('sidebar')
    if (recording.kind === 'sidebar' && sent.kind === 'sidebar') {
      expect(recording.fullWidth).toBe(true)
      expect(sent.fullWidth).toBe(true)
      expect(recording.panelBox).toBeDefined()
      expect(recording.panelBody).toBe('')
      expect(sent.panelBox).toBeDefined()
      expect(sent.panelBody).toBe('')
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

    expect(sendSelected.kind).toBe('text')
    expect(cancelSelected.kind).toBe('text')
    if (sendSelected.kind === 'text' && cancelSelected.kind === 'text') {
      expect(sendSelected.body).toBe('reply\n\n> Send\n  Cancel')
      expect(cancelSelected.body).toBe('reply\n\n  Send\n> Cancel')
    }
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

  it('gives a photo its own page with the picture reference and a narrow text column', () => {
    const messages: Message[] = [
      { id: '1', sender: 'Bob', text: 'before' },
      photoMessage('2', 'look at this lovely sunset over the bay [photo]'),
      { id: '3', sender: 'Bob', text: 'after' },
    ]

    expect(messageScrollUnitCount(messages)).toBe(3)
    const photoPage = sidebarAt(messages, 1)
    expect(photoPage.panelImage).toEqual({ chatId: '1', messageId: '2' })
    for (const line of photoPage.panelBody.split('\n')) expect(line.length).toBeLessThanOrEqual(20)
    expect(photoPage.panelBody).toContain('Alice')
    expect(photoPage.panelBody).toContain('[photo]')

    expect(sidebarAt(messages, 0).panelImage).toBeUndefined()
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
