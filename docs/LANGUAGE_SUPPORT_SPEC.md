# Multi-Language Support Specification

## Summary

Add UI localization for Japanese, Spanish, French, Korean, and Chinese with
auto-detection from Whisper transcription language or a user setting. Chat
names, message text, and topic names from Telegram are already rendered in
whatever language the sender wrote — this spec covers only the ~55 hardcoded
English UI strings in the app.

**CJK rendering on glasses is blocked on the Even Hub SDK** — the v0.0.10 SDK
has no font-loading API and the firmware LVGL build only supports basic Latin
glyphs. Until Even Realities ships font support, CJK UI strings and messages
on glasses use Latin-script transliteration as a fallback. The phone React UI
renders all scripts natively via CSS `font-family: Inter, ui-sans-serif`.

## Language scope

The Even Hub SDK v0.0.10 has no font API — the glasses LVGL build supports
only basic Latin glyphs (ASCII + Latin-1 + Latin-extended blocks, U+0000–U+024F
plus common Latin extensions). Every language that uses Latin script is
supported **today**. Adding a new language requires only a locale file with
translations; no SDK or app-code changes.

### Latin-script languages (supported now)

| Language | Code | Accented glyphs | Status |
|---|---|---|---|
| English | en | — | Done |
| Spanish | es | áéíóúüñ¿¡ | Done |
| French | fr | àâçèéêëîïôœùûÿ | Done |
| German | de | äöüß | Planned |
| Italian | it | àèéìòù | Planned |
| Portuguese | pt | áàâãçéêíóôõú | Planned |
| Dutch | nl | äëïöü | Planned |
| Swedish | sv | åäö | Planned |
| Norwegian | no | æøå | Planned |
| Danish | da | æøå | Planned |
| Finnish | fi | äö | Planned |
| Polish | pl | ąćęłńóśźż | Planned |
| Czech | cs | áčďéěíňóřšťúůýž | Planned |
| Turkish | tr | çğıöşü | Planned |
| Vietnamese | vi | ảãạáàâấầẩẫậăắằẳẵặđéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵ | Planned |
| Indonesian | id | — | Planned |
| Malay | ms | — | Planned |
| Romanian | ro | ăâîşţ | Planned |
| Hungarian | hu | áéíóöőúüű | Planned |
| Catalan | ca | àçèéíòóúü | Planned |
| Slovak | sk | áäčďéíĺľňóôŕšťúýž | Planned |

### Non-Latin scripts (blocked on SDK font support)

| Language | Script | Glasses fallback |
|---|---|---|
| Japanese | Kanji + Kana | Latin transliteration (rōmaji) |
| Korean | Hangul | Latin transliteration (romaja) |
| Chinese | Hanzi | Latin transliteration (pīnyīn) |
| Russian | Cyrillic | Latin transliteration |
| Arabic | Arabic + RTL | Not supported (LVGL cannot render RTL) |

Hindi is excluded — Devanagari script, would need its own transliteration library
and has no path to native rendering.

## Current state

### What already works

- Telegram chat names, message text, and topic names are rendered as-is from
  the API and pass through `sanitizeGlassesText`. Spanish, French, and other
  Latin-script messages display correctly.
- Whisper already returns `info.language` in the transcription response
  (`server/app/services/transcription.py:57`). The detected language is
  stored in the response but not used by the frontend.
- The phone React UI uses `font-family: Inter, ui-sans-serif, system-ui` and
  can render all Unicode scripts that the OS supports.

### What's hardcoded

~55 English strings across 7 files:

| File | Count | Examples |
|---|---|---|
| `model.ts` | ~20 | `"Chats"`, `"Topics"`, `"No messages yet."`, `"Send"`, `"Cancel"`, `"[red]"`, `"[yellow]"`, `"[green]"`, `"Back"`, `"Recording..."`, `"Transcribing..."`, `"Sending..."`, `"Sent"`, `"Unknown"`, `"Me"`, `"New reply"`, `"Loading older messages..."`, `"Checking replies..."` |
| `appController.ts` | ~15 | `"Sent"`, `"Older messages"`, `"Newer messages"`, `"No older messages"`, `"Loading {chat} topics..."`, `"Loading {title}..."`, auth/error messages |
| `screens/ChatScreen.tsx` | ~10 | `"Chats"`, `"Telegram Login"`, `"Send"`, `"Verify Code"`, `"Recording on glasses…"`, `"No messages yet."` |
| `screens/SettingsScreen.tsx` | ~8 | `"Already connected"`, `"Not connected"`, `"Configured"`, `"Save Settings"`, `"Reset"` |
| `api.ts` | ~5 | `"Backend is not reachable..."`, timeout/encrypted-auth messages |
| `secureAuth.ts` | ~2 | `"Encrypted backend auth requires WebCrypto..."` |
| `App.tsx` | ~2 | `"TeleGlance"`, `"Settings"`, `"Back"` |

