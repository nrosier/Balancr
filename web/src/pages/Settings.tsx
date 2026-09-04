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
 * **Sections (#200).** What used to be one long scroll of nine panels is now one
 * section at a time, chosen by `../settings/sections.ts`'s `sectionFor` from the real
 * URL (`routes.ts` marks `/settings` `nested`, so every `/settings/*` path still lands
 * on this component) and rendered under `SettingsNav`'s tab strip. `useSettings()` is
 * still called exactly once here regardless of section — the payload behind every
 * panel is one request, not one per tab.
 *
 * The status panel is the exception to the payload rule and says so in its own header:
 * it reads `/api/status`, not the settings payload, because readiness decays while the
 * page is open and because it has to be able to be the thing that failed while the
 * rest of the page loaded. The build block below it stays separate for the same reason
 * in reverse — the version and revision come from the settings payload, so they are
 * still on screen when `/api/status` is what is broken, which is when a bug report
 * needs them most. Both live on General together with the language control and the
 * data window, which is the section for "how this instance is doing" rather than any
 * one setting.
 *
 * The risk profile has its own section ahead of thresholds in the tab order for the
 * reason it used to sit above them on the single page: it is the only section whose
 * numbers produce a suggestion to move money, and somebody arriving because the
 * portfolio page proposed a trade is looking for these twelve boxes rather than for
 * the EWMA half-life.
 *
 * The household and the COICOP mapping share a Benchmark section because both are the
 * same kind of work — saying which of Balancr's own vocabularies an external thing
 * belongs to — and because the household is meaningless without the mapping: an
 * equivalence scale divides a reference that nothing is compared against until at
 * least most of the month has a division (#43).
 */
import type { ReactNode } from 'react'
import { useResource } from '../api/resource.tsx'
import { useT } from '../i18n.ts'
import { useRouter } from '../router.tsx'
import { AccountsPanel } from '../settings/Accounts.tsx'
import { HouseholdPanel, MappingPanel } from '../settings/Benchmark.tsx'
import { LanguagePanel } from '../settings/Language.tsx'
import { PromptsPanel } from '../settings/Prompts.tsx'
import { RiskPanel } from '../settings/Risk.tsx'
import { sectionFor } from '../settings/sections.ts'
import { SettingsNav } from '../settings/SettingsNav.tsx'
import { SpendPanel } from '../settings/Spend.tsx'
import { StatusPanel } from '../settings/Status.tsx'
import { ThresholdsPanel } from '../settings/Thresholds.tsx'
import { UpcomingPanel } from '../settings/Upcoming.tsx'
import { useSettings } from '../settings/state.ts'
import { formatMonth, type AiEstimate } from '../shared.ts'
import { DataState } from '../ui/DataState.tsx'
import { PageHeader } from './PageHeader.tsx'
import '../settings/settings.css'

export function Settings(): ReactNode {
  const { t, language } = useT()
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

              {section === 'general' && (
                <>
                  <LanguagePanel {...props} />

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

                  <StatusPanel />
                </>
              )}

              {section === 'prompts' && <PromptsPanel {...props} />}
              {section === 'risk' && <RiskPanel {...props} />}
              {section === 'thresholds' && <ThresholdsPanel {...props} />}
              {section === 'accounts' && <AccountsPanel {...props} />}

              {section === 'benchmark' && (
                <>
                  <HouseholdPanel {...props} />
                  <MappingPanel {...props} />
                </>
              )}

              {section === 'spend' && (
                <>
                  <SpendPanel {...props} />
                  <UpcomingPanel {...props} />
                </>
              )}
            </>
          )
        }}
      </DataState>
    </>
  )
}
