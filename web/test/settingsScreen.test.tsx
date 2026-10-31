/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsScreen } from '../src/screens/SettingsScreen'
import { DEFAULT_FRONTEND_CONFIG } from '../src/storage'

const fns = {
  saveSettings: vi.fn(async () => undefined),
  resetSettings: vi.fn(async () => undefined),
  logoutTelegram: vi.fn(async () => undefined),
  clearCache: vi.fn(async () => undefined),
  testConnection: vi.fn(),
}

const stableState = { screen: 'sidebar' }
const stableSettings = { ...DEFAULT_FRONTEND_CONFIG, apiBaseUrl: 'http://x:8787', telegramSession: 'sess' }

vi.mock('../src/contexts/AppContext', () => ({
  useApp: () => ({
    state: stableState,
    settings: stableSettings,
    ...fns,
    localeVersion: 0,
  }),
}))

describe('SettingsScreen', () => {
  afterEach(cleanup)
  beforeEach(() => Object.values(fns).forEach((f) => f.mockClear()))

  it('saves', async () => {
    render(<SettingsScreen buildVersion="1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }))
    await waitFor(() => expect(fns.saveSettings).toHaveBeenCalled())
  })

  it('resets', async () => {
    render(<SettingsScreen buildVersion="1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(fns.resetSettings).toHaveBeenCalled())
  })

  it('clears cache and confirms', async () => {
    render(<SettingsScreen buildVersion="1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear cache' }))
    await waitFor(() => expect(fns.clearCache).toHaveBeenCalled())
    await screen.findByText(/Cache cleared/)
  })

  it('logs out', async () => {
    render(<SettingsScreen buildVersion="1" />)
    const btn = screen.getAllByRole('button').find((b) => /log ?out|disconnect/i.test(b.textContent ?? ''))
    expect(btn).toBeTruthy()
    fireEvent.click(btn as HTMLElement)
    await waitFor(() => expect(fns.logoutTelegram).toHaveBeenCalled())
  })

  it('tests connection and reports each result in words', async () => {
    fns.testConnection.mockResolvedValueOnce({ health: { ok: true }, session: { ok: true, authorized: true } })
    render(<SettingsScreen buildVersion="1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText('Backend reachable')
    expect(screen.getByText('Secret accepted, Telegram logged in')).toBeTruthy()
  })

  it('reports an unreachable backend and skipped session check', async () => {
    fns.testConnection.mockResolvedValueOnce({ health: { ok: false, error: 'boom' }, session: null })
    render(<SettingsScreen buildVersion="1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText('Backend not reachable (boom)')
    expect(screen.getByText('Skipped (backend not reachable)')).toBeTruthy()
  })
})
