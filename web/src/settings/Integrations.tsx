/**
 * The Actual/Ghostfolio/AI connection this tenant uses (#369, #422).
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

function Configured({ yes }: { yes: boolean }): ReactNode {
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
function TestHint({ reason }: { reason: 'fields' | 'secret' | null }): ReactNode {
  const { t } = useT()
  if (reason === null) return null
  return (
    <p className="panel__meta muted">
      {reason === 'fields' ? t('settings:integrations.testNeedsFields') : t('settings:integrations.testNeedsSecret')}
    </p>
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

interface AiDraft {
  provider: IntegrationsSetting['ai']['provider']
  apiKey: string
  googleCloudProject: string
  baseUrl: string
  modelFast: string
  modelDeep: string
  modelPrices: Record<string, AiPriceDraft>
  budgetEur: string
}

interface AiPriceDraft {
  inputEur: string
  cachedInputEur: string
  cacheWriteInputEur: string
  outputEur: string
}

const blankPrice = (): AiPriceDraft => ({ inputEur: '', cachedInputEur: '', cacheWriteInputEur: '', outputEur: '' })

const aiDraftOf = (ai: IntegrationsSetting['ai']): AiDraft => ({
  provider: ai.provider,
  apiKey: '',
  googleCloudProject: ai.googleCloudProject ?? '',
  baseUrl: ai.baseUrl ?? '',
  modelFast: ai.modelFast,
  modelDeep: ai.modelDeep,
  modelPrices: Object.fromEntries(Object.entries(ai.modelPrices).map(([model, price]) => [
    model,
    {
      inputEur: String(price.inputEurMicro / 1_000_000),
      cachedInputEur: String(price.cachedInputEurMicro / 1_000_000),
      cacheWriteInputEur: String(price.cacheWriteInputEurMicro / 1_000_000),
      outputEur: String(price.outputEurMicro / 1_000_000),
    },
  ])),
  budgetEur: String(ai.budgetEurMicro / 1_000_000),
})

function AiPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const { ai } = settings.integrations
  const locked = !owner || state.busy
  const [draft, setDraft] = useState<AiDraft | null>(null)
  const [result, setResult] = useState<IntegrationTest | null>(null)
  const current = draft ?? aiDraftOf(ai)

  const edit = (patch: Partial<AiDraft>): void => setDraft({ ...current, ...patch })

  const apiKey = current.apiKey.trim()
  const googleCloudProject = current.googleCloudProject.trim()
  const baseUrl = current.baseUrl.trim()
  const modelFast = current.modelFast.trim()
  const modelDeep = current.modelDeep.trim()
  const storedKeyApplies = current.provider === ai.provider && ai.apiKeyConfigured
  const secretAvailable = apiKey !== '' || storedKeyApplies
  const isCustom = current.provider === 'openai-compatible'
  const isOfficialCompatible = current.provider === 'openai' || current.provider === 'xai'
  const canTest =
    current.provider === 'gemini-vertex'
      ? googleCloudProject !== ''
      : isCustom
        ? baseUrl !== '' && modelFast !== ''
        : secretAvailable && modelFast !== ''
  const testHint: 'fields' | 'secret' | null =
    current.provider === 'gemini-vertex'
      ? googleCloudProject === ''
        ? 'fields'
        : null
      : isCustom
        ? baseUrl === '' || modelFast === ''
          ? 'fields'
          : null
        : !secretAvailable
          ? 'secret'
          : modelFast === ''
            ? 'fields'
            : null

  const selectedModels = [...new Set([modelFast, modelDeep].filter((model) => model !== ''))]
  const editPrice = (model: string, patch: Partial<AiPriceDraft>): void => {
    const price = current.modelPrices[model] ?? blankPrice()
    edit({ modelPrices: { ...current.modelPrices, [model]: { ...price, ...patch } } })
  }

  const modelPrices = Object.fromEntries(
    selectedModels.flatMap((model) => {
      const price = current.modelPrices[model]
      if (price === undefined) return []
      const values = [price.inputEur, price.cachedInputEur, price.cacheWriteInputEur, price.outputEur]
      if (values.some((value) => value.trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0)) return []
      return [[model, {
        inputEur: Number(price.inputEur),
        cachedInputEur: Number(price.cachedInputEur),
        cacheWriteInputEur: Number(price.cacheWriteInputEur),
        outputEur: Number(price.outputEur),
      }] as const]
    }),
  )
  const customPricesComplete = !isCustom || selectedModels.every((model) => modelPrices[model] !== undefined)

  const submit = (): void => {
    state.save(
      'integrations-ai',
      'PATCH',
      '/api/settings/integrations/ai',
      {
        provider: current.provider,
        googleCloudProject: googleCloudProject === '' ? null : googleCloudProject,
        baseUrl: isCustom ? baseUrl : null,
        ...(apiKey === '' ? {} : { apiKey }),
        modelFast,
        modelDeep,
        modelPrices,
        budgetEur: Number(current.budgetEur),
      },
      () => setDraft(null),
    )
  }

  return (
    <Panel
      title={t('settings:integrations.ai.title')}
      hint={t('settings:integrations.ai.hint')}
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
          <label className="field__label" htmlFor="integrations-ai-provider">
            {t('settings:integrations.ai.providerLabel')}
          </label>
          <select
            id="integrations-ai-provider"
            className="field__input"
            value={current.provider}
            disabled={locked}
            onChange={(event) => {
              const provider = event.target.value as AiDraft['provider']
              edit({
                provider,
                apiKey: '',
                googleCloudProject: provider === 'gemini-vertex' ? current.googleCloudProject : '',
                baseUrl:
                  provider === 'openai'
                    ? 'https://api.openai.com/v1'
                    : provider === 'xai'
                      ? 'https://api.x.ai/v1'
                      : provider === 'openai-compatible'
                        ? ''
                        : '',
                ...(provider === 'openai' ? { modelFast: 'gpt-5.4-mini', modelDeep: 'gpt-5.4' } : {}),
                ...(provider === 'xai' ? { modelFast: 'grok-4.3', modelDeep: 'grok-4.3' } : {}),
                ...(provider === 'gemini-aistudio' || provider === 'gemini-vertex'
                  ? { modelFast: 'gemini-3.7-flash', modelDeep: 'gemini-3.1-pro-preview' }
                  : {}),
              })
            }}
          >
            <option value="gemini-aistudio">{t('settings:integrations.ai.provider.aistudio')}</option>
            <option value="gemini-vertex">{t('settings:integrations.ai.provider.vertex')}</option>
            <option value="openai">{t('settings:integrations.ai.provider.openai')}</option>
            <option value="xai">{t('settings:integrations.ai.provider.xai')}</option>
            <option value="openai-compatible">{t('settings:integrations.ai.provider.compatible')}</option>
          </select>
        </div>

        {current.provider === 'gemini-vertex' ? null : <div className="field">
          <label className="field__label" htmlFor="integrations-ai-api-key">
            {t('settings:integrations.ai.apiKey')} <Configured yes={storedKeyApplies} />
          </label>
          <input
            id="integrations-ai-api-key"
            className="field__input"
            type="password"
            autoComplete="new-password"
            value={current.apiKey}
            disabled={locked}
            onChange={(event) => edit({ apiKey: event.target.value })}
          />
          {storedKeyApplies ? (
            <p className="panel__meta muted">{t('settings:integrations.secretUnchanged')}</p>
          ) : null}
        </div>}

        {current.provider === 'gemini-vertex' ? <div className="field">
          <label className="field__label" htmlFor="integrations-ai-project">
            {t('settings:integrations.ai.googleCloudProject')}
          </label>
          <input
            id="integrations-ai-project"
            className="field__input"
            type="text"
            autoComplete="off"
            value={current.googleCloudProject}
            disabled={locked}
            onChange={(event) => edit({ googleCloudProject: event.target.value })}
          />
        </div> : null}

        {isCustom || isOfficialCompatible ? <div className="field">
          <label className="field__label" htmlFor="integrations-ai-base-url">
            {t('settings:integrations.ai.baseUrl')}
          </label>
          <input
            id="integrations-ai-base-url"
            className="field__input"
            type="url"
            autoComplete="off"
            value={current.baseUrl}
            readOnly={isOfficialCompatible}
            disabled={locked}
            onChange={(event) => edit({ baseUrl: event.target.value })}
          />
          <p className="panel__meta muted">
            {t(isCustom ? 'settings:integrations.ai.compatibleHint' : 'settings:integrations.ai.officialHint')}
          </p>
        </div> : null}

        <div className="field">
          <label className="field__label" htmlFor="integrations-ai-model-fast">
            {t('settings:ai.model.fast')}
          </label>
          <input
            id="integrations-ai-model-fast"
            className="field__input"
            type="text"
            autoComplete="off"
            value={current.modelFast}
            disabled={locked}
            onChange={(event) => edit({ modelFast: event.target.value })}
          />
        </div>

        {isCustom || isOfficialCompatible ? <fieldset className="field">
          <legend className="field__label">{t('settings:integrations.ai.prices')}</legend>
          <p className="panel__meta muted">{t('settings:integrations.ai.pricesHint')}</p>
          {selectedModels.map((model) => {
            const price = current.modelPrices[model] ?? blankPrice()
            return <div className="integrations-price" key={model}>
              <p className="field__label">{model}</p>
              {(['inputEur', 'cachedInputEur', 'cacheWriteInputEur', 'outputEur'] as const).map((key) => (
                <label className="field" key={key}>
                  <span className="field__label">{t(`settings:integrations.ai.price.${key}`)}</span>
                  <input
                    className="field__input num"
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    value={price[key]}
                    disabled={locked}
                    onChange={(event) => editPrice(model, { [key]: event.target.value })}
                  />
                </label>
              ))}
            </div>
          })}
        </fieldset> : null}

        <div className="field">
          <label className="field__label" htmlFor="integrations-ai-model-deep">
            {t('settings:ai.model.deep')}
          </label>
          <input
            id="integrations-ai-model-deep"
            className="field__input"
            type="text"
            autoComplete="off"
            value={current.modelDeep}
            disabled={locked}
            onChange={(event) => edit({ modelDeep: event.target.value })}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="integrations-ai-budget">
            {t('settings:ai.budget')}
          </label>
          <input
            id="integrations-ai-budget"
            className="field__input num"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={current.budgetEur}
            disabled={locked}
            onChange={(event) => edit({ budgetEur: event.target.value })}
          />
        </div>

        <Issue message={state.issue('googleCloudProject')} />

        <div className="integrations__actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={locked || draft === null || modelFast === '' || modelDeep === '' || !customPricesComplete}
          >
            {state.pending === 'integrations-ai' ? t('shell.loading') : t('action.save')}
          </button>
          <button
            type="button"
            className="button button--quiet"
            disabled={locked || !canTest}
            onClick={() => {
              state.ask<IntegrationTest>(
                'ai-test',
                'POST',
                '/api/settings/integrations/ai/test',
                {
                  provider: current.provider,
                  ...(apiKey === '' ? {} : { apiKey }),
                  ...(googleCloudProject === '' ? {} : { googleCloudProject }),
                  baseUrl: isCustom ? baseUrl : null,
                  model: modelFast,
                },
                setResult,
              )
            }}
          >
            {state.pending === 'ai-test'
              ? t('settings:integrations.testing')
              : isCustom || isOfficialCompatible
                ? t('settings:integrations.ai.capabilityTest')
                : t('settings:integrations.test')}
          </button>
          {locked ? null : <TestHint reason={testHint} />}
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
      <AiPanel {...props} />
    </>
  )
}
