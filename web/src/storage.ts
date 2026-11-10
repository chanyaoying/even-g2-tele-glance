import { API_BASE_URL_STORAGE_KEY, G2_TELE_API_BASE_URL_STORAGE_KEY, LEGACY_API_BASE_URL_STORAGE_KEY, defaultApiBaseUrl } from './api'

const DEBUG_EVENTS_STORAGE_KEY = 'teleGlance.debugEventsEnabled'
const CHAT_POLL_STORAGE_KEY = 'teleGlance.chatPollMs'
const MESSAGE_POLL_STORAGE_KEY = 'teleGlance.messagePollMs'
const RECORDING_MIN_STORAGE_KEY = 'teleGlance.recordingMinDurationMs'
const FONT_WIDTH_STORAGE_KEY = 'teleGlance.fontWidthPercent'
const STT_BASE_URL_STORAGE_KEY = 'teleGlance.sttBaseUrl'
const LANGUAGE_STORAGE_KEY = 'teleGlance.language'
const BACKEND_SHARED_SECRET_STORAGE_KEY = 'teleGlance.backendSharedSecret'
const TELEGRAM_API_ID_STORAGE_KEY = 'teleGlance.telegramApiId'
const TELEGRAM_API_HASH_STORAGE_KEY = 'teleGlance.telegramApiHash'
const TELEGRAM_SESSION_STORAGE_KEY = 'teleGlance.telegramSession'
const G2_TELE_DEBUG_EVENTS_STORAGE_KEY = 'g2Tele.debugEventsEnabled'
const G2_TELE_CHAT_POLL_STORAGE_KEY = 'g2Tele.chatPollMs'
const G2_TELE_MESSAGE_POLL_STORAGE_KEY = 'g2Tele.messagePollMs'
const G2_TELE_RECORDING_MIN_STORAGE_KEY = 'g2Tele.recordingMinDurationMs'
const G2_TELE_STT_BASE_URL_STORAGE_KEY = 'g2Tele.sttBaseUrl'
const G2_TELE_BACKEND_SHARED_SECRET_STORAGE_KEY = 'g2Tele.backendSharedSecret'
const G2_TELE_TELEGRAM_API_ID_STORAGE_KEY = 'g2Tele.telegramApiId'
const G2_TELE_TELEGRAM_API_HASH_STORAGE_KEY = 'g2Tele.telegramApiHash'
const G2_TELE_TELEGRAM_SESSION_STORAGE_KEY = 'g2Tele.telegramSession'
const LEGACY_DEBUG_EVENTS_STORAGE_KEY = 'evenTelegram.debugEventsEnabled'
const LEGACY_CHAT_POLL_STORAGE_KEY = 'evenTelegram.chatPollMs'
const LEGACY_MESSAGE_POLL_STORAGE_KEY = 'evenTelegram.messagePollMs'
const LEGACY_RECORDING_MIN_STORAGE_KEY = 'evenTelegram.recordingMinDurationMs'
const EVEN_APP_CONFIG_STORAGE_KEY = 'teleGlance.frontendConfig.v1'

const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60

export type FrontendConfig = {
  apiBaseUrl: string
  telegramApiId: string
  telegramApiHash: string
  telegramSession: string
  language: string
  debugEventsEnabled: boolean
  chatPollMs: number
  messagePollMs: number
  recordingMinDurationMs: number
  /** Correction (%) to the measured glasses font width: raise if lines wrap twice on the glasses, lower if they stop short. */
  fontWidthPercent: number
  sttBaseUrl: string
  backendSharedSecret: string
}

export type AppStorageBridge = {
  getLocalStorage?(key: string): Promise<string>
  setLocalStorage?(key: string, value: string): Promise<boolean>
}

export const DEFAULT_FRONTEND_CONFIG: Omit<FrontendConfig, 'apiBaseUrl'> = {
  telegramApiId: '',
  telegramApiHash: '',
  telegramSession: '',
  language: 'en',
  debugEventsEnabled: false,
  chatPollMs: 10000,
  messagePollMs: 8000,
  recordingMinDurationMs: 900,
  fontWidthPercent: 100,
  sttBaseUrl: '',
  backendSharedSecret: '',
}

