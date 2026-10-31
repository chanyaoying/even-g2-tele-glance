import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCAL_OVERRIDE_FILE, buildEffectiveManifest, normalizeBackendOrigin } from './configure-tailscale-utils.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const backendPort = process.env.BACKEND_PORT ?? '8787'
const vitePort = process.env.VITE_PORT ?? '5173'

const { backendOrigin, frontendOrigin } = resolveBackendAndFrontendOrigins()

const appJsonPath = join(repoRoot, 'app.json')
const appJson = JSON.parse(readFileSync(appJsonPath, 'utf8'))
buildEffectiveManifest(appJson, { backendOrigin }) // validates that app.json still has its backend slot
writeFileSync(join(repoRoot, LOCAL_OVERRIDE_FILE), `${JSON.stringify({ backendOrigin }, null, 2)}\n`)

console.log(`Tailscale backend URL: ${backendOrigin}`)
console.log(`Tailscale frontend URL: ${frontendOrigin}`)
console.log(`Saved ${LOCAL_OVERRIDE_FILE} (gitignored); app.json is unchanged. Packaging applies it automatically.`)
console.log('Set this Backend URL in TeleGlance Settings if needed:')
console.log(backendOrigin)

function detectTailscaleIp() {
  try {
    return execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split(/\s+/)[0]
  } catch (error) {
    throw new Error('Could not detect Tailscale IPv4 address. Install/login to Tailscale or set TAILSCALE_IP.')
  }
}

function resolveBackendAndFrontendOrigins() {
  const explicit = process.env.BACKEND_ORIGIN?.trim()
  if (explicit) return { backendOrigin: normalizeBackendOrigin(explicit), frontendOrigin: '(not used with BACKEND_ORIGIN)' }
  const ip = process.env.TAILSCALE_IP ?? detectTailscaleIp()
  const frontendOrigin = `http://${ip}:${vitePort}`
  const backendOrigin = explicit ? normalizeBackendOrigin(explicit) : normalizeBackendOrigin(`http://${ip}:${backendPort}`)
  return { backendOrigin, frontendOrigin }
}