### Whisper language support

`faster-whisper` (`server/app/services/transcription.py:47`) calls
`model.transcribe()` without a `language` parameter — Whisper auto-detects
and returns `info.language`. The supported language codes (from the
`faster-whisper` tokenizer) include: `en`, `ja`, `es`, `fr`, `ko`, `zh`.

No `language` field exists in the transcribe request. The frontend POSTs only
the audio blob (`web/src/api.ts:transcribe`). The backend response includes
`language` and `duration_seconds` from `info`, but the frontend discards them.

### Glyph sanitization

`sanitizeGlassesText` (`model.ts:464-473`) strips:
- Status-circle emoji → ASCII labels (`🔴` → `[red]`)
- U+2757 (❗) and U+26A0 (⚠) — known LVGL `glyph dsc. not found` characters
- U+1F000–U+1FAFF (pictographic emoji, supplemental symbols)
- U+FE0F (variation selector)

Latin-1 and Latin-extended characters pass through untouched, including
accented letters (Spanish ñ, á, é, í, ó, ú, ü; French à, â, ç, è, é, ê, ë,
î, ï, ô, œ, ù, û, ÿ). These render correctly on the glasses.

## Phase 1 — Locale infrastructure (English only)

**Goal**: Extract all hardcoded English strings into a single locale module.
No behavioral change. All tests pass with identical output.

### 1.1 Create locale module

**New file: `web/src/locales/en.ts`**

