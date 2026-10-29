import type { ListChatsOptions, TelegramApi } from './api'
import type { Chat, Folder, Id, Message, Photo, TelegramTypingUpdate, TelegramUpdate, Topic, TranscriptionResult } from './types'
import { getFixtureTestOverrides } from './testMode'

const fixtureChats: Chat[] = [
  {
    id: 'fixture-chat-0',
    title: 'Fixture Alpha',
    kind: 'user',
    lastMessage: 'Alpha preview baseline for startup selection.',
  },
  {
    id: 'fixture-chat-1',
    title: 'Fixture Forum',
    kind: 'group',
    isForum: true,
    unreadCount: 3,
    lastMessage: 'Forum preview: topic content is available.',
  },
  {
    id: 'fixture-chat-2',
    title: 'Fixture Ops',
    kind: 'group',
    lastMessage: 'Ops preview: deployment status green.',
  },
  {
    id: 'fixture-chat-3',
    title: 'Fixture Research',
    kind: 'channel',
    lastMessage: 'Research preview: visual validation sample.',
  },
  {
    id: 'fixture-chat-4',
    title: 'Fixture Archive',
    kind: 'group',
    lastMessage: 'Archive preview: older test data.',
  },
]

const LONG_ALPHA_BODY = [
  'This is a deliberately long fixture message that is intended to exercise the long-message rendering pipeline including word wrapping, multi-line layout, and the page-byte-limit trim path. It is well past the fifty-word boundary so the harness can confirm the text container and panelBox branches handle overflow correctly. The harness must verify that the visible substring is preserved even when the total byte length exceeds the SDK cap. fixture-long-alpha-body-anchor appears near the end so the matcher has a unique string to look for. End of long message.',
].join(' ')

const LONG_TOPIC_BODY = [
  'Fixture topic long message body is intended to validate the box rendering path on real G2 hardware and the simulator. It contains more than fifty words on purpose, exercises the trimForContainer and formatBoxContent helpers, and includes the unique anchor fixture-long-topic-body-anchor so the harness can confirm the box did not silently drop text past the 999-byte cap. The catalog asserts that the heading and content both contain this anchor, and that the visible substring of the first line is preserved.',
].join(' ')

