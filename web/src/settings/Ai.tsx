/**
 * AI configuration in one place (#528): the provider credentials, the prompt
 * editor, and the activity log used to be three unrelated top-level tabs
 * (Integrations, Prompts, AI log) despite being three views onto the same
 * concern. `AiProviderPanel` below is the former `AiPanel` from
 * `Integrations.tsx`, unchanged except for its home and the shared `Configured`/
 * `TestHint`/`TestResult` helpers it now imports rather than sharing a module
 * scope with.
 *
 * Provider and Prompts are mounted-hidden, not conditionally rendered, for the
 * same reason `BenchmarkSection` and `ThresholdsSection` are: each holds a
 * typed-but-unsaved draft in its own `useState`, and unmounting either to show
 * a sibling tab would throw it away the moment somebody switched tabs to check
 * the log and switched back. The log itself has no draft to lose, so it stays
 * conditionally rendered — mounting it unconditionally would fetch
 * `/api/settings/ai/runs` even on tabs that never show it.
 */
import { useState, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import type { IntegrationsSetting, IntegrationTest } from '../shared.ts'
import { AiLog } from './AiLog.tsx'
import { Configured, TestHint, TestResult } from './Integrations.tsx'
import { Issue, Panel } from './Panel.tsx'
import { PromptsPanel } from './Prompts.tsx'
import type { SettingsPanelProps } from './state.ts'
import { SectionNav } from '../ui/SectionNav.tsx'
import { useSubsection, type Section } from '../ui/sections.ts'

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

function AiProviderPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
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
  const isAnthropic = current.provider === 'anthropic'
  const hasFixedEndpoint = isOfficialCompatible || isAnthropic
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
                      : provider === 'anthropic'
                        ? 'https://api.anthropic.com/v1'
                      : provider === 'openai-compatible'
                        ? ''
                        : '',
                ...(provider === 'openai' ? { modelFast: 'gpt-5.4-mini', modelDeep: 'gpt-5.4' } : {}),
                ...(provider === 'xai' ? { modelFast: 'grok-4.3', modelDeep: 'grok-4.3' } : {}),
                ...(provider === 'anthropic'
                  ? { modelFast: 'claude-sonnet-5', modelDeep: 'claude-opus-5' }
                  : {}),
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
            <option value="anthropic">{t('settings:integrations.ai.provider.anthropic')}</option>
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

        {isCustom || hasFixedEndpoint ? <div className="field">
          <label className="field__label" htmlFor="integrations-ai-base-url">
            {t('settings:integrations.ai.baseUrl')}
          </label>
          <input
            id="integrations-ai-base-url"
            className="field__input"
            type="url"
            autoComplete="off"
            value={current.baseUrl}
            readOnly={hasFixedEndpoint}
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

        {isCustom || isOfficialCompatible || isAnthropic ? <fieldset className="field">
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
              : isCustom || isOfficialCompatible || isAnthropic
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

type AiSubsectionId = 'provider' | 'prompts' | 'log'

const AI_SUBSECTIONS: readonly Section<AiSubsectionId>[] = [
  { id: 'provider', path: '/settings/ai', labelKey: 'settings:integrations.ai.title' },
  { id: 'prompts', path: '/settings/ai/prompts', labelKey: 'settings:nav.prompts' },
  { id: 'log', path: '/settings/ai/log', labelKey: 'settings:nav.aiLog' },
]

export function AiSection(props: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const active = useSubsection(AI_SUBSECTIONS)

  return (
    <SectionNav sections={AI_SUBSECTIONS} variant="sub" ariaLabel={t('settings:nav.ai')}>
      <div hidden={active !== 'provider'}>
        <AiProviderPanel {...props} />
      </div>
      <div hidden={active !== 'prompts'}>
        <PromptsPanel {...props} />
      </div>
      {active === 'log' ? <AiLog /> : null}
    </SectionNav>
  )
}