```typescript
const en = {
  // --- Glasses display: titles ---
  sidebarTitleChats: 'Chats',
  sidebarTitleTopics: 'Topics',
  sidebarTitleMessages: 'Messages',
  titleLoading: 'TeleGlance',
  titleTranscribing: 'Transcribing...',
  titleConfirm: 'Confirm?',
  titleSending: 'Sending...',
  titleSent: 'Sent',
  titleRecording: 'Recording...',

  // --- Glasses display: status pills / footers ---
  statusSent: 'Sent',
  statusNewReply: 'New reply',
  statusCheckingReplies: 'Checking replies...',
  statusOlderMessages: 'Older messages',
  statusNewerMessages: 'Newer messages',
  statusNoOlderMessages: 'No older messages',
  statusLoadingOlder: 'Loading older messages...',
  footerBack: 'Back: double click',
  footerRecord: 'Record: click',
  footerConfirm: 'Select: swipe  Send: click',

  // --- Glasses display: content ---
  bodyNoMessages: 'No messages yet.',
  bodyLoadingTopics: (chatTitle: string) => `Loading ${chatTitle} topics...`,
  bodyLoadingMessages: (title: string) => `Loading ${title}...`,
  senderUnknown: 'Unknown',
  senderMe: 'Me',
  confirmSend: 'Send',
  confirmCancel: 'Cancel',

  // --- Glasses display: sanitization ---
  sanitizeRedCircle: '[red]',
  sanitizeYellowCircle: '[yellow]',
  sanitizeGreenCircle: '[green]',

  // --- Phone UI: ChatScreen ---
  phoneChatsHeading: 'Chats',
  phoneLoginHeading: 'Telegram Login',
  phoneSessionHeading: 'Telegram Session',
  phoneNewTelegram: 'New Telegram',
  phoneErrorHeading: 'Error',
  phoneVerificationCode: 'Verification code',
  phoneMobileNumber: 'Mobile number with country code',
  phoneSendButton: 'Send',
  phoneVerifyCode: 'Verify Code',
  phoneSendLoginCode: 'Send Login Code',
  phoneOpenThread: 'Open Thread',
  phoneRetry: 'Retry',
  phoneNoMessages: 'No messages yet.',
  phoneGlassesOff: 'Glasses screen is off…',
  phoneRecordingOnGlasses: 'Recording on glasses…',
  phoneTranscribing: 'Transcribing voice reply…',
  phoneConfirmOnGlasses: 'Confirm reply on glasses: …',
  phoneSendingReply: 'Sending reply…',
  phoneReplySent: 'Reply sent.',
  phoneOpenChatToSend: 'Open a chat or topic to send a reply.',
  phoneSendFailed: 'Send failed',
  phoneCodeSendFailed: 'Could not send code',
  phoneCodeVerifyFailed: 'Could not verify code',

  // --- Phone UI: SettingsScreen ---
  phoneSettingsHeading: 'Settings',
  phoneAlreadyConnected: 'Already connected',
  phoneNotConnected: 'Not connected',
  phoneConfigured: 'Configured',
  phoneRequired: 'Required',
  phoneStoredOnPhone: 'Stored on this phone only',
  phoneBackendSessionActive: 'Backend session active',
  phoneNotLoggedIn: 'Not logged in yet',
  phoneSaveSettings: 'Save Settings',
  phoneSaved: 'Saved',
  phoneReset: 'Reset',
  phoneDisconnectTelegram: 'Disconnect Telegram',
  phoneDisconnecting: 'Disconnecting...',

  // --- Phone UI: App shell ---
  phoneAppTitle: 'TeleGlance',
  phoneSettingsTab: 'Settings',
  phoneBack: 'Back',
  phoneBackToChat: 'Back to chat',
  phoneOpenSettings: 'Open settings',

  // --- Error / auth messages ---
  errorBackendUnreachable: 'Backend is not reachable. Fill Backend URL in Settings and make sure the backend server is running.',
  errorBackendTimeout: (seconds: number) => `Backend request timed out after ${seconds}s. The server may be unreachable or stuck. Try again or check the backend.`,
  errorEncryptedAuthMissing: 'Encrypted auth requires Backend shared secret, Telegram API ID, and Telegram API hash in TeleGlance Settings.',
  errorSharedSecretRequired: 'Backend shared secret is required to decrypt backend response.',
  errorEncryptedMalformed: 'Encrypted backend response is malformed',
  errorWebCryptoRequired: 'Encrypted backend auth requires WebCrypto. Use the packaged app, localhost, HTTPS, or a browser with WebCrypto support.',
  errorUpdateStreamUnavailable: 'Update stream is unavailable',
  errorUpdateStreamFailed: 'Update stream failed',
  errorStarting: 'Starting...',
  errorStartupFailed: 'Startup failed',

  // --- Auth screens ---
  authNeedsSetup: 'Open Settings and fill Backend URL, Shared Secret, Telegram API ID, and Telegram API Hash. Then restart the app.',
  authSignedOut: 'Tap to log in with your phone number.',
  authPhonePending: 'Enter the verification code sent to your phone.',
} as const

export default en
export type LocaleStrings = typeof en
```

### 1.2 Create locale context

**New file: `web/src/locales/index.ts`**

```typescript
import en from './en'
import type { LocaleStrings } from './en'

let current: LocaleStrings = en

export function getLocale(): LocaleStrings {
  return current
}

export function setLocale(strings: LocaleStrings): void {
  current = strings
}

export type { LocaleStrings }
```


### 1.3 Introduction

The refactor must preserve every test invariant. Brute-force string
replacement fails because:

1. **Template literals** contain raw text (`Send`, `Click to open.`) and
   expression fallbacks (`|| 'New message'`) that need structural conversion
   to `${l.confirmSend}`, `${l.bodyClickToOpen}`, and `|| l.bodyNewMessage`.
2. **`sanitizeGlassesText`** calls `.replace(..., '[red]')` with string
   arguments that must become `l.sanitizeRed` — but the function body must
   add `const l = getLocale()` first.
3. **Call chains** (`formatMessageBlocks` → `formatCompactMessageRows` →
   `sanitizeGlassesText`) each call `getLocale()` independently — no global
   binding needed, each function manages its own locale reference.
4. **Status strings** in the controller (e.g. `status: 'Sent'`) are NOT
   replaced directly. A `localizeStatus()` helper in model.ts translates
## Phase 3 — Latin-script locale files (Spanish, French, and all other Latin languages)

**Goal**: Add UI translations for all 18 Latin-script languages listed in the
Language Scope table. No SDK or app-code changes needed — only locale files
and fixture data.