const messagePages = new Map<string, Message[]>([
  [threadKey('fixture-chat-0'), [
    msg(10, 'Fixture Alpha', 'Alpha message page contains fixture-alpha-body for startup testing.'),
    msg(11, 'Me', 'Alpha outgoing marker for visual validation.', true),
  ]],
  [threadKey('fixture-chat-2'), [
    msg(20, 'Fixture Ops', 'Ops message page contains fixture-ops-body for chat index two.'),
    msg(21, 'SRE', 'Ops latency sample message should remain readable.'),
  ]],
  [threadKey('fixture-chat-3'), [
    msg(30, 'Fixture Research', 'Research message page contains fixture-research-body for chat index three.'),
    msg(31, 'Analyst', 'Research sample confirms normal chat rendering.'),
  ]],
  [threadKey('fixture-chat-4'), [
    msg(40, 'Fixture Long', LONG_ALPHA_BODY),
    msg(41, 'Fixture Long', 'Short follow-up so pagination logic can detect an older page boundary below.'),
  ]],
  [threadKey('fixture-chat-1', 'fixture-topic-0'), [
    msg(100, 'Forum Bot', 'Topic zero warmup body appears before indexed topic validation.'),
  ]],
  [threadKey('fixture-chat-1', 'fixture-topic-1'), [
    msg(110, 'Topic One', 'Fixture topic one message body includes fixture-topic-one-body.'),
    msg(111, 'Reviewer', 'Topic one second message validates scrolling without reset.'),
  ]],
  [threadKey('fixture-chat-1', 'fixture-topic-2'), [
    msg(120, 'Topic Two', 'Fixture topic two message body includes fixture-topic-two-body.'),
    msg(121, 'Reviewer', 'Topic two second message validates rendering distinct content.'),
  ]],
  [threadKey('fixture-chat-1', 'fixture-topic-3'), [
    msg(130, 'Topic Three', LONG_TOPIC_BODY),
    msg(131, 'Reviewer', 'Topic three second message validates double-click back.'),
  ]],
  // simulator-driven scroll test
  // (`scripts/simulator-topic-scroll.mjs`) opens each topic
  // and exhaustively swipes to confirm every message renders.
  // The initial listMessages call returns 8 messages (the
  // controller's `MESSAGE_PAGE_LIMIT`); the remaining 4 require
  // the user to swipe up to trigger `loadOlderMessages`.
  // Each message body embeds a unique anchor of the form
  // `topic-N-m<M>` so the harness can assert "I saw message M
  // of topic N" without parsing `state.messages`.
  [threadKey('fixture-chat-1', 'fixture-topic-4'), [
    msg(140, 'Topic Four', 'topic-4-m1: First message of topic four.'),
    msg(141, 'Topic Four', 'topic-4-m2: Second message of topic four.'),
    msg(142, 'Topic Four', 'topic-4-m3: Third message of topic four.'),
    msg(143, 'Topic Four', 'topic-4-m4: Fourth message of topic four.'),
    msg(144, 'Topic Four', 'topic-4-m5: Fifth message of topic four.'),
    msg(145, 'Topic Four', 'topic-4-m6: Sixth message of topic four.'),
    msg(146, 'Topic Four', 'topic-4-m7: Seventh message of topic four.'),
    msg(147, 'Topic Four', 'topic-4-m8: Eighth message of topic four.'),
    msg(148, 'Topic Four', 'topic-4-m9: Ninth message of topic four.'),
    msg(149, 'Topic Four', 'topic-4-m10: Tenth message of topic four.'),
    msg(14, 'Topic Four', 'topic-4-m11: Eleventh message of topic four.'),
    msg(15, 'Topic Four', 'topic-4-m12: Twelfth message of topic four.'),
  ]],
  [threadKey('fixture-chat-1', 'fixture-topic-5'), [
    msg(150, 'Topic Five', 'topic-5-m1: First message of topic five.'),
    msg(151, 'Topic Five', 'topic-5-m2: Second message of topic five.'),
    msg(152, 'Topic Five', 'topic-5-m3: Third message of topic five.'),
    msg(153, 'Topic Five', 'topic-5-m4: Fourth message of topic five.'),
    msg(154, 'Topic Five', 'topic-5-m5: Fifth message of topic five.'),
    msg(155, 'Topic Five', 'topic-5-m6: Sixth message of topic five.'),
    msg(156, 'Topic Five', 'topic-5-m7: Seventh message of topic five.'),
    msg(157, 'Topic Five', 'topic-5-m8: Eighth message of topic five.'),
    msg(158, 'Topic Five', 'topic-5-m9: Ninth message of topic five.'),
    msg(159, 'Topic Five', 'topic-5-m10: Tenth message of topic five.'),
    msg(25, 'Topic Five', 'topic-5-m11: Eleventh message of topic five.'),
    msg(26, 'Topic Five', 'topic-5-m12: Twelfth message of topic five.'),
  ]],
  [threadKey('fixture-chat-1', 'fixture-topic-6'), [
    msg(160, 'Topic Six', 'topic-6-m1: First message of topic six.'),
    msg(161, 'Topic Six', 'topic-6-m2: Second message of topic six.'),
    msg(162, 'Topic Six', 'topic-6-m3: Third message of topic six.'),
    msg(163, 'Topic Six', 'topic-6-m4: Fourth message of topic six.'),
    msg(164, 'Topic Six', 'topic-6-m5: Fifth message of topic six.'),
    msg(165, 'Topic Six', 'topic-6-m6: Sixth message of topic six.'),
    msg(166, 'Topic Six', 'topic-6-m7: Seventh message of topic six.'),
    msg(167, 'Topic Six', 'topic-6-m8: Eighth message of topic six.'),
    msg(168, 'Topic Six', 'topic-6-m9: Ninth message of topic six.'),
    msg(169, 'Topic Six', 'topic-6-m10: Tenth message of topic six.'),
    msg(36, 'Topic Six', 'topic-6-m11: Eleventh message of topic six.'),
    msg(37, 'Topic Six', 'topic-6-m12: Twelfth message of topic six.'),
  ]],
])

export interface FixtureSentMessage {
  chatId: Id
  text: string
  topicId: Id | null
  sentAt: number
}

export class FixtureTelegramApi implements TelegramApi {
  private nextTranscript: string | null = null
  private sent: FixtureSentMessage[] = []
  private mode: 'normal' | 'missing' | 'signedOut' | 'error' | 'slow' = 'normal'
  private slowChatsMs = 0
  private subscribers = new Set<(update: TelegramUpdate | TelegramTypingUpdate) => void>()
  private injectedNotification: { chatId: Id; message: string; topicId?: Id | null } | null = null
  private chatOverrides = new Map<string, Partial<Chat>>()
  fixtureLocale: string = 'en'

