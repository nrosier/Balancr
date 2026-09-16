/**
 * The Actual/Ghostfolio/Gemini connection this tenant uses (#369).
 *
 * Three independent sub-forms, not a list: unlike `Property.tsx`'s roster, there is
 * exactly one of each integration per tenant, and the three have nothing to do with
 * each other — editing Ghostfolio's URL has no business disabling the Actual form.
 *
 *  - **A secret is never on the wire, so a secret field starts empty.** `passwordConfigured`
 *    and its siblings say whether one is stored, not what it is; the badge beside each
 *    field is that boolean, and the input itself is always blank on load. Typing in it
 *    means "replace"; leaving it blank on submit means "leave the stored value alone" —
 *    the PATCH routes read an omitted key that way, so a blank field must send no key at
 *    all, not an empty string.
 *  - **A draft, not three, per sub-form.** Same reasoning as `Property.tsx`'s rows: the
 *    save button stays disabled until something is actually typed, so a stray click can't
 *    resubmit a form nobody touched.
 *  - **Test connection sends the full candidate, never the stored value.** Nothing here is
 *    saved by a test, so there is no partial credential to merge against — which also means
 *    a secret field left blank cannot be tested, because there is nothing on this screen to
 *    send. The button stays disabled until every field the test route requires is filled in.
 */
