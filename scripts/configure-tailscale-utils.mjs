export const BACKEND_URL_PLACEHOLDER = 'http://<BACKEND_URL>:8787'

const FIXED_WHITELIST_ENTRIES = new Set([
  'http://localhost:8787',
  'http://127.0.0.1:8787',
  BACKEND_URL_PLACEHOLDER,
  'https://teleglance.akira-os.net',
  'https://my.telegram.org',
  'https://react.dev/errors/',
])

export function normalizeBackendOrigin(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid backend origin: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Backend origin must use http: or https:, got ${url.protocol} (${value})`)
  }
  return url.origin
}

export function updateAppJsonNetworkWhitelist(appJson, backendOrigin) {
  const networkPermission = appJson.permissions?.find((permission) => permission.name === 'network')
  if (!networkPermission) {
    throw new Error('app.json is missing the network permission.')
  }

  const whitelist = [...(networkPermission.whitelist ?? [])]
  const placeholderIndex = whitelist.indexOf(BACKEND_URL_PLACEHOLDER)
  if (placeholderIndex !== -1) {
    whitelist[placeholderIndex] = backendOrigin
  } else {
    const existingIndex = whitelist.findIndex((value) => shouldReplaceWhitelistEntry(value, backendOrigin))
    if (existingIndex !== -1) {
      whitelist[existingIndex] = backendOrigin
    } else if (!whitelist.includes(backendOrigin)) {
      throw new Error(`app.json network whitelist is missing a backend slot. Restore ${BACKEND_URL_PLACEHOLDER} and rerun the configurator.`)
    }
  }

  networkPermission.whitelist = unique(whitelist)
  return appJson
}

function shouldReplaceWhitelistEntry(value, backendOrigin) {
  if (value === backendOrigin) return false
  if (FIXED_WHITELIST_ENTRIES.has(value)) return false
  return /^https?:\/\/[^/]+(?::\d+)?$/.test(value)
}

function unique(values) {
  return [...new Set(values)]
}

export const LOCAL_OVERRIDE_FILE = 'app.local.json'
export const EFFECTIVE_MANIFEST_DIR = '.app-build'

/** Validate the contents of app.local.json (a gitignored, per-developer override). */
export function parseLocalOverride(raw) {
  if (raw === null || raw === undefined) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${LOCAL_OVERRIDE_FILE} must be a JSON object.`)
  }
  const override = {}
  if (raw.backendOrigin !== undefined) {
    if (typeof raw.backendOrigin !== 'string') throw new Error(`${LOCAL_OVERRIDE_FILE}: backendOrigin must be a string.`)
    override.backendOrigin = normalizeBackendOrigin(raw.backendOrigin)
  }
  return override
}

/** app.json (tracked, with the placeholder) + optional local override -> the manifest that gets packaged. */
export function buildEffectiveManifest(appJson, override = {}) {
  const manifest = structuredClone(appJson)
  if (override.backendOrigin) updateAppJsonNetworkWhitelist(manifest, override.backendOrigin)
  return manifest
}
