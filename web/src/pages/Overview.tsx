/**
 * The page that answers "how am I doing" in five seconds.
 *
 * Four figures, in the order someone actually asks for them: what am I worth, how
 * much of what came in stayed, how long could I go without income, and can I believe
 * any of it. The last one is not a footnote — `hygiene.ts` exists because an analysis
 * of a budget with forty uncategorised transactions in it is confident and wrong, and
 * the score belongs beside the figures it qualifies rather than on a settings screen.
 *
 * Everything below reads one endpoint, `GET /api/overview`, which reads Balancr's own
 * SQLite and nothing else. No page in this application calls Actual, Ghostfolio or
 * Gemini, which is what makes it load instantly and what makes `freshness` mandatory
 * rather than decorative.
 *
 * **Almost nothing here is computed.** Net worth is summed in SQL and the emergency fund
 * arrives as hundredths of a month, because `overview.ts` divides a liquid balance by a
 * twelve-month mean spend and refuses to hand a float across the wire; the one division
 * below turns those hundredths back into months for printing. The exception is the
 * savings card, which since #296 sums a slice of `flows` and divides once — the same
 * component the Budget page uses, for the same reason the arithmetic is not on the
 * server: the period is a reading the reader picks after the payload has arrived. A
 * figure no job has produced is `null` and prints as "not known yet" — never as zero,
 * which is a number someone would act on.
 *
 * Labels come from three namespaces, addressed as `ns:key`. Net worth and the buffer
 * are portfolio vocabulary; the savings rate and the quality score are budget
 * vocabulary; and #30 and #31 will name the same things the same way because there is
 * one catalogue entry each.
 */
import type { ReactNode } from 'react'
import { useResource } from '../api/resource.tsx'
import { SavingsRate } from '../budget/SavingsRate.tsx'
import { NetWorthChart } from '../charts/NetWorthChart.tsx'
import { useT } from '../i18n.ts'
import { formatDate, type Overview as OverviewPayload } from '../shared.ts'
import { DataState } from '../ui/DataState.tsx'
import { HygieneCard } from '../ui/Hygiene.tsx'
import { Metric, type MetricRow } from '../ui/Metric.tsx'
import { Money } from '../ui/Money.tsx'
import { FreshnessBar } from '../ui/Refresh.tsx'
import { PageHeader } from './PageHeader.tsx'

/**
 * True when the jobs have produced nothing at all.
 *
 * Not "some field is null": a deployment that has synced a budget but has no
 * portfolio yet has a real month and real totals, and telling that reader to run a
 * sync would be wrong. This is the state where there is genuinely nothing to draw.
 */
function isEmpty(data: OverviewPayload): boolean {
  return (
    data.netWorth === null &&
    data.totals === null &&
    data.hygiene === null &&
    data.history.length === 0
  )
}

export function Overview(): ReactNode {
  const { t } = useT()
  const resource = useResource<OverviewPayload>('/api/overview')

  return (
    <>
      <PageHeader title={t('nav.overview')} lede={t('page.overview.lede')} />
      <DataState resource={resource} isEmpty={isEmpty}>
        {/*
          `reload` is threaded down rather than read from a context: this page's figures
          come from four different jobs, so the refresh control here asks for all of them
          — which is the request `/api/refresh` answers when it is given no list at all.
        */}
        {(data) => <Figures data={data} onRefreshed={resource.reload} />}
      </DataState>
    </>
  )
}

/** Whole euro. Cents on a net-worth figure are noise nobody reads. */
const euro = (cents: number): ReactNode => <Money cents={cents} options={{ whole: true }} />

function Figures({
  data,
  onRefreshed,
}: {
  data: OverviewPayload
  onRefreshed: () => void
}): ReactNode {
  const { t } = useT()
  const unknown = t('empty.unknown')

  const { flows, history, hygiene, month, netWorth } = data
  const cover = data.emergencyFundCentimonths

  const netWorthRows: MetricRow[] =
    netWorth === null
      ? []
      : [
          { label: t('portfolio:metric.liquid'), value: euro(netWorth.liquidCents) },
          { label: t('portfolio:metric.invested'), value: euro(netWorth.investedCents) },
          // Debt is stored as the negative it is, so it needs no sign of its own. It is
          // coloured because a debt row that looks like an asset row gets read as one.
          {
            label: t('portfolio:metric.debt'),
            value: euro(netWorth.debtCents),
            ...(netWorth.debtCents === 0 ? {} : { tone: 'negative' as const }),
          },
          ...(netWorth.propertyValueCents === null
            ? []
            : [{ label: t('portfolio:metric.propertyValue'), value: euro(netWorth.propertyValueCents) }]),
          ...(netWorth.mortgageBalanceCents === null
            ? []
            : [
                {
                  label: t('portfolio:metric.mortgageBalance'),
                  value: euro(netWorth.mortgageBalanceCents),
                  ...(netWorth.mortgageBalanceCents === 0 ? {} : { tone: 'negative' as const }),
                },
              ]),
        ]

  return (
    <>
      <FreshnessBar freshness={data.freshness} onRefreshed={onRefreshed} />

      <div className="grid-cards">
        <Metric
          label={t('portfolio:metric.netWorth')}
          value={netWorth === null ? null : euro(netWorth.totalCents)}
          unknown={unknown}
          {...(netWorth === null
            ? {}
            : { note: t('time.lastUpdated', { when: formatDate(netWorth.date) }) })}
          rows={netWorthRows}
        />

        {/*
          The same card the Budget page shows, with the same four windows — one component,
          because #296 was filed about these two drifting apart. It needs a month to anchor
          on and this page has no picker, so `month` is the newest stored one; with no month
          at all there are no flows either and nothing to draw.

          `showFlows`: yes here, no on the Budget page. Nothing else on this page carries a
          flow figure, so without the summed pair the percentage is unauditable — and these
          rows used to come from `totals` and covered one month, which is exactly the
          mismatch a period would have turned into a wrong reading.
        */}
        {month === null ? (
          <Metric label={t('budget:metric.savingsRate')} value={null} unknown={unknown} />
        ) : (
          <SavingsRate history={flows} month={month} showFlows />
        )}

        <Metric
          label={t('portfolio:metric.emergencyFund')}
          // Hundredths back to months, formatted by the plural rule so "1 month" and
          // "4,5 months" both come out right in both languages.
          value={cover === null ? null : t('time.monthCount', { count: cover / 100 })}
          unknown={unknown}
          note={t('portfolio:metric.emergencyFundHint')}
        />
      </div>

      <section className="card">
        <h2 className="card__title">{t('portfolio:chart.netWorthTitle')}</h2>
        {history.length === 0 ? (
          <p className="muted">{t('empty.noData')}</p>
        ) : (
          <NetWorthChart history={history} />
        )}
      </section>

      {hygiene === null ? null : <HygieneCard hygiene={hygiene} />}
    </>
  )
}
