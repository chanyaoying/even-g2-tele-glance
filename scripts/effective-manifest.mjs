// Builds the manifest that gets packaged: tracked app.json + optional gitignored app.local.json.
// Usage: node scripts/effective-manifest.mjs   (prints the path of .app-build/app.json)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EFFECTIVE_MANIFEST_DIR,
  LOCAL_OVERRIDE_FILE,
  buildEffectiveManifest,
  parseLocalOverride,
} from './configure-tailscale-utils.mjs'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function writeEffectiveManifest(repoRoot = defaultRoot) {
  const appJson = JSON.parse(readFileSync(join(repoRoot, 'app.json'), 'utf8'))
  const overridePath = join(repoRoot, LOCAL_OVERRIDE_FILE)
  const override = existsSync(overridePath) ? parseLocalOverride(JSON.parse(readFileSync(overridePath, 'utf8'))) : {}
  const manifest = buildEffectiveManifest(appJson, override)
  const dir = join(repoRoot, EFFECTIVE_MANIFEST_DIR)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'app.json')
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return { path, relativePath: `${EFFECTIVE_MANIFEST_DIR}/app.json`, backendOrigin: override.backendOrigin ?? null }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { relativePath, backendOrigin } = writeEffectiveManifest()
  console.error(backendOrigin ? `Backend origin from ${LOCAL_OVERRIDE_FILE}: ${backendOrigin}` : 'No local override: using app.json as is.')
  console.log(relativePath)
}