export function loadFrontendConfig(): FrontendConfig {
  return {
    apiBaseUrl: defaultApiBaseUrl(),
    telegramApiId: readSensitiveString(TELEGRAM_API_ID_STORAGE_KEY, G2_TELE_TELEGRAM_API_ID_STORAGE_KEY),
    telegramApiHash: readSensitiveString(TELEGRAM_API_HASH_STORAGE_KEY, G2_TELE_TELEGRAM_API_HASH_STORAGE_KEY),
    telegramSession: readSensitiveString(TELEGRAM_SESSION_STORAGE_KEY, G2_TELE_TELEGRAM_SESSION_STORAGE_KEY),
    language: readString(LANGUAGE_STORAGE_KEY),
    debugEventsEnabled: readBoolean(DEBUG_EVENTS_STORAGE_KEY, DEFAULT_FRONTEND_CONFIG.debugEventsEnabled, G2_TELE_DEBUG_EVENTS_STORAGE_KEY, LEGACY_DEBUG_EVENTS_STORAGE_KEY),
    chatPollMs: readNumber(CHAT_POLL_STORAGE_KEY, DEFAULT_FRONTEND_CONFIG.chatPollMs, 1000, 60000, G2_TELE_CHAT_POLL_STORAGE_KEY, LEGACY_CHAT_POLL_STORAGE_KEY),
    messagePollMs: readNumber(MESSAGE_POLL_STORAGE_KEY, DEFAULT_FRONTEND_CONFIG.messagePollMs, 1000, 60000, G2_TELE_MESSAGE_POLL_STORAGE_KEY, LEGACY_MESSAGE_POLL_STORAGE_KEY),
    recordingMinDurationMs: readNumber(RECORDING_MIN_STORAGE_KEY, DEFAULT_FRONTEND_CONFIG.recordingMinDurationMs, 0, 5000, G2_TELE_RECORDING_MIN_STORAGE_KEY, LEGACY_RECORDING_MIN_STORAGE_KEY),
    fontWidthPercent: readNumber(FONT_WIDTH_STORAGE_KEY, DEFAULT_FRONTEND_CONFIG.fontWidthPercent, 70, 150),
    sttBaseUrl: readString(STT_BASE_URL_STORAGE_KEY, G2_TELE_STT_BASE_URL_STORAGE_KEY),
    backendSharedSecret: readSensitiveString(BACKEND_SHARED_SECRET_STORAGE_KEY, G2_TELE_BACKEND_SHARED_SECRET_STORAGE_KEY),
  }
}


export async function loadFrontendConfigFromAppStorage(
  storage: AppStorageBridge | undefined,
  fallback: FrontendConfig,
): Promise<FrontendConfig> {
  if (!storage?.getLocalStorage) return fallback
  try {
    const raw = await storage.getLocalStorage(EVEN_APP_CONFIG_STORAGE_KEY)
    if (!raw) return fallback
    const stored = JSON.parse(raw) as Partial<FrontendConfig>
    return normalizeConfig({ ...fallback, ...stored })
  } catch {
    return fallback
  }
}

export function saveFrontendConfig(config: FrontendConfig) {
  const normalized = normalizeConfig(config)
  const apiBaseUrl = normalized.apiBaseUrl
  writeString(API_BASE_URL_STORAGE_KEY, apiBaseUrl)
  safeLsRemoveItem(G2_TELE_API_BASE_URL_STORAGE_KEY)
  safeLsRemoveItem(LEGACY_API_BASE_URL_STORAGE_KEY)
  writeSensitiveString(TELEGRAM_API_ID_STORAGE_KEY, normalized.telegramApiId)
  writeSensitiveString(TELEGRAM_API_HASH_STORAGE_KEY, normalized.telegramApiHash)
  writeSensitiveString(TELEGRAM_SESSION_STORAGE_KEY, normalized.telegramSession)
  writeString(LANGUAGE_STORAGE_KEY, normalized.language)
  safeLsSetItem(DEBUG_EVENTS_STORAGE_KEY, String(normalized.debugEventsEnabled))
  safeLsSetItem(CHAT_POLL_STORAGE_KEY, String(normalized.chatPollMs))
  safeLsSetItem(MESSAGE_POLL_STORAGE_KEY, String(normalized.messagePollMs))
  safeLsSetItem(RECORDING_MIN_STORAGE_KEY, String(normalized.recordingMinDurationMs))
  safeLsSetItem(FONT_WIDTH_STORAGE_KEY, String(normalized.fontWidthPercent))
  writeString(STT_BASE_URL_STORAGE_KEY, normalized.sttBaseUrl)
  writeSensitiveString(BACKEND_SHARED_SECRET_STORAGE_KEY, normalized.backendSharedSecret)
}

