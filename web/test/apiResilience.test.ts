import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKEND_BUSY_MESSAGE, HttpTelegramApi } from '../src/api'

function makeApi() {
  return new HttpTelegramApi('http://localhost:8787', () => ({
    telegramApiId: '123',
    telegramApiHash: 'abc',
    backendSharedSecret: 'user-secret',
  }))
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('HttpTelegramApi resilience', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('shares one network call between identical overlapping GET requests', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchStub = vi.fn(async () => {
      await gate
      return jsonResponse([])
    })
    vi.stubGlobal('fetch', fetchStub)
    const api = makeApi()

    const burst = Array.from({ length: 10 }, () => api.listChats(20, { folderId: '3' }))
    release()
    await Promise.all(burst)

    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('does not share requests for different pages and allows a fresh request after one finishes', async () => {
    const fetchStub = vi.fn(async () => jsonResponse([]))
    vi.stubGlobal('fetch', fetchStub)
    const api = makeApi()

    await Promise.all([api.listChats(20, { folderId: '3' }), api.listChats(20, { folderId: '4' }), api.listChats(20, { offset: 20 })])
    await api.listChats(20, { folderId: '3' })

    expect(fetchStub).toHaveBeenCalledTimes(4)
  })

  it('backs off after repeated gateway timeouts instead of sending more requests', async () => {
    vi.useFakeTimers()
    const fetchStub = vi.fn(async () => jsonResponse({ detail: 'timed out' }, 504))
    vi.stubGlobal('fetch', fetchStub)
    const api = makeApi()

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(api.listChats(20)).rejects.toThrow()
    }
    expect(fetchStub).toHaveBeenCalledTimes(3)

    // Backed off: these fail immediately without touching the network.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await expect(api.listChats(20)).rejects.toThrow(BACKEND_BUSY_MESSAGE)
    }
    expect(fetchStub).toHaveBeenCalledTimes(3)

    // After the pause requests flow again, and one success resets the counter.
    vi.advanceTimersByTime(2500)
    fetchStub.mockImplementation(async () => jsonResponse([]))
    await expect(api.listChats(20)).resolves.toEqual([])
    expect(fetchStub).toHaveBeenCalledTimes(4)
  })

  it('never blocks sign-in requests while backed off', async () => {
    vi.useFakeTimers()
    const fetchStub = vi.fn(async () => jsonResponse({ detail: 'timed out' }, 504))
    vi.stubGlobal('fetch', fetchStub)
    const api = makeApi()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(api.listChats(20)).rejects.toThrow()
    }

    fetchStub.mockImplementation(async () => jsonResponse({ configured: true, authorized: false }))
    await expect(api.authStatus()).resolves.toBeDefined()
  })

  it('does not count ordinary client errors as a struggling backend', async () => {
    const fetchStub = vi.fn(async () => jsonResponse({ detail: 'folder not found' }, 400))
    vi.stubGlobal('fetch', fetchStub)
    const api = makeApi()

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(api.listChats(20)).rejects.toThrow('folder not found')
    }
    expect(fetchStub).toHaveBeenCalledTimes(6)
  })
})
