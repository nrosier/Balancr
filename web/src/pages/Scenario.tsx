/**
 * "What if I put €200 more into investments each month?" — a what-if calculator, not a
 * new tracked concept (#51).
 *
 * The server's only job is the real seed: the household's current monthly investment
 * contribution (`category_meta.nature = 'investments'`, summed the same way
 * `savings-context.ts` already does for #252) and the latest net-worth snapshot's
 * invested value. `projectScenario` itself is pure and re-exported through
 * `shared.ts` — the same "recompute locally" arrangement `periodSavings` and
 * `custodyShare` already have — so every edit below (amount, recurring vs. one-time,
 * growth rate, horizon) recomputes instantly, with no request per keystroke.
 *
 * No `isEmpty` on `DataState`: unlike Forecast, this page is a calculator that always
 * has something to show, even on a fresh install with no synced month and no net-worth
 * snapshot at all — it just starts from the figures typed into the two seed fields
 * instead of real ones, which is what the inline hints below explain.
 *
 * Loan and bond scenarios are explicitly out of scope here — see the domain module's
 * own doc comment for why this is one scenario type, not a framework for many.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useResource } from '../api/resource.tsx'
import { ScenarioChart } from '../charts/ScenarioChart.tsx'
import { useT } from '../i18n.ts'
import {
  DEFAULT_GROWTH_RATE_BP,
  DEFAULT_HORIZON_MONTHS,
  MAX_HORIZON_MONTHS,
  formatMoney,
  parseMoneyToCents,
  projectScenario,
  type Scenario as ScenarioPayload,
} from '../shared.ts'
import { DataState } from '../ui/DataState.tsx'
import { Metric } from '../ui/Metric.tsx'
import { Money } from '../ui/Money.tsx'
import { FreshnessBar } from '../ui/Refresh.tsx'
import { PageHeader } from './PageHeader.tsx'

/** The two jobs the seed values come from: a synced month, and a net-worth snapshot. */
const JOBS = ['sync', 'networth'] as const

const MAX_HORIZON_YEARS = MAX_HORIZON_MONTHS / 12

/**
 * A plain percentage as typed, or null. Comma or dot — a Belgian keyboard produces one
 * and a numeric keypad the other — same reasoning as `Thresholds.tsx`'s `parseNumber`,
 * but simpler: this field is never rendered with a thousands grouping, so there is no
 * `2.000`-reads-as-two-things ambiguity to guard against here.
 */
function parsePercentToBp(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^-?\d+(?:[.,]\d{1,4})?$/.test(trimmed)) return null
  const value = Number(trimmed.replace(',', '.'))
  return Number.isFinite(value) ? Math.round(value * 100) : null
}

/** Whole years only, clamped to what `projectScenario` will actually run. */
function parseYearsToMonths(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const years = Number(trimmed)
  return years < 1 ? null : Math.min(years, MAX_HORIZON_YEARS) * 12
}

export function Scenario(): ReactNode {
  const { t } = useT()
  const resource = useResource<ScenarioPayload>('/api/scenario')

  return (
    <>
      <PageHeader title={t('nav.scenario')} lede={t('page.scenario.lede')} />
      <DataState resource={resource}>{(data) => <Figures data={data} onRefreshed={resource.reload} />}</DataState>
    </>
  )
}

