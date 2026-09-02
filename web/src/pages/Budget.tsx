/**
 * The month, in the order someone asks about it.
 *
 * Four figures, then where the money went, then whether each envelope held, then
 * whether this month is on pace, then twelve months of shape per envelope. Each answer
 * is narrower than the one before it, which is also why the charts are in that order:
 * nobody wants a wall of sparklines before they know whether the month balanced.
 *
 * **The month is a query parameter, not a route.** `?month=` on the endpoint and
 * `useState` here, rather than `/budget/2026-08`, because `useResource` refetches on a
 * path change and that is the entire mechanism. What the picker offers is `months` —
 * every month a job has written, newest first — and never a window derived from the one
 * on screen: a trailing window would take August out of the list the moment July was
 * picked. A month with nothing computed answers with nulls rather than a 404, so a stale
 * bookmark lands on a sentence and a way out instead of a red box.
 *
 * **Nothing on this page is computed.** Totals, norms, deltas, the twelve-month series,
 * the projection and how far through the month the server thought it was all arrive as
 * integers. The page divides nothing, sums nothing and projects nothing — the one
 * exception is the width of a bar in `PaceBar`, which prints no number. The sentences
 * beside the figures come from `ai/signals.ts`, out of the same catalogue the server's
 * digest uses, so a finding reads the same in an email and on this screen.
 *
 * Categories are ordered by what makes each chart legible rather than by one global
 * rank: the bullet chart by the extent of its own row — an envelope with € 400 assigned
 * and nothing spent is exactly what "budget versus actual" is asking about — and the
 * trend wall by what was actually spent, since a flat line at zero has no shape to read.
 */
import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { useResource } from '../api/resource.tsx'
import { renderSignals, signalsFor, type RenderedSignal } from '../ai/signals.ts'
import { BudgetBullet, type BulletCategory } from '../charts/BudgetBullet.tsx'
import { CategoryTrend } from '../charts/CategoryTrend.tsx'
import { SpendSankey } from '../charts/SpendSankey.tsx'
import { useT, type TFunction } from '../i18n.ts'
import { formatBp, formatMonth, formatMoney, type Budget as BudgetPayload } from '../shared.ts'
import { DataState } from '../ui/DataState.tsx'
import { FreshnessNote } from '../ui/Freshness.tsx'
import { Metric, type MetricRow } from '../ui/Metric.tsx'
import { PaceBar } from '../ui/PaceBar.tsx'
import { PageHeader } from './Placeholder.tsx'

type CategoryFact = BudgetPayload['categories'][number]

/** How many envelopes the bullet chart draws. More than a dozen rows stops being read. */
const BULLET_LIMIT = 12
/** How many sparklines the wall shows before "show more". Two rows on a wide screen. */
const TREND_VISIBLE = 8

/** Whole euro. Cents on a monthly total are noise. */
const euro = (cents: number): string => formatMoney(cents, { whole: true })

/**
 * True when no job has ever written a month.
 *
 * Not "this month is empty": a month that was asked for and never computed still has a
 * picker full of months that were, and telling that reader to run a sync would be
 * wrong. `Figures` handles that case with a sentence of its own.
 */
function isEmpty(data: BudgetPayload): boolean {
  return data.months.length === 0 && data.totals === null && data.categories.length === 0
}

export function Budget(): ReactNode {
  const { t } = useT()
  const [month, setMonth] = useState<string | null>(null)
  // No month yet means "whatever the server considers latest", which is what the
  // endpoint defaults to. Naming a month here would guess at what has been aggregated.
  const resource = useResource<BudgetPayload>(
    month === null ? '/api/budget' : `/api/budget?month=${month}`,
  )

  return (
    <>
      <PageHeader title={t('nav.budget')} lede={t('page.budget.lede')} />
      <DataState resource={resource} isEmpty={isEmpty}>
        {(data) => <Figures data={data} onSelect={setMonth} />}
      </DataState>
    </>
  )
}

interface FiguresProps {
  data: BudgetPayload
  onSelect: (month: string) => void
}

