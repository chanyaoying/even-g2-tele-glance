import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { effectiveBackendSharedSecret, HttpTelegramApi, type ConnectionTestResult, type TelegramApi } from '../api'
import { EvenHubGlassesBridge } from '../bridge/evenBridge'
import { TelegramAppController, type ControllerRuntimeConfig, type GlassesBridge } from '../controller/appController'
import type { AppInput, AppState, ScreenModel } from '../controller/model'
import { FixtureTelegramApi, bindFixtureApi, bindFixtureCommandHandler, setFixtureLocale } from '../fixtureApi'
import { InstrumentedTelegramApi } from '../instrumentedApi'
import { localeFromCode, setLocale } from '../locales'
import { PersistentCache, cacheAccountStamp } from '../cache/persistentCache'

import {
  clearFrontendConfigFromAppStorage,
  loadFrontendConfig,
  loadFrontendConfigFromAppStorage,
  resetFrontendConfig,
  saveFrontendConfig,
  saveFrontendConfigToAppStorage,
  type AppStorageBridge,
  type FrontendConfig,
} from '../storage'
import { isTeleGlanceFixtureMode, logLifecycleEvent, logTeleGlanceTest, summarizeAppState } from '../testMode'

type AppContextValue = {
  state: AppState
  settings: FrontendConfig
  startupError: string | null
  dispatch: (input: AppInput) => Promise<void>
  sendText: (text: string) => Promise<void>
  startPhoneLogin: (phone: string) => Promise<void>
  verifyPhoneLogin: (phone: string, code: string, password?: string) => Promise<void>
  saveSettings: (settings: FrontendConfig) => Promise<void>
  resetSettings: () => Promise<void>
  logoutTelegram: () => Promise<void>
  clearCache: () => Promise<void>
  testConnection: (settings: FrontendConfig) => Promise<ConnectionTestResult>
  localeVersion: number
}

const AppContext = createContext<AppContextValue | null>(null)

