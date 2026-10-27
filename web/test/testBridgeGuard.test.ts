import { describe, expect, it } from 'vitest'
import { isLoopbackRequest } from '../testBridgeGuard'

describe('test bridge loopback guard', () => {
  it('allows loopback peers with loopback hosts', () => {
    expect(isLoopbackRequest('127.0.0.1', 'localhost:5173')).toBe(true)
    expect(isLoopbackRequest('::1', '[::1]:5173')).toBe(true)
    expect(isLoopbackRequest('::ffff:127.0.0.1', '127.0.0.1:5173')).toBe(true)
  })

  it('rejects remote peers, even with a loopback Host header', () => {
    expect(isLoopbackRequest('172.21.0.3', 'localhost:5173')).toBe(false)
    expect(isLoopbackRequest('100.64.1.2', '127.0.0.1:5173')).toBe(false)
    expect(isLoopbackRequest(undefined, 'localhost')).toBe(false)
  })

  it('rejects DNS-rebinding hosts from loopback peers', () => {
    expect(isLoopbackRequest('127.0.0.1', 'evil.example:5173')).toBe(false)
    expect(isLoopbackRequest('127.0.0.1', 'localhost.evil.example')).toBe(false)
    expect(isLoopbackRequest('127.0.0.1', undefined)).toBe(false)
  })
})
