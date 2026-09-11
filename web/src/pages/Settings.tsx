/**
 * The one page that writes.
 *
 * Everything else in the application reads Balancr's own SQLite and shows it. Here a
 * form changes what the next aggregation pass computes, which instructions the next
 * analysis runs under, and which of two accounts holding the same positions counts
 * toward net worth. That difference sets the whole shape of the screen:
 *
 *  - **The payload is the state.** `GET /api/settings` returns every panel's data and
 *    every write returns it again, so a panel never patches its own copy of a
 *    field. `useSettings` in `../settings/state.ts` holds that single payload and the
 *    one request in flight; the panels are given it and a way to write.
 *  - **A viewer sees everything and changes one thing.** The role is on the payload,
 *    and the only write a viewer may make is their own interface language. Rather than
 *    hiding panels — which would leave someone unable to see what the thresholds are
 *    set to, or read the prompt that produced last night's findings — every control is
 *    rendered and disabled, with the reason said once per panel.
 *  - **Nothing here takes effect on this screen.** No figure on this page is recomputed
 *    by anything on it, so each panel says when its change lands instead of pretending
 *    to show a result.
 *
 * **Sections (#200, re-grouped for #336).** What used to be one long scroll of nine
 * panels is now one section at a time, chosen by `../settings/sections.ts`'s
 * `sectionFor` from the real URL (`routes.ts` marks `/settings` `nested`, so every
 * `/settings/*` path still lands on this component) and rendered under `SettingsNav`'s
 * tab strip. `useSettings()` is still called exactly once here regardless of section —
 * the payload behind every panel is one request, not one per tab. Six tabs, each at
 * most one sub-tab deep: Account and Accounts have no sub-tabs of their own; Portfolio,
 * Budget, AI and System each own exactly one strip of sub-tabs, defined and rendered
 * right here rather than through an imported pre-built section, so nothing nests a
 * `SectionNav` inside another one.
 *
 * The status panel is the exception to the payload rule and says so in its own header:
 * it reads `/api/status`, not the settings payload, because readiness decays while the
 * page is open and because it has to be able to be the thing that failed while the
 * rest of the page loaded. The build block beside it stays separate for the same reason
 * in reverse — the version and revision come from the settings payload, so they are
 * still on screen when `/api/status` is what is broken, which is when a bug report
 * needs them most. Both live on System, the section for "how this instance is doing"
 * rather than any one setting.
 *
 * The risk profile and property now share a Portfolio tab, since both are inputs to
 * the same suggestion: somebody arriving because the portfolio page proposed a trade is
 * looking for one of these two panels, not for the aggregation thresholds.
 *
 * The household, the COICOP mapping and the thresholds now share a Budget tab, since
 * all three decide what a budget page shows. Household and its benchmark comparison
 * used to be sub-sub-tabs of their own (a third tab-strip level, #200's one real
 * regression); they now stack on one page, since flattening them costs nothing once
 * mapping and thresholds are sibling tabs rather than sharing the strip.
 *
 * Usage/cost monitoring moved off Status and onto its own AI tab alongside the prompt
 * editor (#325 had put it on Status because that was the only place tracking anything
 * "live"; it reads no better there than being where the other AI-facing setting is).
 */
import type { ReactNode } from 'react'
import { useResource } from '../api/resource.tsx'
import { useT } from '../i18n.ts'
import { useRouter } from '../router.tsx'
import { AccountsPanel } from '../settings/Accounts.tsx'
import { ComparisonPanel, HouseholdPanel, MappingPanel } from '../settings/Benchmark.tsx'
import { LanguagePanel } from '../settings/Language.tsx'
import { PromptsPanel } from '../settings/Prompts.tsx'
import { PropertyPanel } from '../settings/Property.tsx'
import { RiskPanel } from '../settings/Risk.tsx'
import { sectionFor } from '../settings/sections.ts'
import { SettingsNav } from '../settings/SettingsNav.tsx'
import { AiUsage, StatusPanel } from '../settings/Status.tsx'
import { ThresholdsPanel } from '../settings/Thresholds.tsx'
import { useSettings, type SettingsPanelProps } from '../settings/state.ts'
import { formatMonth, type AiEstimate } from '../shared.ts'
import { DataState } from '../ui/DataState.tsx'
import { SectionNav } from '../ui/SectionNav.tsx'
import { useSubsection, type Section } from '../ui/sections.ts'
import { PageHeader } from './PageHeader.tsx'
import '../settings/settings.css'