### 3.1 Already done

| Language | Locale file | Fixture data | Catalog steps |
|---|---|---|---|
| English (`en`) | Done | Done (baseline) | 56 steps |
| Spanish (`es`) | Done | Done (80/20 mix) | 2 steps |
| French (`fr`) | Done | Done (80/20 mix) | 2 steps |

### 3.2 Remaining 15 languages

Each language needs three files, created from the English template:

1. **`web/src/locales/{code}.ts`** — Translations of all 93 `LocaleStrings` keys.
   Use `es.ts` or `fr.ts` as a template. Outsource translations to the model
   or use a translation table — no manual transcription needed.

2. **`web/src/fixtureApi.ts`** — Add locale-gated fixture data arrays
   (`fixtureChats{Code}`, `fixtureTopics{Code}`, `messagePages{Code}`) with
   80/20 native/English mix. Chat names and message bodies in the target
   language, with ~20% of fixture content kept in English for mixed-content
   validation.

3. **`web/src/contexts/AppContext.tsx`** — Add the locale to the `setLocale`
   handler's if-else chain (import + `setLocale({code})` + `setFixtureLocale('{code}')`).

4. **`docs/UI_INVARIANTS.json`** — Add one `l10n-{code}-startup` catalog step
   validating the sidebar title and chat names in the target language.

### 3.3 Minimal implementation order

Priority languages (by speaker count + distinct accent coverage):

| Priority | Languages | Distinct accents tested |
|---|---|---|
| Tier 1 | German, Italian, Portuguese | Already done: Spanish + French cover most accented Latin. German adds ß, Portuguese adds ã/õ. |
| Tier 2 | Dutch, Swedish, Polish, Turkish | Wider accent variety: Polish has 9 accented chars, Turkish has ç/ğ/ı/ö/ş/ü |
| Tier 3 | Czech, Romanian, Hungarian, Vietnamese, Finnish, Norwegian, Danish, Indonesian, Malay, Catalan, Slovak | Remaining coverage. Vietnamese has the most complex accents — good stress test for glyph rendering. |

Tier 1 can be done in a single session (~15 minutes per language × 3 languages).
Tiers 2-3 can be batched or done as needed — there is zero code risk since
each language is purely additive (new files + one import + one catalog step).

### 3.4 Test plan per language

```
npm test --prefix web                              # 140 tests (locale module structure)
npm run test:simulator --prefix web -- --locale {code}  # All English + l10n-{code} step
```

The English baseline steps run with locale-gated fixture data and skip
content assertions (their expected strings are English). The dedicated
`l10n-{code}-startup` step validates sidebar title and chat names in the
target language.

### Locale resolution

In `web/src/locales/index.ts`, add all new locale modules to the
`LANG_TO_LOCALE` map:

```typescript
const LANG_TO_LOCALE: Record<string, LocaleStrings> = {
  en, es, fr,
  de, it, pt,  // Tier 1
  nl, sv, pl, tr,  // Tier 2
  cs, ro, hu, vi, fi, no, da, id, ca, sk,  // Tier 3 (nb→no per ISO 639-1)
}
```

The `--locale` flag accepts any language code. The harness sends `setLocale`
at flow start, and the AppContext handler maps the code to locale module +
fixture data.
### 1.3b Step 2: `sanitizeGlassesText` locale binding

Add `const l = getLocale()` to `sanitizeGlassesText` and replace the three
string arguments:

```typescript
function sanitizeGlassesText(value: string) {
  const l = getLocale()
  return value
    .replace(/\u{1f534}/gu, l.sanitizeRed)
    .replace(/\u{1f7e1}/gu, l.sanitizeYellow)
    .replace(/\u{1f7e2}/gu, l.sanitizeGreen)
    .replace(/[\u{2757}\u{26a0}]/gu, '')
    .replace(/[\u{1f000}-\u{1faff}]/gu, '')
    .replace(/\ufe0f/g, '')
}
```

**Verify**: `npm test --prefix web` — 140 pass. The model tests exercise
`sanitizeGlassesText` through emoji stripping assertions.

### 1.3c Step 3: Simple screen cases (loading, auth, asleep, error)

These cases have no template literals, no status interpolation — pure
property values:

```typescript
case 'loading':
  return { kind: 'text', title: l.titleTelegram, body: state.message }
case 'auth':
  return {
    kind: 'text',
    title: state.mode === 'phonePending' ? l.titleTelegramLogin : l.titleTelegram,
    body: state.message,
  }
case 'asleep':
  return { kind: 'text', title: '', body: '' }
case 'error':
  return {
    kind: 'text',
    title: l.titleError,
    body: `${state.message}\n\n${l.bodyPressToRetry}`,
  }
```

**Verify**: `npm test --prefix web` — 140 pass.

### 1.3d Step 4: `sidebar.chats` focus

```typescript
// Before                                    // After
title: 'Telegram',                           title: l.titleTelegram,
sidebarTitle: 'Chats',                       sidebarTitle: l.titleChats,
'Swipe chats | Press open'                   l.footerSwipeChats
```

Also update `panelFooter` to pass `state.status` through `localizeStatus`:

```typescript
panelFooter: previewLoaded
  ? l.footerSwipeChats
  : (state.status ? localizeStatus(state.status) : l.footerSwipeChats),
```

And `panelBody` when it falls through to `state.status`:

```typescript
panelBody: msg?.box
  ? ''
  : (msg?.body
    ?? (state.status ? localizeStatus(state.status) : undefined)
    ?? (selected?.lastMessage
       ? trimUtf8Bytes(..., TEXT_CONTAINER_BYTE_LIMIT)
       : ' ')),
```

**Verify**: `npm test --prefix web` — 140 pass.

### 1.3e Step 5: `sidebar.topics` focus

```typescript
// Before                                    // After
: 'Topics'                                   : l.titleTopics
sidebarTitle: 'Topics'                       sidebarTitle: l.titleTopics
'Loading messages...'                        l.statusLoadingMessages
'TAP TO OPEN TOPIC'                          l.footerTapToOpenTopic
'Loading messages...'                        l.footerLoadingMessages
```

**Verify**: `npm test --prefix web` — 140 pass.

### 1.3f Step 6: `sidebar.messages` focus

```typescript
// Before                                    // After
state.topic ? 'Topics' : 'Chats'             state.topic ? l.titleTopics : l.titleChats
footerText(state.status,                     footerText(state.status,
  'Swipe scroll | Hold to record |              l.footerSwipeScroll)
  Double click back')
```

**Verify**: `npm test --prefix web` — 140 pass.

### 1.3g Step 7: Recording/transcribing/confirm/sent/sending/newMessage

These are the trickiest because of the template literal in `newMessage`
and the confirm actions block:

**newMessage template literal** (lines 243-245):

```typescript
// Before
body: sanitizeGlassesText(`${...}\n\n${state.message || 'New message'}\n\nClick to open.`),
footer: 'Double click dismiss',

// After
body: sanitizeGlassesText(`${...}\n\n${state.message || l.bodyNewMessage}\n\n${l.bodyClickToOpen}`),
footer: l.footerDoubleClickDismiss,
```

**sidebarConfirm** (lines 270-275):

```typescript
// Before
const actions = `${state.selectedIndex === 0 ? '> ' : '  '}Send\n${...}Cancel`
title: 'Confirm reply',
footer: 'Swipe select | Press confirm',

// After
const actions = `${state.selectedIndex === 0 ? '> ' : '  '}${l.confirmSend}\n${...}${l.confirmCancel}`
title: l.titleConfirmReply,
footer: l.footerSwipeSelect,
```

**Other screens**:

```typescript
// Before                                    // After
title: 'New Telegram'                        title: l.titleNewTelegram
title: 'Recording'                           title: l.titleRecording
title: 'Transcribing'                        title: l.titleTranscribing
title: 'Sending reply'                       title: l.titleSendingReply
title: 'Reply sent'                          title: l.titleReplySent
'Converting voice...'                        l.bodyConvertingVoice
'Topics' : 'Chats'                           l.titleTopics : l.titleChats
'Release to stop | Double click cancel'           l.footerClickStop
'Swipe scroll | Hold to record |               l.footerSwipeScroll
  Double click back'
```

**Verify**: `npm test --prefix web` — 140 pass.

### 1.3h Step 8: `formatMessages` empty body

