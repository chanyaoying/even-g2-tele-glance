import { useEffect, useState } from 'react'
import { BACKEND_AUTH_REJECTED_MESSAGE, BACKEND_UNREACHABLE_MESSAGE, effectiveBackendSharedSecret } from './api'
import { APP_BUILD_VERSION } from './bridge/evenBridge'
import { AppProvider, useApp } from './contexts/AppContext'
import { ChatScreen } from './screens/ChatScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { getLocale } from './locales'

type Route = 'chat' | 'settings'

function AppShell() {
  const { state, startupError, settings, localeVersion } = useApp()
  const l = getLocale()
  void localeVersion // force re-render on locale change
  const needsSetup = state.screen === 'auth' && !hasRequiredSetup(settings)
  const setupBanner = setupBannerText(state, settings, l)
  const [route, setRoute] = useState<Route>(needsSetup ? 'settings' : 'chat')
  const isMessages = state.screen === 'sidebar' && state.focus === 'messages'
  const title = isMessages
    ? state.topic ? `${state.chat.title} / ${state.topic.title}` : state.chat.title
    : l.phoneAppTitle

  useEffect(() => {
    if (needsSetup) setRoute('settings')
  }, [needsSetup])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">{l.phoneAppTitle}</p>
          <h1>{route === 'settings' ? l.phoneSettingsTab : title}</h1>
        </div>
        <button className="icon-button" type="button" onClick={() => setRoute(route === 'settings' ? 'chat' : 'settings')} aria-label={route === 'settings' ? l.phoneBackToChat : l.phoneOpenSettings}>
          {route === 'settings' ? l.phoneBack : l.phoneSettingsTab}
        </button>
      </header>
      {startupError && <div className="error-banner" role="alert">{startupError}</div>}
      {setupBanner && <div className="error-banner" role="alert">{setupBanner}</div>}
      {route === 'settings' ? <SettingsScreen buildVersion={APP_BUILD_VERSION} /> : <ChatScreen />}
    </div>
  )
}

function setupBannerText(
  state: ReturnType<typeof useApp>['state'],
  settings: ReturnType<typeof useApp>['settings'],
  l: ReturnType<typeof getLocale>,
) {
  if (!settings.apiBaseUrl.trim()) return l.setupBackendUrlMissing
  if (state.screen === 'error' && state.message === BACKEND_UNREACHABLE_MESSAGE) return l.errorBackendUnreachable
  // Wrong shared secret or phone clock: say so plainly, the Telegram login itself is fine.
  if (state.screen === 'error' && state.message === BACKEND_AUTH_REJECTED_MESSAGE) return l.errorBackendAuthRejected
  if ('status' in state && state.status === BACKEND_AUTH_REJECTED_MESSAGE) return l.errorBackendAuthRejected
  if (state.screen === 'auth' && !hasRequiredSetup(settings)) {
    return l.setupRequired
  }
  return null
}

function hasRequiredSetup(settings: ReturnType<typeof useApp>['settings']) {
  return Boolean(
    settings.apiBaseUrl.trim()
    && effectiveBackendSharedSecret(settings)
    && settings.telegramApiId.trim()
    && settings.telegramApiHash.trim(),
  )
}

export function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  )
}
