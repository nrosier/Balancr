/**
 * What the investments are worth, what they are made of, and what is in them.
 *
 * Three questions in the order they get asked, which is also narrowest-last: a
 * figure, then the shape of it, then the rows behind the shape. The value series
 * comes before the treemap because "is it up" is answered before "of what".
 *
 * **Every number here arrives computed.** The total, the return, each slice's share
 * and each row's price all come from `GET /api/portfolio` as integers or as the
 * provider's own decimal text. The one figure this page derives is a holding's
 * weight, and only because a per-row share is not worth a column in the payload —
 * it divides two integers the server sent and prints basis points, which is the
 * same arithmetic the server would have done.
 *
 * **`terAnnualCents` is deliberately absent.** The metric exists in the schema and
 * is permanently null in v1: what a fund costs you per year needs a TER per
 * instrument, and neither Ghostfolio nor Actual holds one. A card that always reads
 * "not known yet" teaches the reader that the placeholder means nothing, so the
 * card is not drawn at all — see `portfolio:metric.ter`, which stays in the
 * catalogue for the version that can fill it.
 */
import type { ReactNode } from 'react'
import { useResource } from '../api/resource.tsx'
import { AllocationChart } from '../charts/AllocationChart.tsx'
import { NetWorthChart } from '../charts/NetWorthChart.tsx'
import { useT } from '../i18n.ts'
import { DriftTable } from '../portfolio/Drift.tsx'
import { PropertyTable } from '../portfolio/Property.tsx'
import { Suggestions } from '../portfolio/Suggestions.tsx'
import { formatBp, formatDate, type Portfolio as PortfolioPayload } from '../shared.ts'
import { DataState } from '../ui/DataState.tsx'
import { HoldingsTable } from '../ui/HoldingsTable.tsx'
import { Metric } from '../ui/Metric.tsx'
import { Money } from '../ui/Money.tsx'
import { FreshnessBar } from '../ui/Refresh.tsx'
import { PageHeader } from './PageHeader.tsx'
import '../portfolio/advice.css'

/** Whole euro. Cents on a portfolio total are noise, and the row prices carry them. */
const euro = (cents: number): ReactNode => <Money cents={cents} options={{ whole: true }} />

/**
 * The one job behind every figure on this page.
 *
 * A refresh here pulls Ghostfolio and nothing else — waiting through a budget download
 * for a price that moved would make the control feel broken. The server adds `networth`
 * and `signals` on its own, because both are computed from what this job writes, and
 * the bar names them when it does. A module constant so the array's identity is stable
 * across renders.
 */
const JOBS = ['portfolio'] as const

/**
 * True when no snapshot has ever been written.
 *
 * All four at once, not the total alone: a portfolio can legitimately be worth
 * nothing on paper while still having holdings and a history, and telling that
 * reader to configure Ghostfolio would be wrong.
 */
function isEmpty(data: PortfolioPayload): boolean {
  return (
    data.date === null &&
    data.holdings.length === 0 &&
    data.allocation.length === 0 &&
    data.history.length === 0
  )
}

export function Portfolio(): ReactNode {
  const { t } = useT()
  const resource = useResource<PortfolioPayload>('/api/portfolio')

  return (
    <>
      <PageHeader title={t('nav.portfolio')} lede={t('page.portfolio.lede')} />
      <DataState resource={resource} isEmpty={isEmpty}>
        {(data) => <Figures data={data} onRefreshed={resource.reload} />}
      </DataState>
    </>
  )
}

