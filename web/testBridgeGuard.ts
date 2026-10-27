// The fixture bridge mirrors app state (message text, titles, transcripts, phone) and accepts test
// commands. It must only serve the local test harness: loopback peers using a loopback Host header.
// The Host check also blocks DNS-rebinding pages, which would otherwise reach us from 127.0.0.1.
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isLoopbackRequest(remoteAddress: string | undefined, hostHeader: string | undefined): boolean {
  if (!remoteAddress || !LOOPBACK_ADDRESSES.has(remoteAddress)) return false
  const host = (hostHeader ?? '').trim().toLowerCase().replace(/:\d+$/, '')
  return LOOPBACK_HOSTS.has(host)
}