import { useState, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import type { IntegrationsSetting, IntegrationTest } from '../shared.ts'
import { Issue, Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

function Configured({ yes }: { yes: boolean }): ReactNode {
  const { t } = useT()
  return (
    <span className={`badge badge--${yes ? 'ok' : 'warn'}`}>
      {t(yes ? 'settings:integrations.configured' : 'settings:integrations.notConfigured')}
    </span>
  )
}

function TestResult({ result }: { result: IntegrationTest | null }): ReactNode {
  const { t } = useT()
  if (result === null) return null
  return (
    <p className={result.ok ? 'notice notice--info' : 'notice notice--error'} role="status">
      {result.ok ? t('settings:integrations.testOk') : result.message}
    </p>
  )
}

interface ActualDraft {
  serverUrl: string
  syncId: string
  password: string
  e2ePassword: string
}

const actualDraftOf = (actual: IntegrationsSetting['actual']): ActualDraft => ({
  serverUrl: actual.serverUrl,
  syncId: actual.syncId,
  password: '',
  e2ePassword: '',
})

function ActualPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const { actual } = settings.integrations
  const locked = !owner || state.busy
  const [draft, setDraft] = useState<ActualDraft | null>(null)
  const [result, setResult] = useState<IntegrationTest | null>(null)
  const current = draft ?? actualDraftOf(actual)

  const edit = (patch: Partial<ActualDraft>): void => setDraft({ ...current, ...patch })

  const serverUrl = current.serverUrl.trim()
  const syncId = current.syncId.trim()
  const password = current.password.trim()
  const e2ePassword = current.e2ePassword.trim()
  const ok = serverUrl !== '' && syncId !== ''
  const canTest = ok && password !== ''

  const submit = (): void => {
    state.save(
      'integrations-actual',
      'PATCH',
      '/api/settings/integrations/actual',
      {
        serverUrl,
        syncId,
        ...(password === '' ? {} : { password }),
        ...(e2ePassword === '' ? {} : { e2ePassword }),
      },
      () => setDraft(null),
    )
  }

  return (
    <Panel
      title={t('settings:integrations.actual.title')}
      hint={t('settings:integrations.actual.hint')}
      notice={owner ? null : <p className="panel__meta muted">{t('settings:viewerOnly')}</p>}
    >
      <form
        className="integrations-form"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor="integrations-actual-server-url">
            {t('settings:integrations.actual.serverUrl')}
          </label>
          <input
            id="integrations-actual-server-url"
            className="field__input"
            type="text"
            autoComplete="off"
            value={current.serverUrl}
            disabled={locked}
            onChange={(event) => edit({ serverUrl: event.target.value })}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="integrations-actual-sync-id">
            {t('settings:integrations.actual.syncId')}
          </label>
          <input
            id="integrations-actual-sync-id"
            className="field__input"
            type="text"
            autoComplete="off"
            value={current.syncId}
            disabled={locked}
            onChange={(event) => edit({ syncId: event.target.value })}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="integrations-actual-password">
            {t('settings:integrations.actual.password')} <Configured yes={actual.passwordConfigured} />
          </label>
          <input
            id="integrations-actual-password"
            className="field__input"
            type="password"
            autoComplete="new-password"
            value={current.password}
            disabled={locked}
            onChange={(event) => edit({ password: event.target.value })}
          />
          {actual.passwordConfigured ? (
            <p className="panel__meta muted">{t('settings:integrations.secretUnchanged')}</p>
          ) : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="integrations-actual-e2e-password">
            {t('settings:integrations.actual.e2ePassword')} <Configured yes={actual.e2ePasswordConfigured} />
          </label>
          <input
            id="integrations-actual-e2e-password"
            className="field__input"
            type="password"
            autoComplete="new-password"
            value={current.e2ePassword}
            disabled={locked}
            onChange={(event) => edit({ e2ePassword: event.target.value })}
          />
          {actual.e2ePasswordConfigured ? (
            <p className="panel__meta muted">{t('settings:integrations.secretUnchanged')}</p>
          ) : null}
        </div>

        <Issue message={state.issue('serverUrl')} />
        <Issue message={state.issue('syncId')} />

        <div className="integrations__actions">
          <button type="submit" className="button button--primary" disabled={locked || draft === null || !ok}>
            {state.pending === 'integrations-actual' ? t('shell.loading') : t('action.save')}
          </button>
          <button
            type="button"
            className="button button--quiet"
            disabled={locked || !canTest}
            onClick={() => {
              state.ask<IntegrationTest>(
                'actual-test',
                'POST',
                '/api/settings/integrations/actual/test',
                { serverUrl, syncId, password, ...(e2ePassword === '' ? {} : { e2ePassword }) },
                setResult,
              )
            }}
          >
            {state.pending === 'actual-test' ? t('settings:integrations.testing') : t('settings:integrations.test')}
          </button>
        </div>

        <TestResult result={result} />
      </form>
    </Panel>
  )
}

interface GhostfolioDraft {
  url: string
  securityToken: string
}

const ghostfolioDraftOf = (ghostfolio: IntegrationsSetting['ghostfolio']): GhostfolioDraft => ({
  url: ghostfolio.url,
  securityToken: '',
})

function GhostfolioPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const { ghostfolio } = settings.integrations
  const locked = !owner || state.busy
  const [draft, setDraft] = useState<GhostfolioDraft | null>(null)
  const [result, setResult] = useState<IntegrationTest | null>(null)
  const current = draft ?? ghostfolioDraftOf(ghostfolio)

  const edit = (patch: Partial<GhostfolioDraft>): void => setDraft({ ...current, ...patch })

  const url = current.url.trim()
  const securityToken = current.securityToken.trim()
  const ok = url !== ''
  const canTest = ok && securityToken !== ''

  const submit = (): void => {
    state.save(
      'integrations-ghostfolio',
      'PATCH',
      '/api/settings/integrations/ghostfolio',
      { url, ...(securityToken === '' ? {} : { securityToken }) },
      () => setDraft(null),
    )
  }

  return (
    <Panel
      title={t('settings:integrations.ghostfolio.title')}
      hint={t('settings:integrations.ghostfolio.hint')}
      notice={owner ? null : <p className="panel__meta muted">{t('settings:viewerOnly')}</p>}
    >
      <form
        className="integrations-form"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor="integrations-ghostfolio-url">
            {t('settings:integrations.ghostfolio.url')}
          </label>
          <input
            id="integrations-ghostfolio-url"
            className="field__input"
            type="text"
            autoComplete="off"
            value={current.url}
            disabled={locked}
            onChange={(event) => edit({ url: event.target.value })}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="integrations-ghostfolio-token">
            {t('settings:integrations.ghostfolio.securityToken')}{' '}
            <Configured yes={ghostfolio.tokenConfigured} />
          </label>
          <input
            id="integrations-ghostfolio-token"
            className="field__input"
            type="password"
            autoComplete="new-password"
            value={current.securityToken}
            disabled={locked}
            onChange={(event) => edit({ securityToken: event.target.value })}
          />
          {ghostfolio.tokenConfigured ? (
            <p className="panel__meta muted">{t('settings:integrations.secretUnchanged')}</p>
          ) : null}
        </div>

        <Issue message={state.issue('url')} />

        <div className="integrations__actions">
          <button type="submit" className="button button--primary" disabled={locked || draft === null || !ok}>
            {state.pending === 'integrations-ghostfolio' ? t('shell.loading') : t('action.save')}
          </button>
          <button
            type="button"
            className="button button--quiet"
            disabled={locked || !canTest}
            onClick={() => {
              state.ask<IntegrationTest>(
                'ghostfolio-test',
                'POST',
                '/api/settings/integrations/ghostfolio/test',
                { url, securityToken },
                setResult,
              )
            }}
          >
            {state.pending === 'ghostfolio-test'
              ? t('settings:integrations.testing')
              : t('settings:integrations.test')}
          </button>
        </div>

        <TestResult result={result} />
      </form>
    </Panel>
  )
}

interface GeminiDraft {
  provider: 'aistudio' | 'vertex'
  apiKey: string
  googleCloudProject: string
}

const geminiDraftOf = (gemini: IntegrationsSetting['gemini']): GeminiDraft => ({
  provider: gemini.provider,
  apiKey: '',
  googleCloudProject: gemini.googleCloudProject ?? '',
})

function GeminiPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const { gemini } = settings.integrations
  const locked = !owner || state.busy
  const [draft, setDraft] = useState<GeminiDraft | null>(null)
  const [result, setResult] = useState<IntegrationTest | null>(null)
  const current = draft ?? geminiDraftOf(gemini)

  const edit = (patch: Partial<GeminiDraft>): void => setDraft({ ...current, ...patch })

  const apiKey = current.apiKey.trim()
  const googleCloudProject = current.googleCloudProject.trim()
  const canTest =
    current.provider === 'vertex' ? googleCloudProject !== '' : apiKey !== ''

  const submit = (): void => {
    state.save(
      'integrations-gemini',
      'PATCH',
      '/api/settings/integrations/gemini',
      {
        provider: current.provider,
        googleCloudProject: googleCloudProject === '' ? null : googleCloudProject,
        ...(apiKey === '' ? {} : { apiKey }),
      },
      () => setDraft(null),
    )
  }

  return (
    <Panel
      title={t('settings:integrations.gemini.title')}
      hint={t('settings:integrations.gemini.hint')}
      notice={owner ? null : <p className="panel__meta muted">{t('settings:viewerOnly')}</p>}
    >
      <form
        className="integrations-form"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor="integrations-gemini-provider">
            {t('settings:integrations.gemini.providerLabel')}
          </label>
          <select
            id="integrations-gemini-provider"
            className="field__input"
            value={current.provider}
            disabled={locked}
            onChange={(event) => edit({ provider: event.target.value as GeminiDraft['provider'] })}
          >
            <option value="aistudio">{t('settings:integrations.gemini.provider.aistudio')}</option>
            <option value="vertex">{t('settings:integrations.gemini.provider.vertex')}</option>
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="integrations-gemini-api-key">
            {t('settings:integrations.gemini.apiKey')} <Configured yes={gemini.apiKeyConfigured} />
          </label>
          <input
            id="integrations-gemini-api-key"
            className="field__input"
            type="password"
            autoComplete="new-password"
            value={current.apiKey}
            disabled={locked}
            onChange={(event) => edit({ apiKey: event.target.value })}
          />
          {gemini.apiKeyConfigured ? (
            <p className="panel__meta muted">{t('settings:integrations.secretUnchanged')}</p>
          ) : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="integrations-gemini-project">
            {t('settings:integrations.gemini.googleCloudProject')}
          </label>
          <input
            id="integrations-gemini-project"
            className="field__input"
            type="text"
            autoComplete="off"
            value={current.googleCloudProject}
            disabled={locked}
            onChange={(event) => edit({ googleCloudProject: event.target.value })}
          />
        </div>

        <Issue message={state.issue('googleCloudProject')} />

        <div className="integrations__actions">
          <button type="submit" className="button button--primary" disabled={locked || draft === null}>
            {state.pending === 'integrations-gemini' ? t('shell.loading') : t('action.save')}
          </button>
          <button
            type="button"
            className="button button--quiet"
            disabled={locked || !canTest}
            onClick={() => {
              state.ask<IntegrationTest>(
                'gemini-test',
                'POST',
                '/api/settings/integrations/gemini/test',
                {
                  provider: current.provider,
                  ...(apiKey === '' ? {} : { apiKey }),
                  ...(googleCloudProject === '' ? {} : { googleCloudProject }),
                },
                setResult,
              )
            }}
          >
            {state.pending === 'gemini-test' ? t('settings:integrations.testing') : t('settings:integrations.test')}
          </button>
        </div>

        <TestResult result={result} />
      </form>
    </Panel>
  )
}

export function IntegrationsPanel(props: SettingsPanelProps): ReactNode {
  return (
    <>
      <ActualPanel {...props} />
      <GhostfolioPanel {...props} />
      <GeminiPanel {...props} />
    </>
  )
}
