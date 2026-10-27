import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useApp } from '../contexts/AppContext'
import { getLocale } from '../locales'
import type { Message } from '../types'

export function ChatScreen() {
  const { state, sendText, localeVersion } = useApp()
  const l = getLocale()
  void localeVersion
  const [draft, setDraft] = useState('')
  const [sendError, setSendError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const messageEndRef = useRef<HTMLDivElement | null>(null)

  const sidebarMessages = (state.screen === 'sidebar' && state.focus === 'messages') || state.screen === 'sidebarRecording' || state.screen === 'sidebarConfirm' || state.screen === 'sidebarSent'
  const activeMessages = sidebarMessages ? state.messages : []
  const canSend = state.screen === 'sidebar' && state.focus === 'messages' && draft.trim().length > 0 && !isSending

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: 'end' })
  }, [activeMessages.length, state.screen])

  async function handleSend() {
    const text = draft.trim()
    if (!text) return
    setIsSending(true)
    setSendError(null)
    try {
      await sendText(text)
      setDraft('')
    } catch (error) {
      setSendError(error instanceof Error ? error.message : l.phoneSendFailed)
    } finally {
      setIsSending(false)
    }
  }

  return (
    <main className="chat-screen">
      <section className="phone-panel message-panel">
        <PhoneStateView />
        {state.screen === 'sidebar' && state.focus === 'messages' && (
          <div className="messages-list" aria-label="Messages">
            {state.messages.length === 0 ? (
              <p className="empty-text">{l.phoneNoMessages}</p>
            ) : state.messages.map((message) => <MessageBubble key={String(message.id)} message={message} />)}
            <div ref={messageEndRef} />
          </div>
        )}
      </section>
      {state.screen === 'sidebar' && state.focus === 'messages' ? (
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault()
            void handleSend()
          }}
        >
          {sendError && <p className="field-error">{sendError}</p>}
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={l.phoneComposerPlaceholder}
            disabled={isSending}
            rows={3}
          />
          <button type="submit" disabled={!canSend}>
            {isSending ? l.phoneSending : l.phoneSend}
          </button>
        </form>
      ) : (
        <div className="composer-banner">{l.phoneOpenChatToSend}</div>
      )}
      <PhoneActions />
    </main>
  )
}

