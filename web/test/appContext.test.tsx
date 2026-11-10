/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, SESSION_EXPIRED_MESSAGE } from '../src/api'
import { TelegramAppController } from '../src/controller/appController'

vi.mock('../src/bridge/evenBridge', () => ({
  APP_BUILD_VERSION: 'test',
  EvenHubGlassesBridge: { create: vi.fn(async () => { throw new Error('no glasses in tests') }) },
}))

type StreamCallbacks = {
  onUpdate: (update: unknown) => void
  onError?: (error: Error) => void
  onReconnect?: () => void
  onOpen?: () => void
}

const order: string[] = []
let streams: StreamCallbacks[] = []
let authStatusImpl: () => Promise<{ authorized: boolean }>
let logoutImpl: () => Promise<void>

const fakeHttpApi = {
  authStatus: vi.fn(() => { order.push('authStatus'); return authStatusImpl() }),
  listChats: vi.fn(async () => [{ id: '1', title: 'Alice', kind: 'user' }]),
  listFolders: vi.fn(async () => []),
  logout: vi.fn(() => { order.push('logout'); return logoutImpl() }),
  subscribeUpdates: vi.fn((onUpdate: StreamCallbacks['onUpdate'], onError?: StreamCallbacks['onError'], onReconnect?: () => void, onOpen?: () => void) => {
    order.push('subscribeUpdates')
    streams.push({ onUpdate, onError, onReconnect, onOpen })
    return () => undefined
  }),
}

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  HttpTelegramApi: vi.fn(() => fakeHttpApi),
}))

// Imported after the mocks.
const { AppProvider, useApp } = await import('../src/contexts/AppContext')

let app: ReturnType<typeof useApp> | undefined
function Probe() {
  app = useApp()
  return null
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('AppProvider', () => {
  const reload = vi.fn()

  beforeEach(() => {
    order.length = 0
    streams = []
    app = undefined
    reload.mockReset()
    vi.mocked(fakeHttpApi.authStatus).mockClear()
    vi.mocked(fakeHttpApi.subscribeUpdates).mockClear()
    authStatusImpl = async () => ({ authorized: true })
    logoutImpl = async () => undefined
    window.localStorage.clear()
    window.localStorage.setItem('teleGlance.apiBaseUrl', 'http://100.64.0.1:8787')
    window.localStorage.setItem('teleGlance.backendSharedSecret', 'secret')
    window.localStorage.setItem('teleGlance.telegramApiId', '123')
    window.localStorage.setItem('teleGlance.telegramApiHash', 'hash')
    window.localStorage.setItem('teleGlance.telegramSession', 'session-string')
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, search: '', origin: 'http://localhost', protocol: 'http:', reload },
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('opens the update stream while the session check is still running, not after it', async () => {
    const gate = deferred<{ authorized: boolean }>()
    authStatusImpl = () => gate.promise
    render(<AppProvider><Probe /></AppProvider>)
    await waitFor(() => expect(fakeHttpApi.authStatus).toHaveBeenCalled())
    expect(fakeHttpApi.subscribeUpdates).toHaveBeenCalledTimes(1)
    expect(order.indexOf('subscribeUpdates')).toBeLessThan(order.indexOf('authStatus'))
    await act(async () => gate.resolve({ authorized: true }))
    await waitFor(() => expect(app?.state).toMatchObject({ screen: 'sidebar', focus: 'chats' }))
    expect(fakeHttpApi.subscribeUpdates).toHaveBeenCalledTimes(1)
  })

  it('signs out when the stream reports an expired session, then reopens the stream after signing in again', async () => {
    render(<AppProvider><Probe /></AppProvider>)
    await waitFor(() => expect(app?.state).toMatchObject({ screen: 'sidebar', focus: 'chats' }))

    await act(async () => {
      streams[0].onError?.(new ApiError(SESSION_EXPIRED_MESSAGE, 'Telegram session has expired.', 401, undefined, 'sessionExpired'))
    })
    await waitFor(() => expect(app?.state).toMatchObject({ screen: 'auth', mode: 'signedOut' }))
    expect(app?.settings.telegramSession).toBe('')
    expect(window.localStorage.getItem('teleGlance.telegramSession')).toBeNull()

    // Signing in again brings the chat list back, and with it a fresh stream.
    await act(async () => {
      await app?.dispatch({ type: 'foreground' })
    })
    await waitFor(() => expect(app?.state).toMatchObject({ screen: 'sidebar', focus: 'chats' }))
    expect(fakeHttpApi.subscribeUpdates).toHaveBeenCalledTimes(2)
  })

  it('logs out on the backend before clearing the cache, then reloads', async () => {
    const clearCache = vi.spyOn(TelegramAppController.prototype, 'clearCache').mockImplementation(async () => { order.push('clearCache') })
    render(<AppProvider><Probe /></AppProvider>)
    await waitFor(() => expect(app?.state).toMatchObject({ screen: 'sidebar' }))
    order.length = 0

    await act(async () => { await app?.logoutTelegram() })
    expect(order).toEqual(['logout', 'clearCache'])
    expect(clearCache).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem('teleGlance.telegramSession')).toBeNull()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('keeps the session when the backend logout fails, but still clears the cache', async () => {
    vi.spyOn(TelegramAppController.prototype, 'clearCache').mockImplementation(async () => { order.push('clearCache') })
    logoutImpl = async () => { throw new Error('No connection') }
    render(<AppProvider><Probe /></AppProvider>)
    await waitFor(() => expect(app?.state).toMatchObject({ screen: 'sidebar' }))
    order.length = 0

    let failure: unknown
    await act(async () => { await app?.logoutTelegram().catch((error) => { failure = error }) })
    expect((failure as Error).message).toBe('No connection')
    expect(order).toEqual(['logout', 'clearCache'])
    expect(window.localStorage.getItem('teleGlance.telegramSession')).toBe('session-string')
    expect(reload).not.toHaveBeenCalled()
  })
})
