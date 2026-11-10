#!/usr/bin/env node
// Compact timeline of the phone/glasses debug log written by the backend (logs/debug-events.jsonl).
// Usage: node scripts/read-debug-log.mjs [--minutes 30] [--file logs/debug-events.jsonl] [--raw]
import { readFileSync, existsSync } from 'node:fs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const minutes = Number(opt('minutes', '30'))
const file = opt('file', new URL('../logs/debug-events.jsonl', import.meta.url).pathname)
const showRaw = args.includes('--raw')
if (!existsSync(file)) {
  console.error(`No log at ${file}. Is "Debug events" on in the phone Settings and the backend restarted with ./logs mounted?`)
  process.exit(1)
}
const cutoff = Date.now() - minutes * 60_000
const events = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)] } catch { return [] }
}).filter((e) => Date.parse(e.received_at) >= cutoff)

const problems = []
let last = 0
for (const e of events) {
  const t = Date.parse(e.received_at)
  const gap = last ? `+${((t - last) / 1000).toFixed(1)}s` : ''
  last = t
  const clock = e.received_at.slice(11, 23)
  let line
  if (e.note) {
    const { event, ...rest } = e.raw ?? {}
    line = `${event} ${JSON.stringify(rest)}`
    const bad = event === 'js-error' || event === 'error-screen' || event === 'api.error' || event === 'stream.error' ||
      (event === 'page-rebuild' && rest.accepted === false) || (event === 'image-transfer' && rest.ok === false) ||
      ((event === 'transcribe' || event === 'send') && rest.ok === false) || event === 'press.dropped-near-hold' || event === 'hold.ignored'
    if (bad) problems.push(`${clock} ${line}`)
    if (bad) line = `!! ${line}`
  } else {
    if (!showRaw && e.mapped?.type === 'audioChunk') continue
    line = `hw ${e.mapped ? e.mapped.type : '(unmapped)'}${showRaw ? ' ' + JSON.stringify(e.raw) : ''}`
  }
  console.log(`${clock} ${gap.padStart(8)} v${e.build_version ?? e.buildVersion ?? '?'} ${line}`)
}
console.log(`\n${events.length} events in the last ${minutes} min, ${problems.length} problems`)
for (const p of problems) console.log(`  ${p}`)