export async function saveFrontendConfigToAppStorage(
  storage: AppStorageBridge | undefined,
  config: FrontendConfig,
) {
  if (!storage?.setLocalStorage) return
  try {
    await storage.setLocalStorage(EVEN_APP_CONFIG_STORAGE_KEY, JSON.stringify(normalizeConfig(config)))
  } catch { /* app storage unavailable */ }
}

export async function clearFrontendConfigFromAppStorage(storage: AppStorageBridge | undefined) {
  if (!storage?.setLocalStorage) return
  try {
    await storage.setLocalStorage(EVEN_APP_CONFIG_STORAGE_KEY, '')
  } catch { /* app storage unavailable */ }
}

export function resetFrontendConfig() {
  safeLsRemoveItem(API_BASE_URL_STORAGE_KEY)
  safeLsRemoveItem(LEGACY_API_BASE_URL_STORAGE_KEY)
  safeLsRemoveItem(G2_TELE_API_BASE_URL_STORAGE_KEY)
  safeLsRemoveItem(TELEGRAM_API_ID_STORAGE_KEY)
  safeLsRemoveItem(TELEGRAM_API_HASH_STORAGE_KEY)
  safeLsRemoveItem(TELEGRAM_SESSION_STORAGE_KEY)
  safeLsRemoveItem(LANGUAGE_STORAGE_KEY)
  safeLsRemoveItem(DEBUG_EVENTS_STORAGE_KEY)
  safeLsRemoveItem(CHAT_POLL_STORAGE_KEY)
  safeLsRemoveItem(MESSAGE_POLL_STORAGE_KEY)
  safeLsRemoveItem(RECORDING_MIN_STORAGE_KEY)
  safeLsRemoveItem(FONT_WIDTH_STORAGE_KEY)
  safeLsRemoveItem(STT_BASE_URL_STORAGE_KEY)
  safeLsRemoveItem(BACKEND_SHARED_SECRET_STORAGE_KEY)
  safeLsRemoveItem(G2_TELE_TELEGRAM_API_ID_STORAGE_KEY)
  safeLsRemoveItem(G2_TELE_TELEGRAM_API_HASH_STORAGE_KEY)
  safeLsRemoveItem(G2_TELE_TELEGRAM_SESSION_STORAGE_KEY)
  safeLsRemoveItem(G2_TELE_DEBUG_EVENTS_STORAGE_KEY)
  safeLsRemoveItem(G2_TELE_CHAT_POLL_STORAGE_KEY)
  safeLsRemoveItem(G2_TELE_MESSAGE_POLL_STORAGE_KEY)
  safeLsRemoveItem(G2_TELE_RECORDING_MIN_STORAGE_KEY)
  safeLsRemoveItem(G2_TELE_STT_BASE_URL_STORAGE_KEY)
  safeLsRemoveItem(G2_TELE_BACKEND_SHARED_SECRET_STORAGE_KEY)
  safeLsRemoveItem(LEGACY_DEBUG_EVENTS_STORAGE_KEY)
  safeLsRemoveItem(LEGACY_CHAT_POLL_STORAGE_KEY)
  safeLsRemoveItem(LEGACY_MESSAGE_POLL_STORAGE_KEY)
  safeLsRemoveItem(LEGACY_RECORDING_MIN_STORAGE_KEY)
  removeCookie(TELEGRAM_API_ID_STORAGE_KEY)
  removeCookie(TELEGRAM_API_HASH_STORAGE_KEY)
  removeCookie(TELEGRAM_SESSION_STORAGE_KEY)
  removeCookie(BACKEND_SHARED_SECRET_STORAGE_KEY)
  removeCookie(STT_BASE_URL_STORAGE_KEY)
  removeCookie(API_BASE_URL_STORAGE_KEY)
}