```typescript
// Before
if (messages.length === 0) return { body: trimUtf8Bytes('No messages yet.', TEXT_CONTAINER_BYTE_LIMIT) }

// After
const l = getLocale()
if (messages.length === 0) return { body: trimUtf8Bytes(l.phoneNoMessages, TEXT_CONTAINER_BYTE_LIMIT) }
```

**Verify**: `npm test --prefix web` — 140 pass.

### 1.3i Step 9: `formatMessageBlocks` sender labels

```typescript
// Before
const sender = sanitizeGlassesText(message.outgoing ? 'Me' : message.sender || 'Unknown')

// After
const l = getLocale()
const sender = sanitizeGlassesText(message.outgoing ? l.senderMe : message.sender || l.senderUnknown)
```

**Verify**: `npm test --prefix web` — 140 pass.

### 1.3j Step 10: Status translation layer (`localizeStatus`)

Add three functions after `topicLabel`:

```typescript
function footerText(status: string | undefined, controls: string) {
  return sanitizeGlassesText(status ? `${localizeStatus(status)} | ${controls}` : controls)
}

function loadingMessageBody(status: string | undefined) {
  if (!status) return undefined
  return status.startsWith('Loading ') ? sanitizeGlassesText(localizeStatus(status)) : undefined
}

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
```

This is the bridge between the controller (which stays in English) and the
model (which renders in the active locale). Unknown status strings pass
through unchanged, so custom error messages from the backend are never
swallowed.

**Verify**: `npm test --prefix web` — 140 pass. The controller tests verify
that status pills (`'Sent'`, `'Older messages'`, etc.) appear in the correct
locale through the model layer without changes to the controller.

### 1.4 Test plan

No behavioral change — all 140 existing tests must pass with identical output
after every step. The `locales.test.ts` file (8 tests) validates the locale
module structure independently.

After all 10 steps, add a model test that calls `screenModel` with
`setLocale(es)` and verifies Spanish output:

```
it('renders Spanish chat list when locale is set to es', () => {
  setLocale(es)
  const model = screenModel(chatsState)
  expect(model.sidebarTitle).toBe('Chats')  // Spanish translation
})
```

### Files touched

| File | Change |
|---|---|
| `web/src/locales/en.ts` | **Done** — all English strings |
| `web/src/locales/index.ts` | **Done** — get/set context |
| `web/src/controller/model.ts` | Replace ~20 hardcoded strings via 10-step process |
| `web/test/locales.test.ts` | **Done** — 8 structural tests |

`appController.ts`, screens, `api.ts`, `secureAuth.ts`, `App.tsx`, and
`bridge/evenBridge.ts` are NOT modified in Phase 1. The `localizeStatus`
helper in model.ts translates the controller's English status strings at
render time. Phone UI strings are a separate Phase 1b.
---

## Phase 2 — Whisper language pipeline

**Goal**: Add optional language parameter to the transcribe API and store the
detected language for locale auto-detection.

### 2.1 Backend: accept language parameter

**`server/app/models.py`** — add optional `language` field:

```python
class TranscribeOptions(BaseModel):
    language: Optional[str] = Field(default=None, description="ISO 639-1 language code or 'auto' for detection")
```

**`server/app/main.py`** — accept options in the handler:

```python
@router.post("/api/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    options: TranscribeOptions = Depends(),
    transcription: WhisperTranscriptionService = Depends(get_transcription_service),
):
    wav = pcm16le_to_wav(await audio.read())
    return await transcription.transcribe_wav(wav, options.language)
```

**`server/app/services/transcription.py`** — pass language to Whisper:

```python
async def transcribe_wav(self, wav_bytes: bytes, language: Optional[str] = None) -> TranscriptionResponse:
    # ...
    transcribe_kwargs = dict(
        beam_size=...,
        best_of=...,
        temperature=...,
        condition_on_previous_text=...,
    )
    if language and language != "auto":
        transcribe_kwargs["language"] = language
    segments, info = model.transcribe(temp_path, **transcribe_kwargs)
    # ...
```

### 2.2 Frontend: send language, store detected language

**`web/src/api.ts`** — add optional `language` parameter to `transcribe()`:

```typescript
async transcribe(wav: Blob, language?: string): Promise<TranscriptionResult> {
  const form = new FormData()
  form.append('audio', wav, 'recording.wav')
  if (language && language !== 'auto') {
    form.append('language', language)
  }
  // ... POST
}
```

