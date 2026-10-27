import { describe, expect, it } from 'vitest'
import { BACKEND_URL_PLACEHOLDER, buildEffectiveManifest, normalizeBackendOrigin, parseLocalOverride, updateAppJsonNetworkWhitelist } from '../../scripts/configure-tailscale-utils.mjs'

describe('configure-tailscale helper', () => {
  it('replaces the runtime placeholder and stays idempotent on repeated runs', () => {
    const appJson = {
      permissions: [
        {
          name: 'network',
          whitelist: [
            'http://localhost:8787',
            BACKEND_URL_PLACEHOLDER,
            'https://my.telegram.org',
            'https://react.dev/errors/',
            'https://teleglance.akira-os.net',
          ],
        },
      ],
    }

    updateAppJsonNetworkWhitelist(appJson, 'http://100.64.10.20:8787')
    expect(appJson.permissions?.[0]?.whitelist).toEqual([
      'http://localhost:8787',
      'http://100.64.10.20:8787',
      'https://my.telegram.org',
      'https://react.dev/errors/',
      'https://teleglance.akira-os.net',
    ])

    updateAppJsonNetworkWhitelist(appJson, 'http://100.64.10.20:8787')
    expect(appJson.permissions?.[0]?.whitelist).toEqual([
      'http://localhost:8787',
      'http://100.64.10.20:8787',
      'https://my.telegram.org',
      'https://react.dev/errors/',
      'https://teleglance.akira-os.net',
    ])
  })

  it('updates an already-substituted backend slot when the origin changes', () => {
    const appJson = {
      permissions: [
        {
          name: 'network',
          whitelist: [
            'http://localhost:8787',
            'http://100.64.10.20:8787',
            'https://my.telegram.org',
          ],
        },
      ],
    }

    updateAppJsonNetworkWhitelist(appJson, 'http://100.64.10.21:8787')
    expect(appJson.permissions?.[0]?.whitelist).toEqual([
      'http://localhost:8787',
      'http://100.64.10.21:8787',
      'https://my.telegram.org',
    ])
  })
})

describe('normalizeBackendOrigin', () => {
  it('accepts http and https origins', () => {
    expect(normalizeBackendOrigin('http://100.64.0.1:8788/path')).toBe('http://100.64.0.1:8788')
    expect(normalizeBackendOrigin('https://example.com')).toBe('https://example.com')
  })

  it('rejects other schemes and garbage', () => {
    expect(() => normalizeBackendOrigin('file:///etc/passwd')).toThrow(/http: or https:/)
    expect(() => normalizeBackendOrigin('ftp://example.com')).toThrow(/http: or https:/)
    expect(() => normalizeBackendOrigin('not a url')).toThrow(/Invalid backend origin/)
  })
})

describe('local override manifest', () => {
  const appJson = () => ({
    version: '1.0.1',
    permissions: [{ name: 'network', whitelist: ['http://localhost:8787', BACKEND_URL_PLACEHOLDER, 'https://my.telegram.org'] }],
  })

  it('keeps the tracked manifest (placeholder) when there is no override', () => {
    const manifest = buildEffectiveManifest(appJson(), {})
    expect(manifest.permissions[0].whitelist).toContain(BACKEND_URL_PLACEHOLDER)
  })

  it('substitutes the backend origin without mutating the input', () => {
    const input = appJson()
    const manifest = buildEffectiveManifest(input, { backendOrigin: 'http://100.64.0.1:8788' })
    expect(manifest.permissions[0].whitelist).toContain('http://100.64.0.1:8788')
    expect(manifest.permissions[0].whitelist).not.toContain(BACKEND_URL_PLACEHOLDER)
    expect(input.permissions[0].whitelist).toContain(BACKEND_URL_PLACEHOLDER)
  })

  it('always reflects the current app.json version (no stale copy)', () => {
    const manifest = buildEffectiveManifest({ ...appJson(), version: '2.0.0' }, { backendOrigin: 'http://100.64.0.1:8788' })
    expect(manifest.version).toBe('2.0.0')
  })

  it('validates the override file contents', () => {
    expect(parseLocalOverride({ backendOrigin: 'http://100.64.0.1:8788/x' })).toEqual({ backendOrigin: 'http://100.64.0.1:8788' })
    expect(parseLocalOverride(null)).toEqual({})
    expect(() => parseLocalOverride({ backendOrigin: 'file:///etc' })).toThrow(/http: or https:/)
    expect(() => parseLocalOverride({ backendOrigin: 5 })).toThrow(/must be a string/)
    expect(() => parseLocalOverride([])).toThrow(/JSON object/)
  })
})
