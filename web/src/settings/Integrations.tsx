/**
 * The Actual/Ghostfolio data sources this tenant syncs from (#369, #422). The AI
 * provider used to be a third sub-form here; it moved to its own section in
 * `Ai.tsx` alongside Prompts and the AI log, which it has more in common with
 * than with these two (#528).
 *
 * Two independent sub-forms, not a list: unlike `Property.tsx`'s roster, there is
 * exactly one of each integration per tenant, and the two have nothing to do with
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
 *  - **Test connection sends a typed secret, never a stored one — but a blank field is not
 *    automatically "no secret".** Nothing here is saved by a test, so there is no partial
 *    credential to merge against on this screen; the server does that merge instead,
 *    falling back to the tenant's own stored secret when the field is left blank and one
 *    exists (#382), so testing an already-configured integration doesn't require retyping
 *    it. The button (and, while disabled, a hint next to it) reflects that: it's enabled
 *    once every non-secret field is filled and *some* secret — typed or stored — is
 *    available, and disabled with an explanation otherwise.
 */
import { useState, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import type { IntegrationsSetting, IntegrationTest } from '../shared.ts'
import { Issue, Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

export function Configured({ yes }: { yes: boolean }): ReactNode {
  const { t } = useT()
  return (
    <span className={`badge badge--${yes ? 'ok' : 'warn'}`}>
      {t(yes ? 'settings:integrations.configured' : 'settings:integrations.notConfigured')}
    </span>
  )
}

/**
 * Why "Test connection" is inert right now, shown next to the button rather than
 * only in a `title` tooltip — a disabled button suppresses hover/focus feedback in
 * some browsers, so the explanation has to be visible on its own (#382).
 */
export function TestHint({ reason }: { reason: 'fields' | 'secret' | null }): ReactNode {
  const { t } = useT()
  if (reason === null) return null
  return (
    <p className="panel__meta muted">
      {reason === 'fields' ? t('settings:integrations.testNeedsFields') : t('settings:integrations.testNeedsSecret')}
    </p>
  )
}

export function TestResult({ result }: { result: IntegrationTest | null }): ReactNode {
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
  categorySourceLocale: string
}

const actualDraftOf = (actual: IntegrationsSetting['actual']): ActualDraft => ({
  serverUrl: actual.serverUrl,
  syncId: actual.syncId,
  password: '',
  e2ePassword: '',
  categorySourceLocale: actual.categorySourceLocale,
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
  const secretAvailable = password !== '' || actual.passwordConfigured
  const canTest = ok && secretAvailable
  const testHint: 'fields' | 'secret' | null = !ok ? 'fields' : !secretAvailable ? 'secret' : null

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
        categorySourceLocale: current.categorySourceLocale,
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

        <div className="field">
          <label className="field__label" htmlFor="integrations-actual-category-source-locale">
            {t('settings:integrations.actual.categorySourceLocale')}
          </label>
          <select
            id="integrations-actual-category-source-locale"
            className="field__input"
            value={current.categorySourceLocale}
            disabled={locked}
            onChange={(event) => edit({ categorySourceLocale: event.target.value })}
          >
            {settings.locales.supported.map((code) => (
              <option key={code} value={code}>
                {t(`settings:language.${code}`, { defaultValue: code })}
              </option>
            ))}
          </select>
          <p className="panel__meta muted">{t('settings:integrations.actual.categorySourceLocaleHint')}</p>
        </div>

        <Issue message={state.issue('serverUrl')} />
        <Issue message={state.issue('syncId')} />
        <Issue message={state.issue('categorySourceLocale')} />

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
                {
                  serverUrl,
                  syncId,
                  ...(password === '' ? {} : { password }),
                  ...(e2ePassword === '' ? {} : { e2ePassword }),
                },
                setResult,
              )
            }}
          >
            {state.pending === 'actual-test' ? t('settings:integrations.testing') : t('settings:integrations.test')}
          </button>
          {locked ? null : <TestHint reason={testHint} />}
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
  const secretAvailable = securityToken !== '' || ghostfolio.tokenConfigured
  const canTest = ok && secretAvailable
  const testHint: 'fields' | 'secret' | null = !ok ? 'fields' : !secretAvailable ? 'secret' : null

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
                { url, ...(securityToken === '' ? {} : { securityToken }) },
                setResult,
              )
            }}
          >
            {state.pending === 'ghostfolio-test'
              ? t('settings:integrations.testing')
              : t('settings:integrations.test')}
          </button>
          {locked ? null : <TestHint reason={testHint} />}
        </div>

        <TestResult result={result} />
      </form>
    </Panel>
  )
}

/**
 * Actual and Ghostfolio only — the AI provider sub-form moved to `Ai.tsx`'s own
 * section (#528), alongside the Prompts editor and AI log it belongs with rather
 * than with these two unrelated data sources.
 */
export function IntegrationsPanel(props: SettingsPanelProps): ReactNode {
  return (
    <>
      <ActualPanel {...props} />
      <GhostfolioPanel {...props} />
    </>
  )
}