function PhoneStateView() {
  const { state, dispatch, startPhoneLogin, verifyPhoneLogin, localeVersion } = useApp()
  const l = getLocale()
  void localeVersion
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [phoneError, setPhoneError] = useState<string | null>(null)
  const [isPhoneAuthBusy, setIsPhoneAuthBusy] = useState(false)

  async function submitPhoneLogin(event: FormEvent) {
    event.preventDefault()
    setIsPhoneAuthBusy(true)
    setPhoneError(null)
    try {
      await startPhoneLogin(phone)
    } catch (error) {
      setPhoneError(error instanceof Error ? error.message : l.phoneCodeSendFailed)
    } finally {
      setIsPhoneAuthBusy(false)
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault()
    const targetPhone = state.screen === 'auth' && state.phone ? state.phone : phone
    setIsPhoneAuthBusy(true)
    setPhoneError(null)
    try {
      await verifyPhoneLogin(targetPhone, code, state.screen === 'auth' && state.passwordRequired ? password : undefined)
    } catch (error) {
      setPhoneError(error instanceof Error ? error.message : l.phoneCodeVerifyFailed)
    } finally {
      setIsPhoneAuthBusy(false)
    }
  }

  if (state.screen === 'auth') {
    const isPhonePending = state.mode === 'phonePending'
    return (
      <div className="stack">
        <h2>{isPhonePending ? l.phoneTelegramLoginHeading : l.phoneTelegramSessionHeading}</h2>
        <p>{state.message}</p>
        {phoneError && <p className="field-error">{phoneError}</p>}
        <form className="auth-form" onSubmit={isPhonePending ? submitCode : submitPhoneLogin}>
          {isPhonePending ? (
            <>
              <label>
                <span>{l.phoneVerificationCode}</span>
                <input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="12345" />
              </label>
              {state.passwordRequired && (
                <label>
                  <span>{l.phoneTwoStepPassword}</span>
                  <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
                </label>
              )}
              <button type="submit" disabled={isPhoneAuthBusy || (state.passwordRequired ? !password : !code.trim())}>
                {isPhoneAuthBusy ? l.phoneVerifying : l.phoneVerifyCode}
              </button>
            </>
          ) : (
            <>
              <label>
                <span>{l.phoneMobileNumber}</span>
                <input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" autoComplete="tel" placeholder="+14155552671" />
              </label>
              <button type="submit" disabled={isPhoneAuthBusy || state.mode === 'needsSetup' || !phone.trim()}>
                {isPhoneAuthBusy ? l.phoneSendingLoginCode : l.phoneSendLoginCode}
              </button>
            </>
          )}
        </form>
      </div>
    )
  }
  if (state.screen === 'sidebar' && state.focus === 'chats') {
    return (
      <div className="stack">
        <h2>{l.phoneChatsHeading}</h2>
        <div className="select-list">
          {state.chats.map((chat, index) => (
            <button key={String(chat.id)} type="button" className={index === state.selectedChatIndex ? 'selected' : ''} onClick={() => void dispatch({ type: 'press', index })}>
              <span>{chat.title}</span>
              {chat.unreadCount ? <strong>{chat.unreadCount}</strong> : null}
            </button>
          ))}
        </div>
      </div>
    )
  }
  if (state.screen === 'sidebar' && state.focus === 'topics') {
    return (
      <div className="stack">
        <h2>{state.chat.title}</h2>
        <div className="select-list">
          {state.topics.map((topic, index) => (
            <button key={String(topic.id)} type="button" className={index === state.selectedTopicIndex ? 'selected' : ''} onClick={() => void dispatch({ type: 'press', index })}>
              <span>{topic.title}</span>
              {topic.unreadCount ? <strong>{topic.unreadCount}</strong> : null}
            </button>
          ))}
        </div>
      </div>
    )
  }
  if (state.screen === 'sidebar' && state.focus === 'messages') {
    return (
      <div className="thread-heading">
        <div>
          <h2>{state.topic ? state.topic.title : state.chat.title}</h2>
          <p>{state.topic ? state.chat.title : l.phoneCurrentThread}</p>
        </div>
        {state.status && <span className="status-pill">{state.status}</span>}
      </div>
    )
  }
  if (state.screen === 'newMessage') {
    return (
      <div className="stack">
        <h2>{l.phoneNewTelegramHeading}</h2>
        <p>{state.topic ? `${state.chat.title} / ${state.topic.title}` : state.chat.title}</p>
        <blockquote>{state.message || l.bodyNewMessage}</blockquote>
        <button type="button" onClick={() => void dispatch({ type: 'press' })}>{l.phoneOpenThread}</button>
      </div>
    )
  }
  if (state.screen === 'folderPicker') {
    return (
      <div className="stack">
        <h2>{l.titleFolders}</h2>
        <div className="select-list">
          {state.options.map((option, index) => (
            <button key={`${index}-${option}`} type="button" className={index === state.selectedIndex ? 'selected' : ''} onClick={() => void dispatch({ type: 'press', index })}>
              <span>{option}</span>
            </button>
          ))}
        </div>
      </div>
    )
  }
  if (state.screen === 'asleep') return <p className="empty-text">{l.phoneScreenOff}</p>
  if (state.screen === 'loading') return <p className="empty-text">{state.message}</p>
  if (state.screen === 'sidebarRecording') return <p className="empty-text">{l.phoneRecording}</p>
  if (state.screen === 'sidebarTranscribing') return <p className="empty-text">{l.phoneTranscribing}</p>
  if (state.screen === 'sidebarConfirm') return <p className="empty-text">{l.phoneConfirmOnGlasses}{state.transcript}</p>
  if (state.screen === 'sidebarSending') return <p className="empty-text">{l.phoneSendingReply}</p>
  if (state.screen === 'sidebarSent') return <p className="empty-text">{l.phoneReplySent}</p>
  return (
    <div className="stack">
      <h2>{l.phoneErrorHeading}</h2>
      <p>{state.message}</p>
      <button type="button" onClick={() => void dispatch({ type: 'press' })}>{l.phoneRetry}</button>
    </div>
  )
}

function PhoneActions() {
  const { state, dispatch, localeVersion } = useApp()
  const l = getLocale()
  void localeVersion
  return (
    <nav className="phone-actions" aria-label={l.phoneActionsAria}>
      <button type="button" onClick={() => void dispatch({ type: 'swipeUp' })} disabled={!((state.screen === 'sidebar' && (state.focus === 'messages' || state.focus === 'chats' || state.focus === 'topics')) || state.screen === 'folderPicker')}>
        {l.phoneOlderUp}
      </button>
      <button type="button" onClick={() => void dispatch({ type: 'swipeDown' })} disabled={!((state.screen === 'sidebar' && (state.focus === 'messages' || state.focus === 'chats' || state.focus === 'topics')) || state.screen === 'folderPicker')}>
        {l.phoneNewerDown}
      </button>
      <button type="button" onClick={() => void dispatch({ type: 'doublePress' })}>
        {l.phoneBackSleep}
      </button>
    </nav>
  )
}

function MessageBubble({ message }: { message: Message }) {
  const l = getLocale()
  return (
    <article className={`message-bubble ${message.outgoing ? 'outgoing' : 'incoming'}`}>
      <header>{message.outgoing ? l.senderMe : message.sender || l.senderUnknown}</header>
      <p>{message.text}</p>
    </article>
  )
}
