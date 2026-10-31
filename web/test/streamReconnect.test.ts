import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpTelegramApi } from '../src/api'

// Real WebCrypto key derivation does not advance with fake timers, and is not what these tests are about.
vi.mock('../src/secureAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/secureAuth')>()),
  encryptedTelegramAuthHeader: async () => 'encrypted-auth',
}))

const encoder = new TextEncoder()

function api(config: Record<string, string> = { telegramApiId: '123', telegramApiHash: 'abc', backendSharedSecret: 'user-secret' }) {
  return new HttpTelegramApi('http://localhost:8787', () => config)
}

const messageEvent = (id: number) =>
  `event: message\ndata: ${JSON.stringify({ type: 'message', chatId: 1, message: { id, text: `m${id}` } })}\n\n`

/** A response whose body delivers the given chunks and then closes (or stays open when `hold` is set). */
function streamResponse(chunks: string[], hold = false, signal?: AbortSignal) {
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index += 1
        return
      }
      if (hold) {
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        })
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

describe('update stream reconnect', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('reconnects with backoff after the stream ends and tells the caller to catch up', async () => {
    vi.useFakeTimers()
    const responses = [streamResponse([messageEvent(1)]), streamResponse([messageEvent(2)], true)]
    const fetchStub = vi.fn(async (_url: string, init?: RequestInit) => {
      const next = responses.shift()!
      return next.body && responses.length === 0 ? streamResponse([messageEvent(2)], true, init?.signal ?? undefined) : next
    })
    vi.stubGlobal('fetch', fetchStub)

    const updates: unknown[] = []
    const onReconnect = vi.fn()
    const stop = api().subscribeUpdates((update) => updates.push(update), undefined, onReconnect)

    await vi.advanceTimersByTimeAsync(10)
    expect(updates).toHaveLength(1)
    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(onReconnect).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_100) // first backoff is one second
    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(updates).toHaveLength(2)
    expect(onReconnect).toHaveBeenCalledTimes(1)
    stop()
  })

  it('treats a stream that goes silent as dead and opens a new one', async () => {
    vi.useFakeTimers()
    const fetchStub = vi.fn(async (_url: string, init?: RequestInit) => streamResponse([], true, init?.signal ?? undefined))
    vi.stubGlobal('fetch', fetchStub)

    const onReconnect = vi.fn()
    const stop = api().subscribeUpdates(() => undefined, undefined, onReconnect)

    await vi.advanceTimersByTimeAsync(44_000)
    expect(fetchStub).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3_000) // past the 45 s silence limit, plus the one second backoff
    expect(fetchStub.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(onReconnect).toHaveBeenCalled()
    stop()
  })

  it('keepalive comments keep a quiet stream open', async () => {
    vi.useFakeTimers()
    const fetchStub = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const timer = setInterval(() => controller.enqueue(encoder.encode(': keepalive\n\n')), 15_000)
          init?.signal?.addEventListener('abort', () => { clearInterval(timer); controller.error(new DOMException('aborted', 'AbortError')) }, { once: true })
        },
      })
      return new Response(body, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchStub)

    const stop = api().subscribeUpdates(() => undefined)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetchStub).toHaveBeenCalledTimes(1)
    stop()
  })

  it('stops for good when it is unsubscribed', async () => {
    vi.useFakeTimers()
    const fetchStub = vi.fn(async () => streamResponse([messageEvent(1)]))
    vi.stubGlobal('fetch', fetchStub)

    const stop = api().subscribeUpdates(() => undefined)
    await vi.advanceTimersByTimeAsync(10)
    stop()
    const calls = fetchStub.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchStub.mock.calls.length).toBe(calls)
  })

  it('does not retry when settings are missing', async () => {
    vi.useFakeTimers()
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    const onError = vi.fn()

    api({}).subscribeUpdates(() => undefined, onError)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchStub).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