function Figures({ data, onSelect }: FiguresProps): ReactNode {
  const { t, language } = useT()
  const { categories, month, months, signals, totals, trendMonths, uncategorised } = data

  const rendered = useMemo(() => renderSignals(signals, t), [signals, t])
  const spending = useMemo(() => categories.filter((category) => !category.isIncome), [categories])

  const bullet = useMemo<BulletCategory[]>(
    () =>
      spending
        .filter((category) => category.spentCents !== 0 || category.budgetedCents !== 0)
        // By the extent of the row, so a large envelope nothing has been spent from
        // still appears — that it is untouched is the answer, not a reason to hide it.
        .sort((a, b) => extent(b) - extent(a))
        .slice(0, BULLET_LIMIT)
        .map((category) => ({
          name: category.categoryName,
          spentCents: category.spentCents,
          assignedCents: category.budgetedCents,
          baselineCents: category.baselineCents,
        })),
    [spending],
  )

  const trend = useMemo(
    () =>
      spending
        .filter((category) => category.trendCents.some((cents) => cents !== 0))
        .sort((a, b) => b.spentCents - a.spentCents),
    [spending],
  )

  return (
    <>
      <FreshnessNote freshness={data.freshness} />

      <div className="toolbar">
        <MonthPicker month={month} months={months} onSelect={onSelect} />
      </div>

      {uncategorised === null || uncategorised.txnCount === 0 ? null : (
        <div className="notice notice--warn" role="status">
          <p className="notice__lead">
            {t('budget:uncategorised.notice', {
              count: uncategorised.txnCount,
              amount: euro(uncategorised.amountCents),
            })}
          </p>
        </div>
      )}

      {totals === null ? (
        <div className="notice notice--info" role="status">
          <p className="notice__lead">
            {t('budget:empty.month', { month: formatMonth(month, language) })}
          </p>
          <p className="notice__hint">{t('budget:empty.monthHint')}</p>
        </div>
      ) : (
        <Totals totals={totals} />
      )}

      {categories.length === 0 ? null : (
        <>
          <section className="card">
            <h2 className="card__title">{t('budget:chart.sankeyTitle')}</h2>
            <SpendSankey
              categories={categories.map((category) => ({
                name: category.categoryName,
                isIncome: category.isIncome,
                spentCents: category.spentCents,
              }))}
              height="20rem"
            />
          </section>

          <section className="card">
            <h2 className="card__title">{t('budget:chart.bulletTitle')}</h2>
            {bullet.length === 0 ? (
              <p className="muted">{t('budget:empty.categories')}</p>
            ) : (
              <BudgetBullet categories={bullet} />
            )}
          </section>

          <Pace signals={rendered} t={t} />
          <TrendWall categories={trend} months={trendMonths} signals={rendered} />
        </>
      )}
    </>
  )
}

/** How much room a bullet row needs: whichever of assigned and spent reaches further. */
const extent = (category: CategoryFact): number =>
  Math.max(category.spentCents, category.budgetedCents)

interface MonthPickerProps {
  month: string
  months: readonly string[]
  onSelect: (month: string) => void
}

/**
 * The month being viewed, and every month there is one.
 *
 * The month on screen is prepended when the server did not list it, which happens for
 * exactly one reason: it was asked for and never computed. Without that the select
 * would show a different month's name above that month's empty state.
 */
function MonthPicker({ month, months, onSelect }: MonthPickerProps): ReactNode {
  const { t, language } = useT()
  const options = months.includes(month) ? months : [month, ...months]

  if (options.length < 2) return null

  return (
    <div className="field field--inline">
      <label className="field__label" htmlFor="budget-month">
        {t('budget:picker.month')}
      </label>
      <select
        id="budget-month"
        className="field__input"
        value={month}
        onChange={(event) => onSelect(event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {formatMonth(option, language)}
          </option>
        ))}
      </select>
    </div>
  )
}

function Totals({ totals }: { totals: NonNullable<BudgetPayload['totals']> }): ReactNode {
  const { t } = useT()
  const unknown = t('empty.unknown')
  const { savingsRateBp } = totals

  const spentRows: MetricRow[] = [
    { label: t('budget:metric.assigned'), value: euro(totals.budgetedCents) },
    { label: t('budget:metric.available'), value: euro(totals.balanceCents) },
  ]

  return (
    <div className="grid-cards">
      <Metric
        label={t('budget:metric.spent')}
        value={euro(totals.spentCents)}
        unknown={unknown}
        rows={spentRows}
      />
      <Metric
        label={t('budget:metric.income')}
        value={euro(totals.incomeCents)}
        unknown={unknown}
        rows={[
          { label: t('budget:metric.fromLastMonth'), value: euro(totals.fromLastMonthCents) },
        ]}
      />
      <Metric
        label={t('budget:metric.toBudget')}
        value={euro(totals.toBudgetCents)}
        unknown={unknown}
        // Negative means more was assigned than exists, which is a state to act on
        // rather than a smaller number.
        {...(totals.toBudgetCents < 0 ? { tone: 'negative' as const } : {})}
      />
      <Metric
        label={t('budget:metric.savingsRate')}
        value={savingsRateBp === null ? null : formatBp(savingsRateBp)}
        unknown={unknown}
        {...(savingsRateBp === null
          ? {}
          : { tone: savingsRateBp < 0 ? ('negative' as const) : ('positive' as const) })}
      />
    </div>
  )
}

interface PaceRow {
  categoryId: string
  name: string
  spentCents: number
  assignedCents: number
  projectedCents: number
  overrunCents: number
  monthProgressBp: number
  text: string
}