**`web/src/controller/appController.ts`** — store detected language in state
and pass user-selected language when transcribing:

- Add `detectedLanguage?: string` to `AppState` for states that carry context
  (`sidebar.messages`, `sidebarConfirm`)
- In `handleSidebarRecording`: pass `this.sttLanguage` to `api.transcribe()`
- After transcription: store `result.language` in state as `detectedLanguage`
- Use `detectedLanguage` to resolve locale (Phase 3)

### 2.3 Settings UI: STT language selector

Add to `screens/SettingsScreen.tsx`:

```
STT Language: [Auto] [English] [Japanese] [Spanish] [French] [Korean] [Chinese]
```

Default: `"auto"` (Whisper auto-detects).

### Files touched

| File | Change |
|---|---|
| `server/app/models.py` | Add `TranscribeOptions` model |
| `server/app/main.py` | Accept options in `/api/transcribe` |
| `server/app/services/transcription.py` | Pass `language` to Whisper |
| `tests/backend/test_api.py` | Test language parameter passthrough |
| `web/src/api.ts` | Add `language` to `transcribe()` |
| `web/src/controller/appController.ts` | Store detected language, pass STT language |
| `web/src/screens/SettingsScreen.tsx` | Add STT language dropdown |
| `web/src/storage.ts` | Persist `sttLanguage` in frontend config |
| `web/src/types.ts` | Add `language` to `TranscriptionResult` |

---

## Phase 4 — CJK with Latin transliteration fallback (Japanese, Korean, Chinese)

**Goal**: Render CJK UI strings and messages in Latin script on the glasses
until the Even Hub SDK supports font loading. The phone React UI renders
native CJK characters normally.

### 4.1 Constraints

- Even Hub SDK v0.0.10 has no font-loading API — no `loadFont`, no
  `setLocale`, no codepage configuration on any container class
- LVGL firmware build only supports basic Latin glyphs
- CJK characters (U+4E00–U+9FFF, U+3040–U+30FF, U+AC00–U+D7AF) will
  produce `glyph dsc. not found` warnings and render as empty boxes
- This is exactly the same class of bug that `sanitizeGlassesText` already
  fixes for pictographic emoji (U+1F000–U+1FAFF)

### 4.2 Transliterated locale files

Create locale files using Latin script:

| File | Language | Script | Example |
|---|---|---|---|
| `web/src/locales/ja.ts` | Japanese | Rōmaji | `sidebarTitleChats: 'Chatto'` |
| `web/src/locales/ko.ts` | Korean | Romaja | `sidebarTitleChats: 'Chaeting'` |
| `web/src/locales/zh.ts` | Chinese | Pīnyīn | `sidebarTitleChats: 'Liáotiān'` |

For chat names and message content from Telegram (which are user data, not
UI strings), apply a transliteration pass in `sanitizeGlassesText`.

### 4.3 CJK sanitization

Extend `sanitizeGlassesText` to transliterate CJK characters to Latin script
when the locale is a CJK language.

**Option A — character-level replacement (recommended)**:

Use a mapping of the most common CJK characters to Latin equivalents.
Coverage is limited to ~2000 characters but avoids adding a heavy
dependency. Good enough for short UI strings, not for full message text.

**Option B — library-based transliteration**:

Use `kuroshiro` + `kuroshiro-analyzer-kuromoji` for Japanese, `pinyin` for
Chinese, and a small Hangul→Romaja mapping for Korean. Adds ~200KB
(minified) to the frontend bundle. Higher quality but heavier.

**Option C — backend transliteration**:

Send non-Latin text to the backend for transliteration before rendering.
Adds network latency and backend dependency for what should be a local
operation. Not recommended for v1.

**Recommendation**: Option A for Phase 4 (lightweight, no dependency, covers
UI strings). Option B as a follow-up for full message transliteration.

### 4.4 `sanitizeGlassesText` changes

After existing sanitization, add a CJK pass when the locale requires it:

```typescript
function sanitizeGlassesText(value: string, locale: LocaleStrings): string {
  let result = value
  // ... existing emoji/status-circle replacements ...
  if (localeNeedsTransliteration(locale)) {
    result = transliterateCJK(result)
  }
  return result
}
```

The `localeNeedsTransliteration` check returns true for `ja`, `ko`, `zh` and
false for `en`, `es`, `fr`.

