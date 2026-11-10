import type { TelegramAuthConfig } from './api'

// Every encrypted blob uses the same AES key (derived from the shared secret), so each purpose and direction
// gets its own AAD: a ciphertext made for one purpose (say a response) then never decrypts as another (say an
// auth header). The backend only answers with RESPONSE_AAD when the request carries PROTOCOL_HEADER: 2.
export const AUTH_AAD_LABEL = 'teleglance-auth-v1'
export const REQUEST_AAD_LABEL = 'teleglance-req-v1'
export const RESPONSE_AAD_LABEL = 'teleglance-resp-v1'
export const PROTOCOL_HEADER = 'X-TeleGlance-Proto'
export const PROTOCOL_VERSION = '2'
const AUTH_AAD = new TextEncoder().encode(AUTH_AAD_LABEL)
const AUTH_SALT = new TextEncoder().encode('TeleGlance encrypted auth v1')
const AUTH_PBKDF2_ITERATIONS = 200000
const derivedKeyCache = new Map<string, Promise<CryptoKey>>()

export async function encryptedTelegramAuthHeader(config: TelegramAuthConfig): Promise<string | null> {
  const sharedSecret = config.backendSharedSecret?.trim()
  const apiId = config.telegramApiId?.trim()
  const apiHash = config.telegramApiHash?.trim()
  if (!sharedSecret || !apiId || !apiHash) return null
  if (!globalThis.crypto?.subtle) {
    throw new Error('Encrypted backend auth requires WebCrypto. Use the packaged app, localhost, HTTPS, or a browser with WebCrypto support.')
  }

  const key = await deriveKey(sharedSecret)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const payload = new TextEncoder().encode(JSON.stringify({
    apiId,
    apiHash,
    session: config.telegramSession?.trim() || '',
    ts: Math.floor(Date.now() / 1000),
  }))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: AUTH_AAD },
    key,
    payload,
  ))
  return `v1.${base64Url(nonce)}.${base64Url(ciphertext)}`
}

/** Encrypt a JSON request body (AAD `teleglance-req-v1`). */
export async function encryptJsonPayload(json: string, sharedSecret: string): Promise<string> {
  return encryptWithAad(json, sharedSecret, REQUEST_AAD_LABEL)
}

/** Decrypt a backend response body or update-stream event (AAD `teleglance-resp-v1`). */
export async function decryptJsonPayload(encryptedPayload: string, sharedSecret: string): Promise<string> {
  return decryptWithAad(encryptedPayload, sharedSecret, RESPONSE_AAD_LABEL)
}

export async function encryptWithAad(text: string, sharedSecret: string, aad: string): Promise<string> {
  const key = await deriveKeyOrThrow(sharedSecret)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(text),
  ))
  return `v1.${base64Url(nonce)}.${base64Url(ciphertext)}`
}

export async function decryptWithAad(encryptedPayload: string, sharedSecret: string, aad: string): Promise<string> {
  const key = await deriveKeyOrThrow(sharedSecret)
  const parts = encryptedPayload.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Encrypted backend response is malformed')
  const nonce = base64UrlToBytes(parts[1])
  const ciphertext = base64UrlToBytes(parts[2])
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(aad) },
    key,
    ciphertext,
  )
  return new TextDecoder().decode(plaintext)
}

/**
 * Start the (slow on phones) PBKDF2 derivation now, so the first backend request does not pay for it.
 * Fire-and-forget: errors surface again on the real request.
 */
export function warmSharedSecretKey(sharedSecret: string | undefined) {
  const secret = sharedSecret?.trim()
  if (!secret || !globalThis.crypto?.subtle) return
  void deriveKeyOrThrow(secret).catch(() => undefined)
}

/** Test hook: forget every derived key. */
export function clearDerivedKeyCache() {
  derivedKeyCache.clear()
}

async function deriveKey(sharedSecret: string) {
  return deriveKeyOrThrow(sharedSecret)
}

async function deriveKeyOrThrow(sharedSecret: string) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Encrypted backend auth requires WebCrypto. Use the packaged app, localhost, HTTPS, or a browser with WebCrypto support.')
  }
  const cached = derivedKeyCache.get(sharedSecret)
  if (cached) return cached
  const keyPromise = deriveKeyMaterial(sharedSecret)
  derivedKeyCache.set(sharedSecret, keyPromise)
  // A failed derivation must not stay cached, or every later request would fail the same way without retrying.
  keyPromise.catch(() => {
    if (derivedKeyCache.get(sharedSecret) === keyPromise) derivedKeyCache.delete(sharedSecret)
  })
  return keyPromise
}

async function deriveKeyMaterial(sharedSecret: string) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(sharedSecret),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: AUTH_SALT,
      iterations: AUTH_PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function base64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
