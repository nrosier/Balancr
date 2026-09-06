/**
 * The checking balance, twelve months out — #49.
 *
 * A floor, not a prediction: recurring income and fixed costs at their usual monthly
 * rate, plus a known annual or quarterly bill placed in the month it actually lands
 * rather than smeared evenly across all twelve. Variable and discretionary spending
 * are left out on purpose — see `domain/aggregate/forecast.ts` for why — so this line
 * reads lower than "everything that might happen" and is meant to.
 *
 * Its own top-level page rather than a section on Overview or Insights: Overview's own
 * doc comment promises exactly one endpoint, and this is deterministic arithmetic, not
 * the AI-flavored analysis Insights holds. `GET /api/forecast` is the only endpoint
 * read here, same "reads Balancr's own SQLite, nothing live" rule as every other page.
 *
 * The chart reuses `NetWorthChart` unchanged — a balance trajectory is the same shape
 * whether it is history or a projection, and a negative month renders exactly like any
 * other value with no special-casing needed. The table below it is the "what's due"
 * breakdown: only the non-monthly bills that land in a given month get a row, because
 * a monthly-cadence category recurs every month and is not a notable event in any one
 * of them — it is already folded into the chart.
 */
import { useId, type ReactNode } from 'react'
import { useResource } from '../api/resource.tsx'
import { NetWorthChart } from '../charts/NetWorthChart.tsx'
import { useT } from '../i18n.ts'
import { formatMonth, type Forecast as ForecastPayload } from '../shared.ts'
import { DataState } from '../ui/DataState.tsx'
import { Metric } from '../ui/Metric.tsx'
import { Money } from '../ui/Money.tsx'
import { FreshnessBar } from '../ui/Refresh.tsx'
import { PageHeader } from './PageHeader.tsx'

/** The two jobs this projection is built from: a synced month, and a net-worth snapshot. */
const JOBS = ['sync', 'networth'] as const

function isEmpty(data: ForecastPayload): boolean {
  return data.forecast === null
}

export function Forecast(): ReactNode {
  const { t } = useT()
  const resource = useResource<ForecastPayload>('/api/forecast')

  return (
    <>
      <PageHeader title={t('nav.forecast')} lede={t('page.forecast.lede')} />
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
  data: ForecastPayload
  onRefreshed: () => void
}): ReactNode {
  const { t, language } = useT()
  const forecast = data.forecast
  if (forecast === null) return null

  const history = forecast.months.map((month) => ({
    date: `${month.month}-01`,
    totalCents: month.balanceCents,
  }))
  const bills = forecast.months.flatMap((month) =>
    month.bills.map((bill) => ({ month: month.month, ...bill })),
  )
  const last = forecast.months.at(-1)

  return (
    <>
      <FreshnessBar freshness={data.freshness} jobs={JOBS} onRefreshed={onRefreshed} />

      <div className="grid-cards">
        <Metric
          label={t('forecast:metric.horizon')}
          value={last === undefined ? null : <Money cents={last.balanceCents} options={{ whole: true }} />}
          unknown={t('empty.unknown')}
          note={t('time.lastUpdated', { when: formatMonth(forecast.startDate.slice(0, 7), language) })}
        />
      </div>

      <section className="card">
        <h2 className="card__title">{t('forecast:chart.title')}</h2>
        <NetWorthChart
          history={history}
          name={t('forecast:chart.balance')}
          summaryKey="forecast:chart.summary"
        />
      </section>

      <section className="card">
        <h2 className="card__title">{t('forecast:bills.title')}</h2>
        {bills.length === 0 ? (
          <p className="muted">{t('forecast:bills.none')}</p>
        ) : (
          <BillsTable bills={bills} />
        )}
      </section>
    </>
  )
}

interface BillRow {
  month: string
  categoryId: string
  name: string
  amountCents: number
}

/**
 * One row per non-monthly bill occurrence, following `HoldingsTable.tsx`'s pattern:
 * real `<table>` markup, a `scope="col"` header row, a row header on the identity
 * column, and the same `tabIndex={0}` scroll region for a phone screen that cannot
 * reflow three columns of figures.
 */
function BillsTable({ bills }: { bills: readonly BillRow[] }): ReactNode {
  const { t, language } = useT()
  const captionId = useId()

  return (
    <div className="table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
      <table className="table">
        <caption className="table__caption" id={captionId}>
          {t('forecast:bills.caption', { count: bills.length })}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t('forecast:bills.column.month')}</th>
            <th scope="col">{t('forecast:bills.column.category')}</th>
            <th scope="col" className="table__cell--number">
              {t('forecast:bills.column.amount')}
            </th>
          </tr>
        </thead>
        <tbody>
          {bills.map((bill) => (
            <tr key={`${bill.month}:${bill.categoryId}`}>
              <th scope="row">{formatMonth(bill.month, language)}</th>
              <td>{bill.name}</td>
              <td className="table__cell--number">
                <Money cents={bill.amountCents} options={{ whole: true }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
