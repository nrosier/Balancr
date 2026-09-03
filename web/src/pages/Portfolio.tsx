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
import { formatBp, formatDate, formatMoney, type Portfolio as PortfolioPayload } from '../shared.ts'
import { DataState } from '../ui/DataState.tsx'
import { FreshnessNote } from '../ui/Freshness.tsx'
import { HoldingsTable } from '../ui/HoldingsTable.tsx'
import { Metric } from '../ui/Metric.tsx'
import { PageHeader } from './PageHeader.tsx'

/** Whole euro. Cents on a portfolio total are noise, and the row prices carry them. */
const euro = (cents: number): string => formatMoney(cents, { whole: true })

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
        {(data) => <Figures data={data} />}
      </DataState>
    </>
  )
}

function Figures({ data }: { data: PortfolioPayload }): ReactNode {
  const { t } = useT()
  const unknown = t('empty.unknown')
  const { allocation, cashValueCents, date, history, holdings } = data
  const { investedValueCents, totalValueCents, twrBp } = data

  return (
    <>
      <FreshnessNote freshness={data.freshness} />

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
