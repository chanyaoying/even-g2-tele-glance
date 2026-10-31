/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MessageBubble } from '../src/screens/ChatScreen'

vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ localeVersion: 0 }) }))

describe('MessageBubble extras', () => {
  it('renders reply quote, forward, photo label and timestamp', () => {
    const { container } = render(<MessageBubble message={{
      id: '1', sender: 'Bob', text: 'hi', sentAt: '2026-01-01T10:30:00Z', media: 'photo',
      replyTo: { messageId: 2, sender: 'Alice', preview: 'quote' }, forwardedFrom: 'Carol',
    }} />)
    expect(screen.getByText('> Alice: quote')).toBeTruthy()
    expect(screen.getByText('Forwarded from Carol')).toBeTruthy()
    expect(screen.getByText('[photo]')).toBeTruthy()
    expect(container.querySelector('time')).toBeTruthy()
  })

  it('renders poll options with percent and link card', () => {
    render(<MessageBubble message={{
      id: '2', sender: 'Bob', text: '',
      poll: { question: 'Lunch?', options: [{ text: 'Pizza', percent: 75, chosen: true }, { text: 'Soup', percent: 25 }] },
      link: { title: 'Title', domain: 'example.com', description: 'Desc' },
    }} />)
    expect(screen.getByText('Lunch?')).toBeTruthy()
    expect(screen.getByText('[x] Pizza')).toBeTruthy()
    expect(screen.getByText('75%')).toBeTruthy()
    expect(screen.getByText('[ ] Soup')).toBeTruthy()
    expect(screen.getByText('example.com')).toBeTruthy()
    expect(screen.getByText('Desc')).toBeTruthy()
  })
})
