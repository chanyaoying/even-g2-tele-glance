import { useEffect, useState } from 'react'
import { BACKEND_AUTH_REJECTED_MESSAGE, BACKEND_URL_PLACEHOLDER, OFFLINE_STATUS } from '../api'
import { UPDATING_STATUS } from '../controller/model'
import { getLocale, LANGUAGE_NAMES } from '../locales/index'
import { useApp } from '../contexts/AppContext'
import type { FrontendConfig } from '../storage'

export function SettingsScreen({ buildVersion }: { buildVersion: string }) {
  const { state, settings, saveSettings, resetSettings, logoutTelegram, clearCache, testConnection } = useApp()
  const [draft, setDraft] = useState<FrontendConfig>(settings)
  /** The user changed a field since the last save; settings restored in the background must not overwrite it. */
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  /** Reset and Disconnect ask for a second tap (window.confirm is not reliable in the Even app WebView). */
  const [confirming, setConfirming] = useState<'reset' | 'logout' | null>(null)
  const [cacheCleared, setCacheCleared] = useState(false)
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testLines, setTestLines] = useState<string[]>([])
  const [logoutError, setLogoutError] = useState<string | null>(null)

  useEffect(() => {
    if (!dirty) setDraft(settings)
  }, [settings, dirty])

  function update<K extends keyof FrontendConfig>(key: K, value: FrontendConfig[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
    setDirty(true)
    setSaveState('idle')
    setConfirming(null)
  }

  async function handleSave() {
    setSaveState('saving')
    setSaveError(null)
    try {
      await saveSettings(draft)
      setDirty(false)
      setSaveState('saved')
    } catch (error) {
      setSaveState('failed')
      setSaveError(error instanceof Error ? error.message : String(error))
    }
  }

  function handleReset() {
    if (confirming !== 'reset') {
      setConfirming('reset')
      return
    }
    setConfirming(null)
    void resetSettings()
  }

  const l = getLocale()
  const hasTelegramCredentials = Boolean(draft.telegramApiId.trim() && draft.telegramApiHash.trim())
  const hasBackendSecret = Boolean(draft.backendSharedSecret.trim())
  const hasTelegramSession = Boolean(draft.telegramSession.trim())
  // Asleep or a stored list that is still updating / offline / rejected says nothing about the backend link.
  const status = 'status' in state ? state.status : undefined
  const isConnected = state.screen !== 'auth' && state.screen !== 'loading' && state.screen !== 'error' && state.screen !== 'asleep'
    && status !== OFFLINE_STATUS && status !== BACKEND_AUTH_REJECTED_MESSAGE && status !== UPDATING_STATUS

  async function handleTestConnection() {
    setTesting(true)
    setTestLines([])
    try {
      const result = await testConnection(draft)
      const lines = [result.health.ok ? l.settingsTestHealthOk : `${l.settingsTestHealthFail} (${result.health.error ?? ''})`]
      if (result.session) {
        lines.push(!result.session.ok
          ? `${l.settingsTestSessionFail} (${result.session.error ?? ''})`
          : result.session.authorized ? l.settingsTestSessionOk : l.settingsTestSessionNotLoggedIn)
      } else {
        lines.push(l.settingsTestSessionSkipped)
      }
      setTestLines(lines)
    } catch (error) {
      setTestLines([`${l.settingsTestHealthFail} (${error instanceof Error ? error.message : String(error)})`])
    } finally {
      setTesting(false)
    }
  }

  async function handleLogout() {
    if (confirming !== 'logout') {
      setConfirming('logout')
      return
    }
    setConfirming(null)
    setIsLoggingOut(true)
    setLogoutError(null)
    try {
      await logoutTelegram()
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : 'Logout failed')
      setIsLoggingOut(false)
    }
  }

  return (
    <main className="settings-screen">
      <section className="phone-panel settings-group">
        <h2>{l.settingsTelegramSection}</h2>
        <dl className="info-list">
          <div><dt>{l.settingsStatusLabel}</dt><dd>{isConnected ? l.settingsStatusConnected : l.settingsStatusNotConnected}</dd></div>
          <div><dt>{l.settingsCredentialsLabel}</dt><dd>{hasTelegramCredentials ? l.settingsConfigured : l.settingsRequired}</dd></div>
          <div><dt>{l.settingsSharedSecretLabel}</dt><dd>{hasBackendSecret ? l.settingsConfigured : l.settingsRequired}</dd></div>
          <div><dt>{l.settingsSessionLabel}</dt><dd>{hasTelegramSession ? l.settingsStoredOnPhone : isConnected ? l.settingsBackendSession : l.settingsNotLoggedIn}</dd></div>
        </dl>
        <p className="hint">{isConnected ? l.settingsSetupHidden : l.settingsSetupExpand}</p>
        <details className="settings-details" open={!isConnected}>
          <summary>{isConnected ? l.settingsChangeSetup : l.settingsSetupInstructions}</summary>
          <p className="hint">{l.settingsSetupHint}</p>
          <ol className="setup-list">
            <li>{l.settingsSetupStep1}</li>
            <li>{l.settingsSetupStep2}</li>
            <li>{l.settingsSetupStep3}</li>
            <li>{l.settingsSetupStep4}</li>
            <li>{l.settingsSetupStep5}</li>
          </ol>
          <label>
            <span>{l.settingsTelegramApiId}</span>
            <input inputMode="numeric" autoComplete="off" value={draft.telegramApiId} onChange={(event) => update('telegramApiId', event.target.value)} placeholder="123456" />
          </label>
          <label>
            <span>{l.settingsTelegramApiHash}</span>
            <input type="password" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={draft.telegramApiHash} onChange={(event) => update('telegramApiHash', event.target.value)} placeholder="0123456789abcdef0123456789abcdef" />
          </label>
        </details>
        {logoutError && <p className="field-error" role="alert">{logoutError}</p>}
        <button type="button" className="secondary" disabled={isLoggingOut || (!hasTelegramSession && !isConnected)} onClick={() => void handleLogout()}>
          {isLoggingOut ? l.settingsDisconnecting : confirming === 'logout' ? l.settingsConfirmDisconnect : l.settingsDisconnectTelegram}
        </button>
      </section>

      <section className="phone-panel settings-group">
        <h2>{l.settingsBackendSection}</h2>
        <details className="settings-details">
          <summary>{l.settingsBackendSetup}</summary>
          <p className="hint">{l.settingsBackendHint}<a href="https://github.com/jalatif/even-g2-tele-glance.git" target="_blank" rel="noreferrer">github.com/jalatif/even-g2-tele-glance</a>.</p>
          <p className="hint">
            The packaged app must whitelist the exact backend origin you plan to use. If you change
            the backend URL, rerun `npm run configure:tailscale --prefix web` with the new origin and
            repack before sideloading.
          </p>
          <pre className="command-block"><code>{`git clone https://github.com/jalatif/even-g2-tele-glance.git
cd even-g2-tele-glance
cp .env.example .env
# edit .env and set TELEGLANCE_SHARED_SECRET
cd server
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
cd ..
scripts/start-backend.sh --reload`}</code></pre>
        </details>
        <label>
          <span>{l.settingsBackendUrl}</span>
          <input value={draft.apiBaseUrl} onChange={(event) => update('apiBaseUrl', event.target.value)} placeholder={BACKEND_URL_PLACEHOLDER} />
        </label>
        <label>
          <span>{l.settingsBackendSecret}</span>
          <input type="password" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={draft.backendSharedSecret} onChange={(event) => update('backendSharedSecret', event.target.value)} placeholder={l.settingsBackendSecretPlaceholder} />
        </label>
        <button type="button" className="secondary" disabled={testing} onClick={() => void handleTestConnection()}>
          {testing ? l.settingsTesting : l.settingsTestConnection}
        </button>
        {testLines.length > 0 && (
          <ul className="test-results" aria-live="polite">
            {testLines.map((line) => <li key={line}>{line}</li>)}
          </ul>
        )}
        <p className="hint">{l.settingsBackendSecretHint}</p>
      </section>

      <section className="phone-panel settings-group">
        <h2>{l.settingsVoiceSection}</h2>
        <label>
          <span>{l.settingsSttUrl}</span>
          <input value={draft.sttBaseUrl} onChange={(event) => update('sttBaseUrl', event.target.value)} placeholder="Use backend URL" />
        </label>
        <p className="hint">{l.settingsSttHint}</p>
        <label className="inline-setting">
          <span>{l.settingsDebugEvents}</span>
          <input type="checkbox" checked={draft.debugEventsEnabled} onChange={(event) => update('debugEventsEnabled', event.target.checked)} />
        </label>
        <p className="hint">{l.settingsDebugEventsHint}</p>
        <label>
          <span>Glasses font width correction (%)</span>
          <input type="number" min="70" max="150" step="1" value={draft.fontWidthPercent} onChange={(event) => update('fontWidthPercent', Number(event.target.value))} />
        </label>
        <p className="hint">Text lines are filled to the screen edge using the glasses font measured in the simulator. If lines wrap twice on the glasses, raise this a little (e.g. 110); if they stop short of the right edge, lower it. Default 100.</p>
        <label>
          <span>{l.settingsRecMinDuration}</span>
          <input type="number" min="0" max="5000" step="100" value={draft.recordingMinDurationMs} onChange={(event) => update('recordingMinDurationMs', Number(event.target.value))} />
        </label>
        <details className="settings-details">
          <summary>{l.settingsAdvancedPolling}</summary>
          <p className="hint">{l.settingsAdvancedPollingHint}</p>
          <label>
            <span>{l.settingsChatPoll}</span>
            <input type="number" min="1000" max="60000" step="500" value={draft.chatPollMs} onChange={(event) => update('chatPollMs', Number(event.target.value))} />
          </label>
          <label>
            <span>{l.settingsMessagePoll}</span>
            <input type="number" min="1000" max="60000" step="500" value={draft.messagePollMs} onChange={(event) => update('messagePollMs', Number(event.target.value))} />
          </label>
        </details>
      </section>

      <section className="phone-panel settings-group">
        <h2>{l.settingsLanguageSection}</h2>
        <label>
          <span>{l.settingsLanguageLabel}</span>
          <select value={draft.language} onChange={(event) => update('language', event.target.value)}>
            {Object.entries(LANGUAGE_NAMES).map(([code, name]) => (
              <option key={code} value={code}>{name}</option>
            ))}
          </select>
        </label>
        <p className="hint">{l.settingsLanguageHint}</p>
      </section>

      <section className="phone-panel settings-group">
        <h2>{l.settingsBuildSection}</h2>
        <dl className="info-list">
          <div><dt>{l.settingsBuildVersion}</dt><dd>{buildVersion}</dd></div>
          <div><dt>{l.settingsApiUrl}</dt><dd>{settings.apiBaseUrl}</dd></div>
        </dl>
      </section>

      {saveState === 'failed' && <p className="field-error" role="alert">{l.settingsSaveFailed}{saveError ? ` (${saveError})` : ''}</p>}
      <div className="settings-actions">
        <button type="button" disabled={saveState === 'saving'} onClick={() => void handleSave()}>
          {saveState === 'saving' ? l.settingsSaving : saveState === 'saved' ? l.settingsSaved : l.settingsSave}
        </button>
        <button type="button" className="secondary" onClick={() => {
          void clearCache().then(() => setCacheCleared(true))
        }}>
          {cacheCleared ? l.settingsCacheCleared : l.settingsClearCache}
        </button>
        <button type="button" className="secondary" onClick={handleReset}>{confirming === 'reset' ? l.settingsConfirmReset : l.settingsReset}</button>
      </div>
    </main>
  )
}