function Figures({ data, onRefreshed }: { data: ScenarioPayload; onRefreshed: () => void }): ReactNode {
  const { t } = useT()
  const seed = data.scenario

  // Never a guess: a hypothetical change defaults to zero, not to whatever the
  // household happens to be doing already.
  const [changeText, setChangeText] = useState('0')
  const [recurring, setRecurring] = useState(true)
  const [growthText, setGrowthText] = useState(String(DEFAULT_GROWTH_RATE_BP / 100))
  const [horizonText, setHorizonText] = useState(String(DEFAULT_HORIZON_MONTHS / 12))
  const [baselineText, setBaselineText] = useState(
    seed.baselineCents === null ? '0' : formatMoney(seed.baselineCents),
  )
  const [startingText, setStartingText] = useState(
    seed.startingValueCents === null ? '0' : formatMoney(seed.startingValueCents),
  )

  // Unparseable text falls back to the last good default rather than blocking the
  // chart — this is a calculator a reader is actively typing into, not a settings
  // form with a save button, so there is nothing to gate on validity.
  const changeCents = parseMoneyToCents(changeText) ?? 0
  const growthRateBp = parsePercentToBp(growthText) ?? DEFAULT_GROWTH_RATE_BP
  const horizonMonths = parseYearsToMonths(horizonText) ?? DEFAULT_HORIZON_MONTHS
  const baselineCents = parseMoneyToCents(baselineText) ?? 0
  const startingValueCents = parseMoneyToCents(startingText) ?? 0

  const months = useMemo(
    () => projectScenario({ startingValueCents, baselineCents, changeCents, recurring, growthRateBp, horizonMonths }),
    [startingValueCents, baselineCents, changeCents, recurring, growthRateBp, horizonMonths],
  )
  const last = months.at(-1)
  const years = Math.round(horizonMonths / 12)

  return (
    <>
      <FreshnessBar freshness={data.freshness} jobs={JOBS} onRefreshed={onRefreshed} />

      {seed.baselineCents === null || seed.startingValueCents === null ? (
        <div className="notice notice--info">
          {seed.baselineCents === null ? <p>{t('scenario:hint.noBaseline')}</p> : null}
          {seed.startingValueCents === null ? <p>{t('scenario:hint.noStartingValue')}</p> : null}
        </div>
      ) : null}

      <div className="grid-cards">
        <Metric label={t('scenario:metric.contribution')} value={<Money cents={baselineCents} />} unknown={t('empty.unknown')} />
        <Metric
          label={t('scenario:metric.asIs')}
          value={last === undefined ? null : <Money cents={last.baselineValueCents} options={{ whole: true }} />}
          unknown={t('empty.unknown')}
          note={t('time.yearCount', { count: years })}
        />
        <Metric
          label={t('scenario:metric.withChange')}
          value={last === undefined ? null : <Money cents={last.scenarioValueCents} options={{ whole: true }} />}
          unknown={t('empty.unknown')}
          note={t('time.yearCount', { count: years })}
        />
        <Metric
          label={t('scenario:metric.delta')}
          value={last === undefined ? null : <Money cents={last.deltaCents} options={{ whole: true, signed: true }} />}
          unknown={t('empty.unknown')}
          {...(last === undefined ? {} : { tone: last.deltaCents < 0 ? ('negative' as const) : ('positive' as const) })}
        />
      </div>

      <section className="card">
        <h2 className="card__title">{t('scenario:chart.title')}</h2>
        <ScenarioChart
          months={months}
          baselineName={t('scenario:chart.baseline')}
          scenarioName={t('scenario:chart.withChange')}
          deltaLabel={t('scenario:chart.delta')}
          summary={
            last === undefined
              ? t('empty.noData')
              : t('scenario:chart.summary', {
                  start: formatMoney(startingValueCents, { whole: true }),
                  baselineEnd: formatMoney(last.baselineValueCents, { whole: true }),
                  scenarioEnd: formatMoney(last.scenarioValueCents, { whole: true }),
                  years,
                  delta: formatMoney(last.deltaCents, { whole: true, signed: true }),
                })
          }
        />
      </section>

      <section className="card">
        <h2 className="card__title">{t('scenario:input.title')}</h2>
        <div className="stack">
          <div className="field">
            <label className="field__label" htmlFor="scenario-change">
              {t('scenario:input.change')}
            </label>
            <input
              id="scenario-change"
              className="field__input num"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={changeText}
              onChange={(event) => setChangeText(event.target.value)}
            />
          </div>

          <div className="field field--inline">
            <label className="field__label" htmlFor="scenario-recurring">
              {t('scenario:input.recurringLabel')}
            </label>
            <select
              id="scenario-recurring"
              className="field__input"
              value={recurring ? 'recurring' : 'lumpSum'}
              onChange={(event) => setRecurring(event.target.value === 'recurring')}
            >
              <option value="recurring">{t('scenario:input.recurringOption.recurring')}</option>
              <option value="lumpSum">{t('scenario:input.recurringOption.lumpSum')}</option>
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="scenario-growth">
              {t('scenario:input.growthRate')}
            </label>
            <input
              id="scenario-growth"
              className="field__input num"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={growthText}
              onChange={(event) => setGrowthText(event.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="scenario-horizon">
              {t('scenario:input.horizon')}
            </label>
            <input
              id="scenario-horizon"
              className="field__input num"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={horizonText}
              onChange={(event) => setHorizonText(event.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="scenario-baseline">
              {t('scenario:input.baseline')}
            </label>
            <input
              id="scenario-baseline"
              className="field__input num"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={baselineText}
              onChange={(event) => setBaselineText(event.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="scenario-starting">
              {t('scenario:input.startingValue')}
            </label>
            <input
              id="scenario-starting"
              className="field__input num"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={startingText}
              onChange={(event) => setStartingText(event.target.value)}
            />
          </div>
        </div>
      </section>
    </>
  )
}