const fallbackBridge: GlassesBridge = {
  render: async (_model: ScreenModel) => undefined,
  setAudioEnabled: async (_enabled: boolean) => undefined,
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(loadFrontendConfig)
  const [state, setState] = useState<AppState>({ screen: 'loading', message: 'Starting...' })
  const [startupError, setStartupError] = useState<string | null>(null)
  const [localeVersion, setLocaleVersion] = useState(0)
  const settingsRef = useRef(settings)
  const controllerRef = useRef<TelegramAppController | null>(null)
  const apiRef = useRef<TelegramApi | null>(null)
  const appStorageRef = useRef<AppStorageBridge | undefined>(undefined)

  settingsRef.current = settings

  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | undefined
    let unsubscribeUpdates: (() => void) | undefined
    let glasses: GlassesBridge | undefined
    let controller: TelegramAppController | undefined
    let unbindFixtureCommands: (() => void) | undefined

    async function start() {
      try {
        glasses = await EvenHubGlassesBridge.create(
          (input) => controllerRef.current?.dispatch(input),
          {
            debugEventsEnabled: () => settingsRef.current.debugEventsEnabled,
            authConfig: () => settingsRef.current,
            dispatchContextProvider: () => controllerRef.current?.getDispatchContext() ?? { inputQuiet: false, backgroundWorkActive: false },
          },
        ).catch(() => fallbackBridge)
        if (!active) return
        appStorageRef.current = glasses
        const fixtureMode = isTeleGlanceFixtureMode()
        const restoredSettings = fixtureMode
          ? fixtureSettings(settingsRef.current)
          : await loadFrontendConfigFromAppStorage(appStorageRef.current, settingsRef.current)
        settingsRef.current = restoredSettings
        setSettings(restoredSettings)
        setLocale(localeFromCode(restoredSettings.language))
        if (!fixtureMode) {
          saveFrontendConfig(restoredSettings)
          await saveFrontendConfigToAppStorage(appStorageRef.current, restoredSettings)
        }
        const baseApi: TelegramApi = fixtureMode
          ? new FixtureTelegramApi()
          : new HttpTelegramApi(
              restoredSettings.apiBaseUrl,
              () => settingsRef.current,
              () => controllerRef.current?.isInputQuiet() ?? false,
            )
        if (fixtureMode) bindFixtureApi(baseApi as FixtureTelegramApi)
        const api = new InstrumentedTelegramApi(baseApi)
        apiRef.current = api
        if (fixtureMode) logLifecycleEvent('start', {})
        // Last known chats and recent threads, so a launch shows something before the network answers.
        const persistentCache = fixtureMode
          ? undefined
          : new PersistentCache(appStorageRef.current, { canWrite: () => !(controllerRef.current?.isInputQuiet() ?? false) })
        await persistentCache?.open(cacheAccountStamp({
          apiId: restoredSettings.telegramApiId.trim(),
          apiHash: restoredSettings.telegramApiHash.trim(),
          session: restoredSettings.telegramSession.trim(),
          backend: restoredSettings.apiBaseUrl.trim(),
        })).catch(() => undefined)
        const createdController = new TelegramAppController(
          api,
          glasses,
          runtimeConfig(settingsRef.current),
          (session) => {
            const next = { ...settingsRef.current, telegramSession: session }
            saveFrontendConfig(next)
            void saveFrontendConfigToAppStorage(appStorageRef.current, next)
            settingsRef.current = next
            if (active) setSettings(next)
          },
          () => {
            if (fixtureMode) return true
            const settings = settingsRef.current
            const telegramOk = Boolean(settings.telegramApiId.trim() && settings.telegramApiHash.trim())
            return telegramOk && Boolean(settings.apiBaseUrl.trim()) && Boolean(effectiveBackendSharedSecret(settings, settings.apiBaseUrl))
          },
          persistentCache,
        )
        controller = createdController
        controllerRef.current = createdController
        if (fixtureMode) {
          unbindFixtureCommands = bindFixtureCommandHandler(async (command) => {
            if (command.kind === 'setLocale') {
              const code = command.locale as string
              setLocale(localeFromCode(code))
              setFixtureLocale(code)
              await createdController.init()
            }
            if (command.kind === 'setMode') {
              const mode = command.mode as 'normal' | 'missing' | 'signedOut' | 'error' | 'slow'
              ;(baseApi as FixtureTelegramApi).setMode(mode)
            }
            if (command.kind === 'reinitialize') {
              await createdController.init()
            }
            if (command.kind === 'injectAudioChunks') {
              const base64 = command.pcmBase64 as string
              const pcm = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
              await createdController.dispatch({ type: 'audioChunk', pcm, injected: true })
            }
          })
        }
        unsubscribe = createdController.subscribe((next) => {
          logTeleGlanceTest('state', summarizeAppState(next))
          if (active) setState(next)
        })
        await createdController.init()
        unsubscribeUpdates = api.subscribeUpdates(
          (update) => {
            void createdController.handleTelegramUpdate(update)
          },
          undefined,
          () => {
            void createdController.handleStreamReconnect()
          },
        )
      } catch (error) {
        if (active) setStartupError(error instanceof Error ? error.message : 'Startup failed')
      }
    }

    void start()
    return () => {
      active = false
      unsubscribe?.()
      unsubscribeUpdates?.()
      controller?.dispose()
      unbindFixtureCommands?.()
      glasses?.dispose?.()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [])

  const dispatch = useCallback(async (input: AppInput) => {
    await controllerRef.current?.dispatch(input)
  }, [])

  const sendText = useCallback(async (text: string) => {
    await controllerRef.current?.sendTextFromPhone(text)
  }, [])

  const startPhoneLogin = useCallback(async (phone: string) => {
    await controllerRef.current?.startPhoneLogin(phone)
  }, [])

  const verifyPhoneLogin = useCallback(async (phone: string, code: string, password?: string) => {
    await controllerRef.current?.verifyPhoneLogin(phone, code, password)
  }, [])

  const handleSaveSettings = useCallback(async (next: FrontendConfig) => {
    const previous = settingsRef.current
    settingsRef.current = next
    saveFrontendConfig(next)
    await saveFrontendConfigToAppStorage(appStorageRef.current, next)
    setSettings(next)
    controllerRef.current?.updateRuntimeConfig(runtimeConfig(next))
    // Apply locale immediately so both the phone React UI and the glasses
    // screen-model rendering switch to the new language without a page reload.
    if (next.language !== previous.language) {
      setLocale(localeFromCode(next.language))
      setLocaleVersion(v => v + 1)
      controllerRef.current?.rebuildGlasses()
    }
    if (
      next.apiBaseUrl.trim() !== previous.apiBaseUrl.trim()
      || next.telegramApiId.trim() !== previous.telegramApiId.trim()
      || next.telegramApiHash.trim() !== previous.telegramApiHash.trim()
      || next.telegramSession.trim() !== previous.telegramSession.trim()
      || next.backendSharedSecret.trim() !== previous.backendSharedSecret.trim()
      || next.sttBaseUrl.trim() !== previous.sttBaseUrl.trim()
    ) {
      window.location.reload()
    }
  }, [])
  const handleResetSettings = useCallback(async () => {
    await controllerRef.current?.clearCache().catch(() => undefined)
    resetFrontendConfig()
    await clearFrontendConfigFromAppStorage(appStorageRef.current)
    window.location.reload()
  }, [])

  const clearCache = useCallback(async () => {
    await controllerRef.current?.clearCache()
  }, [])

  const testConnection = useCallback(async (draft: FrontendConfig) => {
    const api = isTeleGlanceFixtureMode() && apiRef.current ? apiRef.current : new HttpTelegramApi(draft.apiBaseUrl, () => draft)
    return api.testConnection()
  }, [])

  const logoutTelegram = useCallback(async () => {
    await controllerRef.current?.clearCache().catch(() => undefined)
    await apiRef.current?.logout()
    const next = { ...settingsRef.current, telegramSession: '' }
    saveFrontendConfig(next)
    await saveFrontendConfigToAppStorage(appStorageRef.current, next)
    window.location.reload()
  }, [])

  const value = useMemo<AppContextValue>(() => ({
    state,
    settings,
    startupError,
    localeVersion,
    dispatch,
    sendText,
    startPhoneLogin,
    verifyPhoneLogin,
    saveSettings: handleSaveSettings,
    resetSettings: handleResetSettings,
    logoutTelegram,
    clearCache,
    testConnection,
  }), [clearCache, testConnection, dispatch, handleResetSettings, handleSaveSettings, localeVersion, logoutTelegram, sendText, settings, startPhoneLogin, startupError, state, verifyPhoneLogin])

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp() {
  const context = useContext(AppContext)
  if (!context) throw new Error('useApp must be used inside AppProvider')
  return context
}

function fixtureSettings(current: FrontendConfig): FrontendConfig {
  return {
    ...current,
    apiBaseUrl: fixtureApiBaseUrl(),
    backendSharedSecret: current.backendSharedSecret.trim() || 'fixture-shared-secret',
    telegramApiId: current.telegramApiId.trim() || '12345',
    telegramApiHash: current.telegramApiHash.trim() || 'fixture-hash',
    telegramSession: current.telegramSession.trim() || 'fixture-session',
    debugEventsEnabled: false,
  }
}

function fixtureApiBaseUrl() {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin
  }
  return 'http://127.0.0.1:5174'
}

function runtimeConfig(config: FrontendConfig): Partial<ControllerRuntimeConfig> {
  return {
    chatPollMs: config.chatPollMs,
    messagePollMs: config.messagePollMs,
    recordingMinDurationMs: config.recordingMinDurationMs,
    language: config.language,
  }
}