/**
 * The burn-rate signals, as rows.
 *
 * A signal missing one of its metrics is dropped rather than defaulted, for the reason
 * `renderSignal` drops a sentence with a hole in it: `€ 0` for "the server did not say"
 * is a number someone would act on. `overspend.ts` emits all five together, so this
 * only fires if a payload is malformed.
 */
function paceRows(signals: readonly RenderedSignal[]): PaceRow[] {
  return signals.flatMap((signal) => {
    if (signal.code !== 'burn_rate_over' || signal.categoryId === null) return []
    const { assignedCents, monthProgressBp, projectedCents, projectedOverrunCents, spentCents } =
      signal.metrics
    if (
      assignedCents === undefined ||
      monthProgressBp === undefined ||
      projectedCents === undefined ||
      projectedOverrunCents === undefined ||
      spentCents === undefined
    ) {
      return []
    }
    return [
      {
        categoryId: signal.categoryId,
        name: signal.categoryName ?? '',
        assignedCents,
        monthProgressBp,
        projectedCents,
        overrunCents: projectedOverrunCents,
        spentCents,
        text: signal.text,
      },
    ]
  })
}

/**
 * Spending pace, or nothing at all.
 *
 * No `burn_rate_over` signal means one of two things — the month is over, or nothing is
 * projected to run past its envelope — and in both cases the wire carries no month
 * progress. The browser could work out how far through a month it is, and deliberately
 * does not: on a past month "today" is meaningless, and on the current one a figure the
 * page derived would drift from the projection the sentence beside it was built from.
 */
function Pace({ signals, t }: { signals: readonly RenderedSignal[]; t: TFunction }): ReactNode {
  const rows = paceRows(signals)
  const first = rows[0]
  if (first === undefined) return null

  return (
    <section className="card">
      <h2 className="card__title">{t('budget:chart.burnTitle')}</h2>
      <p className="muted">
        {t('budget:pace.monthProgress', { progress: formatBp(first.monthProgressBp) })}
      </p>
      <ul className="pace">
        {rows.map((row) => (
          <li className="pace__row" key={row.categoryId}>
            <div className="pace__head">
              <span>{row.name}</span>
              <span className="num">
                {t('budget:metric.projected')}: {euro(row.projectedCents)}
              </span>
            </div>
            <PaceBar
              spentCents={row.spentCents}
              assignedCents={row.assignedCents}
              monthProgressBp={row.monthProgressBp}
              label={t('budget:pace.summary', {
                category: row.name,
                spent: euro(row.spentCents),
                assigned: euro(row.assignedCents),
                progress: formatBp(row.monthProgressBp),
              })}
            />
            <p className="pace__note">{row.text}</p>
            <p className="pace__note pace__note--warn num">
              {t('budget:pace.overrun', { amount: euro(row.overrunCents) })}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

interface TrendWallProps {
  categories: readonly CategoryFact[]
  months: readonly string[]
  signals: readonly RenderedSignal[]
}

/**
 * A sparkline per envelope, with what the analysis had to say about each underneath.
 *
 * The burn-rate findings are filtered out because they have their own section above
 * with a bar that says the same thing better; every other finding about a category is
 * the one line of context that turns its shape into a statement.
 */
function TrendWall({ categories, months, signals }: TrendWallProps): ReactNode {
  const { t, language } = useT()
  const [expanded, setExpanded] = useState(false)

  if (categories.length === 0 || months.length === 0) return null
  const shown = expanded ? categories : categories.slice(0, TREND_VISIBLE)

  return (
    <section className="card">
      <h2 className="card__title">{t('budget:chart.trendTitle')}</h2>
      <p className="muted">
        {t('budget:chart.trendWindow', { window: t('time.monthCount', { count: months.length }) })}
      </p>
      <div className="trend-grid">
        {shown.map((category) => (
          <article className="trend" key={category.categoryId}>
            <h3 className="trend__name">{category.categoryName}</h3>
            <p className="trend__value num">
              {euro(category.spentCents)}
              {category.deltaBp === null ? null : (
                <span
                  className={`trend__delta${category.deltaBp > 0 ? ' trend__delta--up' : ''}`}
                >
                  {formatBp(category.deltaBp, { signed: true })}
                </span>
              )}
            </p>
            <CategoryTrend
              name={category.categoryName}
              months={months}
              series={category.trendCents}
              baselineCents={category.baselineCents}
            />
            {signalsFor(signals, category.categoryId)
              .filter((signal) => signal.code !== 'burn_rate_over')
              .map((signal) => (
                <p
                  className={`trend__note${signal.negative ? ' trend__note--warn' : ''}`}
                  key={signal.code}
                >
                  {signal.text}
                </p>
              ))}
          </article>
        ))}
      </div>
      {categories.length <= TREND_VISIBLE ? null : (
        <button
          type="button"
          className="button button--quiet"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? t('action.showLess') : t('action.showMore')}
        </button>
      )}
    </section>
  )
}