  private getChats(): Chat[] {
    if (this.fixtureLocale === 'es') return fixtureChatsEs
    if (this.fixtureLocale === 'fr') return fixtureChatsFr
    if (this.fixtureLocale === 'de') return fixtureChatsDe
    if (this.fixtureLocale === 'it') return fixtureChatsIt
    if (this.fixtureLocale === 'pt') return fixtureChatsPt
    if (this.fixtureLocale === 'nl') return fixtureChatsNl
    if (this.fixtureLocale === 'sv') return fixtureChatsSv
    if (this.fixtureLocale === 'pl') return fixtureChatsPl
    if (this.fixtureLocale === 'tr') return fixtureChatsTr
    if (this.fixtureLocale === 'cs') return fixtureChatsCs
    if (this.fixtureLocale === 'ro') return fixtureChatsRo
    if (this.fixtureLocale === 'hu') return fixtureChatsHu
    if (this.fixtureLocale === 'vi') return fixtureChatsVi
    if (this.fixtureLocale === 'fi') return fixtureChatsFi
    if (this.fixtureLocale === 'no') return fixtureChatsNo
    if (this.fixtureLocale === 'da') return fixtureChatsDa
    if (this.fixtureLocale === 'id') return fixtureChatsId
    if (this.fixtureLocale === 'ca') return fixtureChatsCa
    if (this.fixtureLocale === 'sk') return fixtureChatsSk
    return fixtureChats
  }
  private getTopics(): Topic[] {
    if (this.fixtureLocale === 'es') return fixtureTopicsEs
    if (this.fixtureLocale === 'fr') return fixtureTopicsFr
    return fixtureTopics
  }
  private getMessagePages(): Map<string, Message[]> {
    if (this.fixtureLocale === 'es') return messagePagesEs
    if (this.fixtureLocale === 'fr') return messagePagesFr
    return messagePages
  }

  setMode(mode: 'normal' | 'missing' | 'signedOut' | 'error' | 'slow') {
    this.mode = mode
  }

  setSlowChats(ms: number) {
    this.slowChatsMs = ms
  }

  setNextTranscript(transcript: string | null) {
    this.nextTranscript = transcript
  }

  readSent(): FixtureSentMessage[] {
    return [...this.sent]
  }

  setInjectedNotification(value: { chatId: Id; message: string; topicId?: Id | null } | null) {
    this.injectedNotification = value
    if (!value || this.subscribers.size === 0) return
    const key = String(value.chatId)
    const current = fixtureChats.find((chat) => String(chat.id) === key)
    this.chatOverrides.set(key, {
      lastMessage: value.message,
      unreadCount: Math.max(1, Number(current?.unreadCount ?? 0) + 1),
    })
    this.injectedNotification = null
    const update: TelegramUpdate = {
      type: 'message',
      chatId: value.chatId,
      topicId: value.topicId ?? null,
      message: msg(Date.now(), 'Fixture Notifier', value.message, false),
    }
    for (const subscriber of this.subscribers) Promise.resolve().then(() => subscriber(update))
  }

  async authStatus() {
    if (this.mode === 'missing') return { configured: false, authorized: false }
    if (this.mode === 'signedOut') return { configured: true, authorized: false }
    if (this.mode === 'error') throw new Error('Fixture auth status error')
    return { configured: true, authorized: true }
  }

  async startPhoneAuth(phone: string) {
    return { phone, sent: true, message: 'Fixture login bypassed.', phoneCodeHash: 'fixture-phone-code-hash' }
  }

  async verifyPhoneAuth() {
    return { authorized: true, sessionString: 'fixture-session' }
  }

  async logout() {
    return undefined
  }
  async listChats(limit = 20, options: ListChatsOptions = {}) {
    if (this.slowChatsMs > 0) await fixtureDelay(this.slowChatsMs)
    else await fixtureDelay(40)
    // The fixture account has no Telegram folders, so folder filtering is never exercised here.
    const offset = options.offset ?? 0
    return this.getChats().slice(offset, offset + limit).map((chat) => ({ ...chat, ...(this.chatOverrides.get(String(chat.id)) ?? {}) }))
  }

  async listFolders(): Promise<Folder[]> {
    return []
  }

  async listTopics(chatId: Id) {
    await fixtureDelay(60)
    if (String(chatId) !== 'fixture-chat-1') return []
    return this.getTopics().map((topic) => ({ ...topic }))
  }