function Figures({
  data,
  onRefreshed,
}: {
  data: PortfolioPayload
  onRefreshed: () => void
}): ReactNode {
  const { t } = useT()
  const unknown = t('empty.unknown')
  const { advice, allocation, cashValueCents, date, history, holdings, properties } = data
  const { investedValueCents, totalValueCents, twrBp } = data

  return (
    <>
      <FreshnessBar freshness={data.freshness} jobs={JOBS} onRefreshed={onRefreshed} />

      <div className="grid-cards">
        <Metric
          label={t('portfolio:metric.value')}
          value={totalValueCents === null ? null : euro(totalValueCents)}
          unknown={unknown}
          {...(date === null ? {} : { note: t('time.lastUpdated', { when: formatDate(date) }) })}
        />

        <Metric
          label={t('portfolio:metric.invested')}
          value={investedValueCents === null ? null : euro(investedValueCents)}
          unknown={unknown}
          note={t('portfolio:metric.investedHint')}
        />

        <Metric
          label={t('portfolio:metric.cash')}
          value={cashValueCents === null ? null : euro(cashValueCents)}
          unknown={unknown}
          // No tone. Cash at a broker is neither good nor bad without knowing why it
          // is there, and a colour would be this page taking a position it cannot
          // support — most of it here is a bank balance a syncing tool wrote in.
          note={t('portfolio:metric.cashHint')}
        />

        <Metric
          label={t('portfolio:metric.twr')}
          value={twrBp === null ? null : formatBp(twrBp)}
          unknown={unknown}
          // The sign decides the colour, and zero is neither: a portfolio exactly
          // flat is not good news to be painted green.
          {...(twrBp === null || twrBp === 0
            ? {}
            : { tone: twrBp < 0 ? ('negative' as const) : ('positive' as const) })}
          note={t('portfolio:metric.twrHint')}
        />
      </div>

      <section className="card">
        <h2 className="card__title">{t('portfolio:chart.valueTitle')}</h2>
        {history.length === 0 ? (
          <p className="muted">{t('empty.noData')}</p>
        ) : (
          // The same chart the overview draws, relabelled: this series is the
          // invested value rather than everything, and the axis rules are the part
          // worth sharing rather than copying.
          <NetWorthChart
            history={history}
            name={t('portfolio:metric.value')}
            summaryKey="portfolio:chart.valueSummary"
          />
        )}
      </section>

      <section className="card">
        <h2 className="card__title">{t('portfolio:chart.allocationTitle')}</h2>
        {/*
          These slices add up to the invested figure above, not to the total: cash
          held at the broker is not an asset class and would otherwise appear as one.
          The two cards make the difference readable, which is why they are drawn
          even when the split is unknown.
        */}
        {allocation.length === 0 ? (
          <p className="muted">{t('empty.noData')}</p>
        ) : (
          <AllocationChart allocation={allocation} />
        )}
      </section>

      {/*
        Outside `allocation`/`advice` on purpose (#227) — a paid-down room in an actual
        house is not a position the drift table can buy or sell to correct, so it gets
        its own card rather than a synthetic slice. No fallback branch: a household
        that tracks no property is not shown an empty table.
      */}
      {properties.length === 0 ? null : (
        <section className="card">
          <h2 className="card__title">{t('portfolio:property.title')}</h2>
          <PropertyTable properties={properties} />
        </section>
      )}

      {/*
        Advice comes after the shape and before the rows, because it is an argument about
        the shape: the treemap says 100% equities and this section says what the profile
        wanted instead. It is null exactly when there is no invested value to measure —
        an instance nobody has synced yet, where four suggestions to buy would be the
        app's first act — and then the section says so rather than disappearing, since a
        missing section is indistinguishable from a feature nobody built.
      */}
      <section className="card">
        <h2 className="card__title">{t('portfolio:advice.title')}</h2>
        {advice === null ? (
          <p className="muted">{t('portfolio:advice.unavailable')}</p>
        ) : (
          <DriftTable advice={advice} />
        )}
      </section>

      {advice === null ? null : (
        <section className="card">
          <h2 className="card__title">{t('portfolio:suggest.title')}</h2>
          <p className="panel__hint muted">{t('portfolio:suggest.lede')}</p>
          <Suggestions advice={advice} />
        </section>
      )}

      <section className="card">
        <h2 className="card__title">{t('portfolio:holding.title')}</h2>
        {holdings.length === 0 ? (
          <p className="muted">{t('empty.noData')}</p>
        ) : (
          <HoldingsTable holdings={holdings} totalValueCents={totalValueCents} />
        )}
      </section>
    </>
  )
}