// --- Safe localStorage wrappers ---



function safeLsGetItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeLsSetItem(key: string, value: string) {
  try {
    if (value) window.localStorage.setItem(key, value)
    else window.localStorage.removeItem(key)
  } catch { /* storage unavailable */ }
}

function safeLsRemoveItem(key: string) {
  try {
    window.localStorage.removeItem(key)
  } catch { /* storage unavailable */ }
}

// --- Cookie fallback for critical string settings ---

function readCookie(key: string): string | null {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${encodeURIComponent(key)}=([^;]*)`))
    return match ? decodeURIComponent(match[1]) : null
  } catch {
    return null
  }
}

function writeCookie(key: string, value: string) {
  try {
    const encodedKey = encodeURIComponent(key)
    if (value) {
      const encodedValue = encodeURIComponent(value)
      document.cookie = `${encodedKey}=${encodedValue};max-age=${COOKIE_MAX_AGE_SECONDS};path=/;SameSite=Lax`
    } else {
      document.cookie = `${encodedKey}=;max-age=0;path=/;SameSite=Lax`
    }
  } catch { /* cookies unavailable */ }
}

function removeCookie(key: string) {
  writeCookie(key, '')
}

// --- Storage readers with cookie fallback ---

function readString(key: string, ...legacyKeys: string[]) {
  for (const candidate of [key, ...legacyKeys]) {
    const value = safeLsGetItem(candidate)?.trim()
    if (value) return value
  }
  const cookieValue = readCookie(key)?.trim()
  if (cookieValue) return cookieValue
  return ''
}

function readSensitiveString(key: string, ...legacyKeys: string[]) {
  for (const candidate of [key, ...legacyKeys]) {
    const value = safeLsGetItem(candidate)?.trim()
    if (value) return value
  }
  return ''
}

function writeString(key: string, value: string) {
  const trimmed = value.trim()
  safeLsSetItem(key, trimmed)
  writeCookie(key, trimmed)
}

function writeSensitiveString(key: string, value: string) {
  safeLsSetItem(key, value.trim())
  removeCookie(key)
}

function readBoolean(key: string, fallback: boolean, ...legacyKeys: string[]) {
  const value = readRaw(key, legacyKeys)
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function readNumber(key: string, fallback: number, min: number, max: number, ...legacyKeys: string[]) {
  const raw = readRaw(key, legacyKeys)
  if (raw === null || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return clamp(value, min, max)
}

function readRaw(key: string, legacyKeys: string[]) {
  for (const candidate of [key, ...legacyKeys]) {
    const value = safeLsGetItem(candidate)
    if (value !== null) return value
  }
  return null
}
function normalizeConfig(config: FrontendConfig): FrontendConfig {
  return {
    apiBaseUrl: stringValue(config.apiBaseUrl),
    telegramApiId: stringValue(config.telegramApiId),
    telegramApiHash: stringValue(config.telegramApiHash),
    telegramSession: stringValue(config.telegramSession),
    language: stringValue(config.language) || 'en',
    debugEventsEnabled: Boolean(config.debugEventsEnabled),
    chatPollMs: clamp(numberValue(config.chatPollMs), 1000, 60000),
    messagePollMs: clamp(numberValue(config.messagePollMs), 1000, 60000),
    recordingMinDurationMs: clamp(numberValue(config.recordingMinDurationMs), 0, 5000),
    fontWidthPercent: clamp(numberValue(config.fontWidthPercent) || DEFAULT_FRONTEND_CONFIG.fontWidthPercent, 70, 150),
    sttBaseUrl: stringValue(config.sttBaseUrl),
    backendSharedSecret: stringValue(config.backendSharedSecret),
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(Math.round(value), min), max)
}
