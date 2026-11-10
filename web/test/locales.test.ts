import { describe, expect, it } from 'vitest'
import en from '../src/locales/en'
import type { LocaleStrings } from '../src/locales/en'
import { getLocale, LANGUAGE_NAMES, localeFromCode, setLocale } from '../src/locales'

// Dynamic string-key access: LocaleStrings is { [K in keyof typeof en]: string }
// which doesn't have a string index signature. Cast for lookup loops.
const $ = en as Record<string, string>

describe('locale modules', () => {
  it('en.ts has all required key categories', () => {
    const requiredSections = [
      'titleTelegram', 'titleTelegramLogin', 'titleTopics', 'titleChats',
      'titleNewTelegram', 'titleRecordingReply', 'titleRecording',
      'titleTranscribing', 'titleConfirmReply', 'titleSendingReply',
      'titleReplySent', 'titleError',
    ]
    for (const key of requiredSections) {
      expect($[key]).toBeDefined()
      expect(typeof $[key]).toBe('string')
    }
  })

  it('en.ts has all status labels', () => {
    const required = [
      'statusSent', 'statusOlderMessages', 'statusNewerMessages',
      'statusNoOlderMessages', 'statusNewReply', 'statusLoadingOlderMessages',
      'statusLoadingMessages',
    ]
    for (const key of required) {
      expect($[key]).toBeDefined()
    }
  })

  it('en.ts has all footer strings', () => {
    const required = [
      'footerSwipeChats', 'footerTapToOpenTopic', 'footerSwipeScroll',
      'footerClickStop', 'footerSwipeSelect', 'footerDoubleClickDismiss',
    ]
    for (const key of required) {
      expect($[key]).toBeDefined()
    }
  })

  it('en.ts has all body/content strings', () => {
    const required = [
      'bodyNewMessage', 'bodyClickToOpen', 'bodyPressToRetry',
      'bodyConvertingVoice', 'confirmSend', 'confirmCancel',
      'senderMe', 'senderUnknown', 'sanitizeRed', 'sanitizeYellow',
      'sanitizeGreen',
    ]
    for (const key of required) {
      expect($[key]).toBeDefined()
    }
  })

  it('en.ts has all phone UI strings', () => {
    const required = [
      'phoneAppTitle', 'phoneScreenOff', 'phoneRecording', 'phoneTranscribing',
      'phoneConfirmOnGlasses', 'phoneSendingReply', 'phoneReplySent',
      'phoneNoMessages', 'phoneOpenChatToSend', 'phoneSendFailed',
      'phoneChatsHeading',
    ]
    for (const key of required) {
      expect($[key]).toBeDefined()
    }
  })

  it('en.ts has all error/auth strings', () => {
    const required = [
      'errorBackendUnreachable', 'errorStartupFailed', 'errorUnexpected',
      'authNeedsSetup', 'authSignedOut', 'authPhonePending',
    ]
    for (const key of required) {
      expect($[key]).toBeDefined()
    }
  })

  it('setLocale updates getLocale', () => {
    const original = getLocale()
    // Create a minimal locale that satisfies the type
    const mock: LocaleStrings = { ...en, titleTelegram: 'TestApp' }
    setLocale(mock)
    expect(getLocale().titleTelegram).toBe('TestApp')
    // Restore
    setLocale(original)
    expect(getLocale().titleTelegram).toBe('Telegram')
  })

  it('getLocale default returns English', () => {
    expect(getLocale()).toBe(en)
  })
})

/**
 * Every locale spreads `...en`, so a missing key silently shows English. A value equal to the English one is only
 * accepted for brand names and words that are the same in that language.
 */
const SAME_AS_EN_EVERYWHERE = new Set([
  'titleTelegram', 'settingsTelegramSection', 'phoneAppTitle', 'settingsTelegramApiId', 'settingsTelegramApiHash',
])
const SAME_AS_EN_BY_LOCALE: Record<string, string[]> = {
  es: ['titleChats', 'phoneChatsHeading', 'settingsBackendSection', 'titleError', 'phoneErrorHeading', 'phoneSticker'],
  fr: ['titleChats', 'phoneChatsHeading', 'settingsBackendSection', 'settingsSessionLabel', 'phoneSticker', 'phonePhoto', 'dateDayLabel'],
  de: ['titleChats', 'phoneChatsHeading', 'settingsBackendSection', 'settingsStatusLabel', 'statusOffline'],
  it: ['settingsBackendSection', 'settingsBuildSection', 'phoneSticker', 'dateDayLabel'],
  pt: ['titleChats', 'phoneChatsHeading', 'settingsBackendSection', 'settingsStatusLabel'],
  nl: ['titleChats', 'phoneChatsHeading', 'settingsBackendSection', 'settingsStatusLabel', 'settingsBuildSection', 'phoneSticker', 'settingsReset', 'statusOffline', 'dateDayLabel'],
  sv: ['settingsBackendSection', 'settingsStatusLabel', 'settingsSessionLabel', 'dateDayLabel'],
  pl: ['settingsBackendSection', 'settingsStatusLabel'],
  cs: ['settingsBackendSection', 'settingsStatusLabel'],
  ro: ['settingsBackendSection', 'settingsStatusLabel', 'settingsBuildSection'],
  hu: ['settingsBackendSection', 'settingsBackendUrl'],
  vi: ['settingsBackendSection'],
  no: ['settingsBackendSection', 'settingsStatusLabel', 'confirmSend', 'phoneSend'],
  da: ['settingsBackendSection', 'settingsStatusLabel', 'phoneChatsHeading', 'settingsSessionLabel', 'confirmSend', 'phoneSend'],
  id: ['settingsBackendSection', 'settingsStatusLabel', 'titleError', 'phoneErrorHeading', 'settingsBuildSection'],
  ca: ['titleError', 'phoneErrorHeading'],
  sk: ['settingsBackendSection'],
  ms: ['settingsBackendSection', 'settingsStatusLabel'],
}
const otherLocales = Object.keys(LANGUAGE_NAMES).filter((code) => code !== 'en')
const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort()

describe('locale completeness', () => {
  it('knows every non-English locale', () => {
    expect(otherLocales).toHaveLength(23)
    for (const code of otherLocales) expect(localeFromCode(code)).not.toBe(en)
  })

  it.each(otherLocales)('%s translates every English string', (code) => {
    const locale = localeFromCode(code) as Record<string, unknown>
    const allowed = new Set([...SAME_AS_EN_EVERYWHERE, ...(SAME_AS_EN_BY_LOCALE[code] ?? [])])
    const untranslated = Object.keys(en).filter((key) => !allowed.has(key) && locale[key] === $[key])
    expect(untranslated).toEqual([])
  })

  it.each(otherLocales)('%s keeps the English placeholders', (code) => {
    const locale = localeFromCode(code) as unknown as Record<string, string>
    const mismatched = Object.keys(en).filter((key) => placeholders(locale[key]).join() !== placeholders($[key]).join())
    expect(mismatched).toEqual([])
  })

  it('has no stale same-as-English allowlist entries', () => {
    for (const [code, keys] of Object.entries(SAME_AS_EN_BY_LOCALE)) {
      const locale = localeFromCode(code) as Record<string, unknown>
      for (const key of keys) expect({ code, key, same: locale[key] === $[key] }).toEqual({ code, key, same: true })
    }
  })
})