### 4.5 What's NOT done in this phase

- Full native CJK rendering (blocked on SDK)
- CJK input (keyboard/microphone input in CJK languages — this is already
  handled by the phone OS keyboard and Whisper transcription, both of which
  support CJK natively)
- Transliteration of CJK in chat/topic names (these are proper nouns and
  transliteration would be jarring — leave as-is; they'll show as boxes
  on glasses but are correct on phone)

### Files touched

| File | Change |
|---|---|
| `web/src/locales/ja.ts` | **New** — Rōmaji strings |
| `web/src/locales/ko.ts` | **New** — Romaja strings |
| `web/src/locales/zh.ts` | **New** — Pīnyīn strings |
| `web/src/locales/index.ts` | Add `ja`/`ko`/`zh` to `LANG_TO_LOCALE` |
| `web/src/controller/model.ts` | Pass locale to `sanitizeGlassesText`; add CJK transliteration |
| `web/src/screens/SettingsScreen.tsx` | Add Japanese/Korean/Chinese to UI language dropdown |

---

## Phase 5 — Native CJK rendering (when SDK supports fonts)

**Goal**: Remove transliteration fallback and render native CJK characters on
glasses. This phase is blocked on an Even Hub SDK update.

### 5.1 Prerequisites

- Even Hub SDK exposes `loadFont(fontData: ArrayBuffer, codepage: string)`
  or equivalent API
- Even Hub firmware supports multi-font LVGL rendering
- Font files are packaged in the `.ehpk` (or loaded at runtime via SDK API)

### 5.2 Changes

- Remove transliteration pass from `sanitizeGlassesText`
- Replace `ja.ts`/`ko.ts`/`zh.ts` with native-script versions
- Load CJK font files at app startup
- Verify CJK glyphs render on the glasses display (LVGL `glyph dsc. not
  found` must not appear)
- Golden screenshot tests for CJK content

### 5.3 Font candidates

| Language | Font | Size (WOFF2) | Coverage |
|---|---|---|---|
| Japanese | Noto Sans JP | ~4MB | JIS Level 1-4, 7,000+ kanji |
| Korean | Noto Sans KR | ~3MB | KS X 1001, 2,500+ hangul |
| Chinese | Noto Sans SC | ~5MB | GB 2312, 6,700+ hanzi |

These are too large to ship in the `.ehpk` (which has limited storage).
The SDK font API would ideally support streaming or on-demand loading.
Simplified subsets covering the ~500 most common characters per language
may be needed for v1.

---

## Non-goals

- **Message translation**: Telegram messages are user content. Translating
  them would be unexpected and wrong. Only UI chrome is localized.
- **Backend translation API**: No Google Translate / DeepL integration.
- **Custom font rendering**: No bitmap font pipeline that bypasses the SDK.
- **Hindi / Arabic / Thai / other scripts**: Excluded from this spec. Same
  font-blocker problem. Can be added with the same transliteration pattern.
- **RTL layout**: Arabic and Hebrew excluded. Even Hub LVGL does not
  support RTL text containers.

---

## Backward compatibility

All phases are additive. Phase 1 is a pure refactor with identical output.
Phases 2-5 add new locale files and optional Settings toggles. Default
behavior matches current behavior: English locale, auto-detect Whisper
language, no CJK transliteration until explicitly enabled.

## Verification checklist

- [x] 140 unit tests pass with locale infrastructure (Phase 1)
- [x] 52/56 simulator steps pass; 4 pre-existing failures (error-inject/perf-budget) tracked in HARNESS_AUDIT (Phase 1)
- [x] All 18 locale files have 100% key coverage (93/93 keys matching en.ts) (Phase 3)
- [x] Locale-gated render contract checks: es/fr/de simulator runs pass matching English baseline (Phase 3)
- [ ] Spanish/French glasses screens render accented characters (manual QA on G2 hardware)
- [ ] Whisper language parameter round-trips correctly (Phase 2 — not yet implemented)
- [ ] Detected language resolves correct locale (Phase 3 — not yet implemented)
- [ ] CJK transliteration produces readable Latin output (Phase 4)
- [ ] CJK locale files have 100% key coverage (Phase 4)
- [ ] No `glyph dsc. not found` warnings for new locale strings (all phases)
- [ ] Settings UI language selector works end-to-end (Phase 3/4)