  async getPhoto(): Promise<Photo> {
    // 1x1 greyscale PNG: fixture runs never reach real glasses pixels.
    return { width: 20, height: 20, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==' }
  }

  async listMessages(chatId: Id, options: { topicId?: Id; beforeId?: Id; limit?: number } = {}) {
    await fixtureDelay(80)
    if (options.beforeId !== undefined) {
      const before = Number(options.beforeId)
      return [
        msg(before - 2, 'Older Fixture', `Older fixture page before ${String(options.beforeId)}.`),
        msg(before - 1, 'Older Fixture', 'Older fixture content validates up-scroll loading.'),
      ].slice(0, options.limit ?? 50)
    }
    const messages = this.getMessagePages().get(threadKey(chatId, options.topicId)) ?? [
      msg(900, 'Fixture', `Fallback fixture message for ${String(chatId)}.`),
    ]
    return messages.slice(0, options.limit ?? 50).map((message) => ({ ...message }))
  }

  async sendMessage(chatId: Id, request: { text: string; topicId?: Id }) {
    if (this.mode === 'error') throw new Error('Fixture send error')
    const recorded: FixtureSentMessage = {
      chatId,
      text: request.text,
      topicId: request.topicId ?? null,
      sentAt: Date.now(),
    }
    this.sent.push(recorded)
    return msg(Date.now(), 'Me', request.text, true)
  }

  async markRead() {
    return undefined
  }

  async transcribe(_wav?: Blob, _language?: string): Promise<TranscriptionResult> {
    await fixtureDelay(20)
    if (this.nextTranscript !== null) {
      const text = this.nextTranscript
      this.nextTranscript = null
      return { text }
    }
    return { text: 'Fixture transcript' }
  }

  subscribeUpdates(onUpdate: (update: TelegramUpdate | TelegramTypingUpdate) => void) {
    this.subscribers.add(onUpdate)
    if (this.injectedNotification) {
      const injected = this.injectedNotification
      this.injectedNotification = null
      Promise.resolve().then(() => {
        onUpdate({
          type: 'message',
          chatId: injected.chatId,
          topicId: injected.topicId ?? null,
          message: msg(Date.now(), 'Fixture Notifier', injected.message, false),
        })
      })
    }
    return () => {
      this.subscribers.delete(onUpdate)
    }
  }

  injectTyping(chatId: Id, topicId: Id | null, userName: string): void {
    const update: TelegramTypingUpdate = {
      type: 'typing',
      chatId,
      topicId,
      userName,
      action: 'typing',
    }
    for (const sub of this.subscribers) sub(update)
  }

  cancelTyping(chatId: Id, topicId: Id | null): void {
    const update: TelegramTypingUpdate = {
      type: 'typing',
      chatId,
      topicId,
      userName: null,
      action: 'cancel',
    }
    for (const sub of this.subscribers) sub(update)
  }
}

function threadKey(chatId: Id, topicId?: Id) {
  return topicId === undefined ? String(chatId) : `${String(chatId)}:${String(topicId)}`
}

let activeFixture: FixtureTelegramApi | null = null

export function setFixtureLocale(locale: string) {
  if (activeFixture) activeFixture.fixtureLocale = locale
}

export function bindFixtureApi(api: FixtureTelegramApi) {
  activeFixture = api
  const overrides = getFixtureTestOverrides()
  if (overrides.missingCredentials || overrides.signedOut || overrides.errorOnAuthStatus || overrides.slowChats) {
    if (overrides.missingCredentials) api.setMode('missing')
    else if (overrides.signedOut) api.setMode('signedOut')
    else if (overrides.errorOnAuthStatus) api.setMode('error')
    else if (overrides.slowChats) api.setMode('slow')
  }
  if (overrides.chatDelayMs > 0) api.setSlowChats(overrides.chatDelayMs)
  if (overrides.nextTranscript) api.setNextTranscript(overrides.nextTranscript)
  if (overrides.injectedNotification) api.setInjectedNotification(overrides.injectedNotification)
  startCommandPolling(api)
  if (typeof window !== 'undefined') {
    const debug = {
      setMode: (mode: 'normal' | 'missing' | 'signedOut' | 'error' | 'slow') => api.setMode(mode),
      setSlowChats: (ms: number) => api.setSlowChats(ms),
      setNextTranscript: (transcript: string | null) => api.setNextTranscript(transcript),
      setInjectedNotification: (value: { chatId: Id; message: string; topicId?: Id | null } | null) => api.setInjectedNotification(value),
      readSent: () => api.readSent(),
      getState: () => 'available' as const,
    }
    ;(window as unknown as { __teleGlanceFixture?: unknown }).__teleGlanceFixture = debug
  }
}

function msg(id: Id, sender: string, text: string, outgoing = false): Message {
  return {
    id,
    sender,
    text,
    outgoing,
    sentAt: '2026-06-01T20:00:00Z',
  }
}

function fixtureDelay(ms: number) {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

let commandPollTimer: ReturnType<typeof setInterval> | undefined

let injectedAudioChunks: Uint8Array[] = []
let fixtureCommandHandler: ((command: { kind: string } & Record<string, unknown>) => void | Promise<void>) | undefined

export function bindFixtureCommandHandler(
  handler: (command: { kind: string } & Record<string, unknown>) => void | Promise<void>,
) {
  fixtureCommandHandler = handler
  return () => {
    if (fixtureCommandHandler === handler) fixtureCommandHandler = undefined
  }
}

function startCommandPolling(api: FixtureTelegramApi) {
  if (commandPollTimer) return
  commandPollTimer = setInterval(async () => {
    try {
      const response = await fetch('/api/test/fixture-commands')
      if (!response.ok) return
      const data = await response.json() as { commands: Array<{ kind: string } & Record<string, unknown>> }
      if (!data.commands?.length) return
      for (const cmd of data.commands) {
        switch (cmd.kind) {
          case 'setMode':
            api.setMode(cmd.mode as 'normal' | 'missing' | 'error' | 'slow')
            break
          case 'setSlowChats':
            api.setSlowChats(cmd.ms as number)
            break
          case 'setNextTranscript':
            api.setNextTranscript(cmd.value as string | null)
            break
          case 'setInjectedNotification':
            api.setInjectedNotification(cmd as unknown as { chatId: string; message: string; topicId?: string | null })
            break
          case 'injectAudioChunks': {
            if (fixtureCommandHandler) await fixtureCommandHandler(cmd)
            else {
              const base64 = cmd.pcmBase64 as string
              const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
              injectedAudioChunks.push(bytes)
            }
            break
          }
          case 'injectTyping': {
            api.injectTyping(cmd.chatId as string, (cmd.topicId as string | null) ?? null, cmd.userName as string)
            break
          }
          case 'cancelTyping': {
            api.cancelTyping(cmd.chatId as string, (cmd.topicId as string | null) ?? null)
            break
          }
          default:
            await fixtureCommandHandler?.(cmd)
        }
      }
    } catch {
      // endpoint not available in prod builds
    }
  }, 100)
  const maybeNodeInterval = commandPollTimer as unknown as { unref?: () => void }
  maybeNodeInterval.unref?.()
}

export function consumeInjectedAudioChunks(): Uint8Array[] {
  const chunks = injectedAudioChunks
  injectedAudioChunks = []
  return chunks
}

export function getActiveFixtureApi(): FixtureTelegramApi | null {
  return activeFixture
}
// Spanish fixture data — 80% Spanish, 20% English (for mixed-content testing)
const fixtureChatsEs: Chat[] = [
  { id: 'fixture-chat-0', title: 'Familia', kind: 'user', lastMessage: 'Vista previa de Alpha para inicio.' },
  { id: 'fixture-chat-1', title: 'Proyecto Solar', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Vista previa del foro: contenido disponible.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Investigación', kind: 'channel', lastMessage: 'Muestra de validación visual.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]

const fixtureTopicsEs: Topic[] = [
  { id: 'fixture-topic-0', title: 'Tema Cero', topMessageId: 'fixture-topic-0-top', lastMessage: 'Vista previa del tema cero.' },
  { id: 'fixture-topic-1', title: 'Tema Uno', topMessageId: 'fixture-topic-1-top', unreadCount: 1, lastMessage: 'Contenido esperado del tema uno.' },
  { id: 'fixture-topic-2', title: 'Tema Dos', topMessageId: 'fixture-topic-2-top', unreadCount: 1, lastMessage: 'Contenido esperado del tema dos.' },
  { id: 'fixture-topic-3', title: 'Fixture Topic Three', topMessageId: 'fixture-topic-3-top', unreadCount: 1, lastMessage: 'Topic three expected content preview.' },
  { id: 'fixture-topic-4', title: 'Tema Cuatro', topMessageId: 'fixture-topic-4-top', lastMessage: 'Vista previa del tema cuatro.' },
  { id: 'fixture-topic-5', title: 'Tema Cinco', topMessageId: 'fixture-topic-5-top', lastMessage: 'Vista previa del tema cinco.' },
  { id: 'fixture-topic-6', title: 'Tema Seis', topMessageId: 'fixture-topic-6-top', lastMessage: 'Vista previa del tema seis.' },
]

const messagePagesEs = new Map<string, Message[]>([
  [threadKey('fixture-chat-0'), [
    msg(10, 'Familia', 'Página de mensajes Alpha: fixture-alpha-body para prueba de inicio.'),
    msg(11, 'Yo', 'Marcador saliente Alpha: validación visual.', true),
  ]],
  [threadKey('fixture-chat-2'), [
    msg(20, 'Fixture Ops', 'Ops message page contains fixture-ops-body for chat index two.'),
    msg(21, 'SRE', 'Muestra de latencia de Ops: debe permanecer legible.'),
  ]],
  [threadKey('fixture-chat-3'), [
    msg(30, 'Investigación', 'Página de mensajes Research: fixture-research-body.'),
    msg(31, 'Analista', 'Muestra de Research: confirma renderizado normal.', false),
  ]],
  [threadKey('fixture-chat-4'), [
    msg(40, 'Fixture Archive', LONG_ALPHA_BODY),
    msg(41, 'Fixture Archive', 'Short follow-up so pagination logic can detect an older page boundary below.'),
  ]],
  [threadKey('fixture-chat-1', 'fixture-topic-0'), [
    msg(100, 'Bot del Foro', 'Cuerpo de inicio del tema cero.'),
  ]],
  [threadKey('fixture-chat-1', 'fixture-topic-1'), [
    msg(110, 'Tema Uno', 'Mensaje del tema uno: incluye fixture-topic-one-body.'),
    msg(111, 'Revisor', 'Segundo mensaje del tema uno: valida desplazamiento.', false),
  ]],
  [threadKey('fixture-chat-1', 'fixture-topic-2'), [
    msg(120, 'Tema Dos', 'Mensaje del tema dos: incluye fixture-topic-two-body.'),
    msg(121, 'Revisor', 'Topic two second message validates rendering distinct content.'),
  ]],
  [threadKey('fixture-chat-1', 'fixture-topic-3'), [
    msg(130, 'Fixture Topic Three', LONG_TOPIC_BODY),
    msg(131, 'Revisor', 'Tercer mensaje: valida doble clic para volver.', false),
  ]],
] as Array<[string, Message[]]>)

// French fixture data — 80% French, 20% English
const fixtureChatsFr: Chat[] = [
  { id: 'fixture-chat-0', title: 'Famille', kind: 'user', lastMessage: 'Aperçu Alpha pour le démarrage.' },
  { id: 'fixture-chat-1', title: 'Projet Soleil', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Aperçu du forum : contenu disponible.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Recherche', kind: 'channel', lastMessage: 'Échantillon de validation visuelle.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]

const fixtureTopicsFr: Topic[] = [
  { id: 'fixture-topic-0', title: 'Sujet Zéro', topMessageId: 'fixture-topic-0-top', lastMessage: 'Aperçu du sujet zéro.' },
  { id: 'fixture-topic-1', title: 'Sujet Un', topMessageId: 'fixture-topic-1-top', unreadCount: 1, lastMessage: 'Contenu attendu du sujet un.' },
  { id: 'fixture-topic-2', title: 'Sujet Deux', topMessageId: 'fixture-topic-2-top', unreadCount: 1, lastMessage: 'Contenu attendu du sujet deux.' },
  { id: 'fixture-topic-3', title: 'Fixture Topic Three', topMessageId: 'fixture-topic-3-top', unreadCount: 1, lastMessage: 'Topic three expected content preview.' },
  { id: 'fixture-topic-4', title: 'Sujet Quatre', topMessageId: 'fixture-topic-4-top', lastMessage: 'Aperçu du sujet quatre.' },
  { id: 'fixture-topic-5', title: 'Sujet Cinq', topMessageId: 'fixture-topic-5-top', lastMessage: 'Aperçu du sujet cinq.' },
  { id: 'fixture-topic-6', title: 'Sujet Six', topMessageId: 'fixture-topic-6-top', lastMessage: 'Aperçu du sujet six.' },
]

const messagePagesFr = new Map<string, Message[]>([
  [threadKey('fixture-chat-0'), [
    msg(10, 'Famille', 'Page de messages Alpha : fixture-alpha-body pour test de démarrage.'),
    msg(11, 'Moi', 'Marqueur sortant Alpha : validation visuelle.', true),
  ]],
  [threadKey('fixture-chat-2'), [
    msg(20, 'Fixture Ops', 'Ops message page contains fixture-ops-body for chat index two.'),
    msg(21, 'SRE', 'Échantillon de latence Ops : doit rester lisible.'),
  ]],
  [threadKey('fixture-chat-3'), [
    msg(30, 'Recherche', 'Page de messages Research : fixture-research-body.'),
    msg(31, 'Analyste', 'Échantillon Research : confirme le rendu normal.', false),
  ]],
  [threadKey('fixture-chat-4'), [
    msg(40, 'Fixture Archive', LONG_ALPHA_BODY),
    msg(41, 'Fixture Archive', 'Short follow-up so pagination logic can detect an older page boundary below.'),
  ]],
  [threadKey('fixture-chat-1', 'fixture-topic-0'), [
    msg(100, 'Bot du Forum', 'Corps de démarrage du sujet zéro.'),
  ]],
  [threadKey('fixture-chat-1', 'fixture-topic-1'), [
    msg(110, 'Sujet Un', 'Message du sujet un : inclut fixture-topic-one-body.'),
    msg(111, 'Réviseur', 'Deuxième message du sujet un : valide le défilement.', false),
  ]],
  [threadKey('fixture-chat-1', 'fixture-topic-2'), [
    msg(120, 'Sujet Deux', 'Message du sujet deux : inclut fixture-topic-two-body.'),
    msg(121, 'Réviseur', 'Topic two second message validates rendering distinct content.'),
  ]],
  [threadKey('fixture-chat-1', 'fixture-topic-3'), [
    msg(130, 'Fixture Topic Three', LONG_TOPIC_BODY),
    msg(131, 'Réviseur', 'Troisième message : valide le double-clic retour.', false),
  ]],
] as Array<[string, Message[]]>)


// DE fixture data — 80% de, 20% English
const fixtureChatsDe: Chat[] = [
  { id: 'fixture-chat-0', title: 'Familie', kind: 'user', lastMessage: 'Preview for startup.' },
  { id: 'fixture-chat-1', title: 'Solarprojekt', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Forum preview available.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Forschung', kind: 'channel', lastMessage: 'Visual validation sample.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]


// IT fixture data — 80% it, 20% English
const fixtureChatsIt: Chat[] = [
  { id: 'fixture-chat-0', title: 'Famiglia', kind: 'user', lastMessage: 'Preview for startup.' },
  { id: 'fixture-chat-1', title: 'Progetto Solare', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Forum preview available.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Ricerca', kind: 'channel', lastMessage: 'Visual validation sample.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]


// PT fixture data — 80% pt, 20% English
const fixtureChatsPt: Chat[] = [
  { id: 'fixture-chat-0', title: 'Família', kind: 'user', lastMessage: 'Preview for startup.' },
  { id: 'fixture-chat-1', title: 'Projeto Solar', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Forum preview available.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Pesquisa', kind: 'channel', lastMessage: 'Visual validation sample.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]


// NL fixture data — 80% nl, 20% English
const fixtureChatsNl: Chat[] = [
  { id: 'fixture-chat-0', title: 'Familie', kind: 'user', lastMessage: 'Preview for startup.' },
  { id: 'fixture-chat-1', title: 'Zonneproject', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Forum preview available.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Onderzoek', kind: 'channel', lastMessage: 'Visual validation sample.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]


// SV fixture data — 80% sv, 20% English
const fixtureChatsSv: Chat[] = [
  { id: 'fixture-chat-0', title: 'Familj', kind: 'user', lastMessage: 'Preview for startup.' },
  { id: 'fixture-chat-1', title: 'Solprojekt', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Forum preview available.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Forskning', kind: 'channel', lastMessage: 'Visual validation sample.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]


// PL fixture data — 80% pl, 20% English
const fixtureChatsPl: Chat[] = [
  { id: 'fixture-chat-0', title: 'Rodzina', kind: 'user', lastMessage: 'Preview for startup.' },
  { id: 'fixture-chat-1', title: 'Projekt Słoneczny', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Forum preview available.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Badania', kind: 'channel', lastMessage: 'Visual validation sample.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]


// TR fixture data — 80% tr, 20% English
const fixtureChatsTr: Chat[] = [
  { id: 'fixture-chat-0', title: 'Aile', kind: 'user', lastMessage: 'Preview for startup.' },
  { id: 'fixture-chat-1', title: 'Güneş Projesi', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Forum preview available.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Araştırma', kind: 'channel', lastMessage: 'Visual validation sample.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]


// CS fixture data — 80% cs, 20% English
const fixtureChatsCs: Chat[] = [
  { id: 'fixture-chat-0', title: 'Rodina', kind: 'user', lastMessage: 'Preview for startup.' },
  { id: 'fixture-chat-1', title: 'Solární Projekt', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Forum preview available.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Výzkum', kind: 'channel', lastMessage: 'Visual validation sample.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]


// RO fixture data — 80% ro, 20% English
const fixtureChatsRo: Chat[] = [
  { id: 'fixture-chat-0', title: 'Familie', kind: 'user', lastMessage: 'Preview for startup.' },
  { id: 'fixture-chat-1', title: 'Proiect Solar', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Forum preview available.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Cercetare', kind: 'channel', lastMessage: 'Visual validation sample.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]


// HU fixture data — 80% hu, 20% English
const fixtureChatsHu: Chat[] = [
  { id: 'fixture-chat-0', title: 'Család', kind: 'user', lastMessage: 'Preview for startup.' },
  { id: 'fixture-chat-1', title: 'Nap Projekt', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Forum preview available.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Kutatás', kind: 'channel', lastMessage: 'Visual validation sample.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]


// VI fixture data — 80% vi, 20% English
const fixtureChatsVi: Chat[] = [
  { id: 'fixture-chat-0', title: 'Gia Đình', kind: 'user', lastMessage: 'Preview for startup.' },
  { id: 'fixture-chat-1', title: 'Dự Án Mặt Trời', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Forum preview available.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Nghiên Cứu', kind: 'channel', lastMessage: 'Visual validation sample.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]


// FI fixture data — 80% fi, 20% English
const fixtureChatsFi: Chat[] = [
  { id: 'fixture-chat-0', title: 'Perhe', kind: 'user', lastMessage: 'Preview for startup.' },
  { id: 'fixture-chat-1', title: 'Aurinkoprojekti', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Forum preview available.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Tutkimus', kind: 'channel', lastMessage: 'Visual validation sample.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]


// NO fixture data — 80% no, 20% English
const fixtureChatsNo: Chat[] = [
  { id: 'fixture-chat-0', title: 'Familie', kind: 'user', lastMessage: 'Preview for startup.' },
  { id: 'fixture-chat-1', title: 'Solprosjekt', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Forum preview available.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Forskning', kind: 'channel', lastMessage: 'Visual validation sample.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]


// DA fixture data — 80% da, 20% English
const fixtureChatsDa: Chat[] = [
  { id: 'fixture-chat-0', title: 'Familie', kind: 'user', lastMessage: 'Preview for startup.' },
  { id: 'fixture-chat-1', title: 'Solprojekt', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Forum preview available.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Forskning', kind: 'channel', lastMessage: 'Visual validation sample.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]


// ID fixture data — 80% id, 20% English
const fixtureChatsId: Chat[] = [
  { id: 'fixture-chat-0', title: 'Keluarga', kind: 'user', lastMessage: 'Preview for startup.' },
  { id: 'fixture-chat-1', title: 'Proyek Surya', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Forum preview available.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Penelitian', kind: 'channel', lastMessage: 'Visual validation sample.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]


// CA fixture data — 80% ca, 20% English
const fixtureChatsCa: Chat[] = [
  { id: 'fixture-chat-0', title: 'Família', kind: 'user', lastMessage: 'Preview for startup.' },
  { id: 'fixture-chat-1', title: 'Projecte Solar', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Forum preview available.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Recerca', kind: 'channel', lastMessage: 'Visual validation sample.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]


// SK fixture data — 80% sk, 20% English
const fixtureChatsSk: Chat[] = [
  { id: 'fixture-chat-0', title: 'Rodina', kind: 'user', lastMessage: 'Preview for startup.' },
  { id: 'fixture-chat-1', title: 'Solárny Projekt', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Forum preview available.' },
  { id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' },
  { id: 'fixture-chat-3', title: 'Výskum', kind: 'channel', lastMessage: 'Visual validation sample.' },
  { id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' },
]

const fixtureTopics: Topic[] = [
  {
    id: 'fixture-topic-0',
    title: 'Fixture Topic Zero',
    topMessageId: 'fixture-topic-0-top',
    lastMessage: 'Topic zero warmup preview.',
  },
  {
    id: 'fixture-topic-1',
    title: 'Fixture Topic One',
    topMessageId: 'fixture-topic-1-top',
    unreadCount: 1,
    lastMessage: 'Topic one expected content preview.',
  },
  {
    id: 'fixture-topic-2',
    title: 'Fixture Topic Two',
    topMessageId: 'fixture-topic-2-top',
    unreadCount: 1,
    lastMessage: 'Topic two expected content preview.',
  },
  {
    id: 'fixture-topic-3',
    title: 'Fixture Topic Three',
    topMessageId: 'fixture-topic-3-top',
    unreadCount: 1,
    lastMessage: 'Topic three expected content preview.',
  },
  {
    id: 'fixture-topic-4',
    title: 'Fixture Topic Four',
    topMessageId: 'fixture-topic-4-top',
    lastMessage: 'Topic four expected content preview.',
  },
  {
    id: 'fixture-topic-5',
    title: 'Fixture Topic Five',
    topMessageId: 'fixture-topic-5-top',
    lastMessage: 'Topic five expected content preview.',
  },
  {
    id: 'fixture-topic-6',
    title: 'Fixture Topic Six',
    topMessageId: 'fixture-topic-6-top',
    lastMessage: 'Topic six expected content preview.',
  },
  // Anchor strings used by the simulator-driven scroll test
  // (scripts/simulator-topic-scroll.mjs). Each message in the
  // three new topics embeds its index in the body so the harness
  // can assert "I saw message N of topic T" without parsing the
  // structure of the controller's `state.messages` array.
]
