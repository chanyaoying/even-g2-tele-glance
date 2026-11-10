/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatScreen } from '../src/screens/ChatScreen'
import type { AppState } from '../src/controller/model'

const sendText = vi.fn<[(text: string) => Promise<void>]>()
Element.prototype.scrollIntoView = vi.fn()

vi.mock('../src/contexts/AppContext', () => ({
  useApp: () => ({
    state: currentState,
    sendText,
    dispatch: vi.fn(),
    startPhoneLogin: vi.fn(),
    verifyPhoneLogin: vi.fn(),
    localeVersion: 0,
  }),
}))

let currentState: AppState

describe('ChatScreen', () => {
  afterEach(() => {
    cleanup()
    sendText.mockReset()
  })

  it('re-enables the composer after a phone send completes', async () => {
    currentState = {
      screen: 'sidebar',
      focus: 'messages',
      chats: [{ id: '1', title: 'Akira', kind: 'user' }],
      selectedChatIndex: 0,
      chat: { id: '1', title: 'Akira', kind: 'user' },
      messages: [{ id: 'm1', sender: 'Akira', text: 'ready' }],
    }
    sendText.mockResolvedValueOnce(undefined)

    render(<ChatScreen />)

    const textarea = screen.getByPlaceholderText('Type a Telegram reply...')
    fireEvent.change(textarea, { target: { value: 'hello' } })
    fireEvent.submit(textarea.closest('form') as HTMLFormElement)

    expect((screen.getByRole('button', { name: 'Sending...' }) as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
      expect((screen.getByPlaceholderText('Type a Telegram reply...') as HTMLTextAreaElement).disabled).toBe(false)
    })
    expect(sendText).toHaveBeenCalledWith('hello')
  })

  it('keeps the draft and shows the error when the phone send fails', async () => {
    currentState = {
      screen: 'sidebar',
      focus: 'messages',
      chats: [{ id: '1', title: 'Akira', kind: 'user' }],
      selectedChatIndex: 0,
      chat: { id: '1', title: 'Akira', kind: 'user' },
      messages: [{ id: 'm1', sender: 'Akira', text: 'ready' }],
    }
    sendText.mockRejectedValueOnce(new Error('Server slow'))

    render(<ChatScreen />)
    const textarea = screen.getByPlaceholderText('Type a Telegram reply...') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'keep me' } })
    fireEvent.submit(textarea.closest('form') as HTMLFormElement)

    expect((await screen.findByRole('alert')).textContent).toBe('Server slow')
    expect(textarea.value).toBe('keep me')
    expect(textarea.disabled).toBe(false)
  })

  it('marks the selected chat row for assistive technology', () => {
    currentState = {
      screen: 'sidebar',
      focus: 'chats',
      chats: [{ id: '1', title: 'Alpha', kind: 'user' }, { id: '2', title: 'Beta', kind: 'user' }],
      selectedChatIndex: 1,
    }
    render(<ChatScreen />)
    expect(screen.getByRole('button', { name: 'Beta' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Alpha' }).getAttribute('aria-current')).toBeNull()
  })
})