type PortfolioSubsectionId = 'risk' | 'property'

const PORTFOLIO_SUBSECTIONS: readonly Section<PortfolioSubsectionId>[] = [
  { id: 'risk', path: '/settings/portfolio/risk', labelKey: 'settings:nav.risk' },
  { id: 'property', path: '/settings/portfolio/property', labelKey: 'settings:nav.property' },
]

/**
 * Portfolio's own sub-tabs: risk profile and property, both former top-level sections
 * (#200) now grouped under the one tab that decides what the portfolio page proposes.
 *
 * Both stay mounted, hidden rather than unrendered: `RiskPanel` and `PropertyPanel` each
 * hold a typed-but-unsaved draft in their own `useState`, and unmounting one to show the
 * other would throw that draft away the moment somebody switched tabs and back — the
 * same reasoning `ThresholdsPanel` and the old `BenchmarkSection` already relied on.
 */
function PortfolioSection(props: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const active = useSubsection(PORTFOLIO_SUBSECTIONS)

  return (
    <>
      <SectionNav
        sections={PORTFOLIO_SUBSECTIONS}
        variant="sub"
        ariaLabel={t('settings:nav.portfolio')}
      />
      <div hidden={active !== 'risk'}>
        <RiskPanel {...props} />
      </div>
      <div hidden={active !== 'property'}>
        <PropertyPanel {...props} />
      </div>
    </>
  )
}

type BudgetSubsectionId = 'household' | 'mapping' | 'thresholds'

const BUDGET_SUBSECTIONS: readonly Section<BudgetSubsectionId>[] = [
  { id: 'household', path: '/settings/budget/household', labelKey: 'settings:budget.nav.household' },
  { id: 'mapping', path: '/settings/budget/mapping', labelKey: 'settings:benchmark.mapping.title' },
  { id: 'thresholds', path: '/settings/budget/thresholds', labelKey: 'settings:nav.thresholds' },
]

/**
 * Budget's own sub-tabs: who lives here and what they're compared against (household +
 * benchmark, stacked on one page since #327's household/comparison split no longer
 * needs a tab strip of its own once it isn't sharing a section with mapping), the COICOP
 * mapping table, and the aggregation thresholds — three former top-level sections (#200)
 * that all decide what a budget page shows.
 *
 * All three stay mounted, hidden rather than unrendered: `HouseholdPanel` and
 * `ThresholdsPanel` both hold a typed-but-unsaved draft in their own `useState`, and
 * unmounting one to show a sibling would throw that draft away the moment somebody
 * switched tabs to check something and switched back.
 */
function BudgetSection(props: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const active = useSubsection(BUDGET_SUBSECTIONS)

  return (
    <>
      <SectionNav
        sections={BUDGET_SUBSECTIONS}
        variant="sub"
        ariaLabel={t('settings:nav.budget')}
      />
      <div hidden={active !== 'household'}>
        <HouseholdPanel {...props} />
        <ComparisonPanel {...props} />
      </div>
      <div hidden={active !== 'mapping'}>
        <MappingPanel {...props} />
      </div>
      <div hidden={active !== 'thresholds'}>
        <ThresholdsPanel {...props} />
      </div>
    </>
  )
}

type AiSubsectionId = 'usage' | 'prompts'

const AI_SUBSECTIONS: readonly Section<AiSubsectionId>[] = [
  { id: 'usage', path: '/settings/ai/usage', labelKey: 'settings:ai.nav.usage' },
  { id: 'prompts', path: '/settings/ai/prompts', labelKey: 'settings:nav.prompts' },
]

/**
 * AI's own sub-tabs: the cost/usage monitoring that used to live on the Status panel
 * (#325) and the prompt editor, grouped together because neither is a setting that
 * changes what the rest of the app computes — both are "what is the assistant doing and
 * on whose instructions", which status/thresholds are not.
 *
 * Both stay mounted, hidden rather than unrendered: `PromptsPanel` holds a
 * typed-but-unsaved draft in its own `useState`, and switching to Usage to check a
 * figure must not throw it away.
 */
function AiSection(props: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const active = useSubsection(AI_SUBSECTIONS)
  const { settings, state, owner, estimate } = props

  return (
    <>
      <SectionNav sections={AI_SUBSECTIONS} variant="sub" ariaLabel={t('settings:nav.ai')} />
      <div hidden={active !== 'usage'}>
        <AiUsage ai={settings.ai} state={state} owner={owner} estimate={estimate} />
      </div>
      <div hidden={active !== 'prompts'}>
        <PromptsPanel {...props} />
      </div>
    </>
  )
}

