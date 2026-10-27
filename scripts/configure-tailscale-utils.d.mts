export const BACKEND_URL_PLACEHOLDER: string

export function normalizeBackendOrigin(value: string): string

export function updateAppJsonNetworkWhitelist<T>(appJson: T, backendOrigin: string): T

export const LOCAL_OVERRIDE_FILE: string

export const EFFECTIVE_MANIFEST_DIR: string

export interface LocalOverride {
  backendOrigin?: string
}

export function parseLocalOverride(raw: unknown): LocalOverride

export function buildEffectiveManifest<T>(appJson: T, override?: LocalOverride): T
