import { readFileSync } from 'fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import legacy from '@vitejs/plugin-legacy'
import { isLoopbackRequest } from './testBridgeGuard'

const appJson = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf-8')) as { version: string }

type FixtureCommand =
  | { kind: 'setMode'; mode: 'normal' | 'missing' | 'error' | 'slow' }
  | { kind: 'setSlowChats'; ms: number }
  | { kind: 'setNextTranscript'; value: string | null }
  | { kind: 'setInjectedNotification'; chatId: string; message: string; topicId?: string | null }
  | { kind: 'injectAudioChunks'; pcmBase64: string }
  | { kind: 'reset' }
  | { kind: 'drainEvents' }
  | { kind: 'injectTyping'; chatId: string; topicId?: string | null; userName: string }
  | { kind: 'cancelTyping'; chatId: string; topicId?: string | null }

let pendingFixtureCommands: FixtureCommand[] = []
let pendingFixtureEvents: unknown[] = []

function teleGlanceFixtureBridge(): Plugin {
  return {
    name: 'teleGlance-fixture-bridge',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/test', (req, res, next) => {
        if (isLoopbackRequest(req.socket.remoteAddress, req.headers.host)) {
          next()
          return
        }
        res.statusCode = 403
        res.setHeader('Content-Type', 'text/plain')
        res.end('Forbidden: test bridge is loopback-only')
      })
      // GET /api/test/fixture-commands — the in-page poller
      // fetches this every 100ms. The response carries any
      // pending commands (queued via POST /api/test/fixture)
      // AND any events the in-page script has pushed back via
      // POST { kind: 'events', events: [...] }. The events
      // field is what makes the
      // `scripts/simulator-topic-scroll.mjs` harness possible:
      // the page never exposes its in-memory render log to the
      // outside, so we round-trip it through the dev server.
      server.middlewares.use('/api/test/fixture-commands', (_req, res) => {
        const commands = [...pendingFixtureCommands]
        pendingFixtureCommands = []
        const events = pendingFixtureEvents.splice(0, pendingFixtureEvents.length)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ commands, events }))
      })
      // POST /api/test/fixture — accepts either:
      //   { kind: 'command', command: <FixtureCommand> }
      //   { kind: 'events', events: [...] }
      // The original (legacy) contract was a bare `FixtureCommand`
      // body, but new clients should use the explicit envelope.
      // The bridge still parses a bare command for backward
      // compatibility with the existing harness.
      server.middlewares.use('/api/test/fixture', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method not allowed')
          return
        }
        let body = ''
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8')
        })
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { kind?: string } & Record<string, unknown>
            if (parsed.kind === 'events' && Array.isArray(parsed.events)) {
              for (const event of parsed.events as unknown[]) {
                pendingFixtureEvents.push(event)
              }
              // Cap the buffer at 5_000 events so a long-running
              // harness doesn't OOM the dev server.
              if (pendingFixtureEvents.length > 5_000) {
                pendingFixtureEvents.splice(0, pendingFixtureEvents.length - 5_000)
              }
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true, accepted: parsed.events.length }))
              return
            }
            // Legacy: treat the body as a bare FixtureCommand.
            const command = parsed as FixtureCommand
            pendingFixtureCommands.push(command)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, command: command.kind }))
          } catch {
            res.statusCode = 400
            res.end('Invalid JSON')
          }
        })
      })
      server.middlewares.use('/api/test/console-marker', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, hasFixture: true }))
      })
    },
  }
}

export default defineConfig({
  envDir: '..',
  define: {
    __APP_VERSION__: JSON.stringify(appJson.version),
  },
  plugins: [
    react(),
    legacy({
      targets: ['defaults', 'not IE 11'],
    }),
    teleGlanceFixtureBridge(),
  ],
  test: {
    environment: 'node',
  },
})
