import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearFrontendConfigFromAppStorage,
  loadFrontendConfig,
  loadFrontendConfigFromAppStorage,
  saveFrontendConfig,
  saveFrontendConfigToAppStorage,
  type FrontendConfig,
} from '../src/storage'

describe('frontend settings storage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not persist Telegram credentials, sessions, or shared secret to cookies', () => {
    const localStorage = memoryStorage()
    const cookieWrites: string[] = []
    vi.stubGlobal('window', { localStorage })
    vi.stubGlobal('document', {
      get cookie() {
        return cookieWrites.join(';')
      },
      set cookie(value: string) {
        cookieWrites.push(value)
      },
    })

    saveFrontendConfig({
      apiBaseUrl: 'http://100.64.0.1:8787',
      telegramApiId: '12345',
      telegramApiHash: 'hash-secret',
      telegramSession: 'string-session-secret',
      backendSharedSecret: 'backend-secret',
      language: 'en',
      sttBaseUrl: '',
      debugEventsEnabled: false,
      chatPollMs: 10000,
      messagePollMs: 8000,
      recordingMinDurationMs: 900,
      fontWidthPercent: 100,
    })

    expect(localStorage.getItem('teleGlance.telegramApiHash')).toBe('hash-secret')
    const cookieText = cookieWrites.join('\n')
    expect(cookieText).toContain('teleGlance.apiBaseUrl=')
    expect(cookieText).not.toContain('hash-secret')
    expect(cookieText).not.toContain('string-session-secret')
    expect(cookieText).not.toContain('backend-secret')
  })

  it('saves and restores the full config from Even app storage', async () => {
    const storage = appStorage()
    const config = testConfig({
      telegramApiId: '12345',
      telegramApiHash: 'hash-secret',
      telegramSession: 'string-session-secret',
      backendSharedSecret: 'backend-secret',
    })

    await saveFrontendConfigToAppStorage(storage, config)
    const restored = await loadFrontendConfigFromAppStorage(storage, testConfig())

    expect(restored).toMatchObject({
      telegramApiId: '12345',
      telegramApiHash: 'hash-secret',
      telegramSession: 'string-session-secret',
      backendSharedSecret: 'backend-secret',
    })
  })

  it('writes the non-secret cookies SameSite=Strict, and Secure on an https origin', () => {
    for (const [protocol, secure] of [['https:', true], ['http:', false]] as const) {
      const cookieWrites: string[] = []
      vi.stubGlobal('window', { localStorage: memoryStorage(), location: { protocol } })
      vi.stubGlobal('document', {
        get cookie() { return '' },
        set cookie(value: string) { cookieWrites.push(value) },
      })
      saveFrontendConfig(testConfig())
      const apiCookie = cookieWrites.find((cookie) => cookie.startsWith('teleGlance.apiBaseUrl='))
      expect(apiCookie).toContain('SameSite=Strict')
      expect(apiCookie?.includes(';Secure')).toBe(secure)
    }
  })

  it('has no default backend and drops a URL saved from the retired shared testing backend', async () => {
    const localStorage = memoryStorage()
    vi.stubGlobal('window', { localStorage })
    vi.stubGlobal('document', { cookie: '' })
    expect(loadFrontendConfig().apiBaseUrl).toBe('')

    localStorage.setItem('teleGlance.apiBaseUrl', 'https://teleglance.akira-os.net')
    expect(loadFrontendConfig().apiBaseUrl).toBe('')
    const storage = appStorage()
    await saveFrontendConfigToAppStorage(storage, testConfig({ apiBaseUrl: 'https://teleglance.akira-os.net/' }))
    expect((await loadFrontendConfigFromAppStorage(storage, testConfig())).apiBaseUrl).toBe('')

    localStorage.setItem('teleGlance.apiBaseUrl', 'http://100.64.0.9:8787')
    expect(loadFrontendConfig().apiBaseUrl).toBe('http://100.64.0.9:8787')
  })

  it('clears the Even app storage config on reset', async () => {
    const storage = appStorage()
    await saveFrontendConfigToAppStorage(storage, testConfig({ telegramSession: 'string-session-secret' }))

    await clearFrontendConfigFromAppStorage(storage)
    const restored = await loadFrontendConfigFromAppStorage(storage, testConfig())

    expect(restored.telegramSession).toBe('')
  })
})

function testConfig(overrides: Partial<FrontendConfig> = {}): FrontendConfig {
  return {
    apiBaseUrl: 'http://100.64.0.1:8787',
    telegramApiId: '',
    telegramApiHash: '',
    telegramSession: '',
    backendSharedSecret: '',
    sttBaseUrl: '',
    language: 'en',
    debugEventsEnabled: false,
    chatPollMs: 10000,
    messagePollMs: 8000,
    recordingMinDurationMs: 900,
    fontWidthPercent: 100,
    ...overrides,
  }
}

function appStorage() {
  const values = new Map<string, string>()
  return {
    async getLocalStorage(key: string) {
      return values.get(key) ?? ''
    },
    async setLocalStorage(key: string, value: string) {
      if (value) values.set(key, value)
      else values.delete(key)
      return true
    },
  }
}

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear() {
      values.clear()
    },
    getItem(key: string) {
      return values.get(key) ?? null
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null
    },
    removeItem(key: string) {
      values.delete(key)
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
  }
}
