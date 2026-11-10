/**
 * Opt-in diagnostics. The bridge installs a sink only when "Debug events" is on in Settings; until then `debugLog`
 * is a no-op. Never pass message text, transcripts or credentials: ids, counts, durations and error messages only.
 */
type DebugSink = (note: string, data: Record<string, unknown>) => void

let sink: DebugSink | undefined

export function setDebugSink(next: DebugSink | undefined) {
  sink = next
}

export function debugLog(note: string, data: Record<string, unknown> = {}) {
  try {
    sink?.(note, data)
  } catch {
    // Diagnostics must never affect the app.
  }
}

export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200)
}