type SystemSubsectionId = 'status' | 'build'

const SYSTEM_SUBSECTIONS: readonly Section<SystemSubsectionId>[] = [
  { id: 'status', path: '/settings/system/status', labelKey: 'settings:status.title' },
  { id: 'build', path: '/settings/system/build', labelKey: 'settings:system.nav.buildHistory' },
]

/**
 * System's own sub-tabs: the status panel, which reads `/api/status` on its own and is
 * job-control-heavy enough to want a tab of its own, versus the history/build facts that
 * come from the settings payload (see the module doc comment on why the two used to
 * share a section). Neither holds an unsaved draft worth preserving across a tab switch
 * — status's own confirm buttons reset on purpose, the same way they always have — so
 * this one switches by unmounting rather than hiding, matching the section's own
 * previous behaviour before the split.
 */
function SystemSection(props: SettingsPanelProps): ReactNode {
  const { t, language } = useT()
  const active = useSubsection(SYSTEM_SUBSECTIONS)
  const { settings } = props

  return (
    <>
      <SectionNav sections={SYSTEM_SUBSECTIONS} variant="sub" ariaLabel={t('settings:nav.system')} />

      {active === 'status' ? (
        <StatusPanel {...props} />
      ) : (
        <>
          <section className="card panel">
            <h2 className="card__title">{t('settings:history.title')}</h2>
            <dl className="build">
              <dt>{t('settings:history.months')}</dt>
              <dd className="num">
                {t('settings:history.monthsValue', { months: settings.history.months })}
              </dd>
              <dt>{t('settings:history.coverage')}</dt>
              <dd className="num">
                {settings.history.earliest === null || settings.history.latest === null
                  ? t('settings:history.noneYet')
                  : t('settings:history.coverageValue', {
                      earliest: formatMonth(settings.history.earliest, language),
                      latest: formatMonth(settings.history.latest, language),
                    })}
              </dd>
            </dl>
          </section>

          <section className="card panel">
            <h2 className="card__title">{t('settings:build.title')}</h2>
            <dl className="build">
              <dt>{t('settings:build.version')}</dt>
              <dd className="num">{settings.build.version ?? t('empty.unknown')}</dd>
              <dt>{t('settings:build.revision')}</dt>
              <dd className="num">{settings.build.revision ?? t('empty.unknown')}</dd>
            </dl>
          </section>
        </>
      )}
    </>
  )
}

export function Settings(): ReactNode {
  const { t } = useT()
  const state = useSettings()
  const { path } = useRouter()
  const section = sectionFor(path)
  /*
   * The price of one analysis, read once for the two panels that offer to spend it.
   *
   * Here rather than in either of them because both need it and neither owns it, and
   * because two reads would be two requests quoting two numbers. It costs nothing to
   * ask: `estimateAnalysis` counts characters against the pricing table in this
   * process and calls no upstream, so this is a query against what has already been
   * aggregated — which is also why a deployment with nothing aggregated answers 409
   * and both panels say so in their own words.
   */
  const estimate = useResource<AiEstimate>('/api/ai/estimate')

  return (
    <>
      <PageHeader title={t('nav.settings')} lede={t('page.settings.lede')} />
      <SettingsNav />

      <DataState resource={state.resource}>
        {(settings) => {
          const owner = settings.profile.role === 'owner'
          const props = { settings, state, owner, estimate }

          return (
            <>
              {/*
                The failure of a *write*, above the panels rather than inside the one
                that caused it. A rejected field is already reported beside itself by
                `state.issue`; what lands here is what the server did not attribute to
                a field — a rate limit, a lost session, an upstream that went away —
                and none of those belong under a single input.
              */}
              {state.error === null || state.error.issues.length > 0 ? null : (
                <div className="notice notice--error" role="alert">
                  {state.error.message}
                  {state.error.requestId === null ? null : (
                    <p className="notice__meta">{state.error.requestId}</p>
                  )}
                </div>
              )}

              {section === 'account' && <LanguagePanel {...props} />}
              {section === 'accounts' && <AccountsPanel {...props} />}
              {section === 'portfolio' && <PortfolioSection {...props} />}
              {section === 'budget' && <BudgetSection {...props} />}
              {section === 'ai' && <AiSection {...props} />}
              {section === 'system' && <SystemSection {...props} />}
            </>
          )
        }}
      </DataState>
    </>
  )
}
