/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsScreen } from '../src/screens/SettingsScreen'
import { DEFAULT_FRONTEND_CONFIG } from '../src/storage'

const fns = {
  saveSettings: vi.fn(async (_settings: unknown) => undefined),
  resetSettings: vi.fn(async () => undefined),
  logoutTelegram: vi.fn(async () => undefined),
  clearCache: vi.fn(async () => undefined),
  testConnection: vi.fn(),
}

const stableState = { screen: 'sidebar' }
const stableSettings = { ...DEFAULT_FRONTEND_CONFIG, apiBaseUrl: 'http://x:8787', telegramSession: 'sess' }
let currentSettings = stableSettings

vi.mock('../src/contexts/AppContext', () => ({
  useApp: () => ({
    state: stableState,
    settings: currentSettings,
    ...fns,
    localeVersion: 0,
  }),
}))

describe('SettingsScreen', () => {
  afterEach(cleanup)
  beforeEach(() => {
    Object.values(fns).forEach((f) => f.mockClear())
    currentSettings = stableSettings
  })

  it('saves', async () => {
    render(<SettingsScreen buildVersion="1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }))
    await waitFor(() => expect(fns.saveSettings).toHaveBeenCalled())
  })

  it('shows Saved only once the save finished, and an error when it failed', async () => {
    let finish!: () => void
    fns.saveSettings.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined) }))
    render(<SettingsScreen buildVersion="1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }))
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Saved' })).toBeNull()
    finish()
    await screen.findByRole('button', { name: 'Saved' })

    fns.saveSettings.mockRejectedValueOnce(new Error('disk full'))
    fireEvent.click(screen.getByRole('button', { name: 'Saved' }))
    expect((await screen.findByRole('alert')).textContent).toContain('disk full')
    expect(screen.getByRole('button', { name: 'Save Settings' })).toBeTruthy()
  })

  it('keeps in-progress edits when settings are restored in the background', async () => {
    const view = render(<SettingsScreen buildVersion="1" />)
    const url = screen.getByPlaceholderText('http://<BACKEND_URL>:8787') as HTMLInputElement
    fireEvent.change(url, { target: { value: 'http://typed:8787' } })
    currentSettings = { ...stableSettings, apiBaseUrl: 'http://restored:8787' }
    view.rerender(<SettingsScreen buildVersion="1" />)
    expect((screen.getByPlaceholderText('http://<BACKEND_URL>:8787') as HTMLInputElement).value).toBe('http://typed:8787')
  })

  it('takes restored settings while nothing was edited', async () => {
    const view = render(<SettingsScreen buildVersion="1" />)
    currentSettings = { ...stableSettings, apiBaseUrl: 'http://restored:8787' }
    view.rerender(<SettingsScreen buildVersion="1" />)
    expect((screen.getByPlaceholderText('http://<BACKEND_URL>:8787') as HTMLInputElement).value).toBe('http://restored:8787')
  })

  it('masks the Telegram API hash and keeps it out of autofill', () => {
    render(<SettingsScreen buildVersion="1" />)
    const hash = screen.getByPlaceholderText('0123456789abcdef0123456789abcdef') as HTMLInputElement
    expect(hash.type).toBe('password')
    expect(hash.getAttribute('autocomplete')).toBe('off')
    expect(hash.getAttribute('autocapitalize')).toBe('off')
  })

  it('resets only after a confirming second tap', async () => {
    render(<SettingsScreen buildVersion="1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(fns.resetSettings).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to reset all settings' }))
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
    expect(fns.logoutTelegram).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to disconnect Telegram' }))
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
