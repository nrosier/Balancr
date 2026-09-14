/**
 * The savings-rate card, with the period picker that gives its figure a meaning.
 *
 * One component in one file because the alternative is what #296 was filed about: #288
 * gave the Budget page's card four relative windows and left the Overview page's card on
 * one calendar month, so the same household figure read two different ways on two pages —
 * and the Overview one, being the first card most people see, was the less honest of the
 * two. Two copies of this markup would be two chances for that to happen again.
 *
 * Why this card is the one with a picker, when none of its neighbours has one: it is a
 * ratio of *flows*, and a calendar month is the window most likely to distort a flow.
 * Rent leaves near the end of the month and the paycheck arrives near the end of the
 * month, so the boundary falls in the middle of the pattern. Assigned, available and
 * left-to-assign are states of a month's envelopes and have no meaning summed over a
 * year, which is why they stay on their own cards and never gain a period.
 *
 * The arithmetic is not here. `absolutePeriodSavings` lives in `domain/aggregate/
 * savings.ts`, is pure, and is re-exported through `shared.ts` — the arrangement
 * `custodyShare` already has, and for the same reason: a period rate is
 * `(Σincome − Σspend)/Σincome` and never the mean of the monthly rates, and two copies
 * of that would be two chances to average the percentages in one of them.
 *
 * Presentational since #345: the period is the caller's `useState`, not this
 * component's, because the two callers disagree about what it should follow — the
 * Overview page has no other picker for it to follow, so it owns an independent
 * selection and passes `onPeriodSelect`, while the Budget page has one already and
 * follows it: no `onPeriodSelect` there means no picker of its own, just the figure
 * for whatever the page's own month/year picker is showing. A component that kept
 * its own state could not be steered either way.
 */
import { Fragment, useId, useMemo, type ReactNode } from 'react'
import { Trans } from 'react-i18next'
import { useT } from '../i18n.ts'
import {
  absolutePeriodSavings,
  formatBp,
  formatMonth,
  formatSettings,
  resolveYearAnchor,
  type AbsolutePeriodSavings,
  type SavingsMonth,
} from '../shared.ts'
import { Metric, type MetricRow } from '../ui/Metric.tsx'
import { Money } from '../ui/Money.tsx'
import { PeriodPicker, type Period } from '../ui/PeriodPicker.tsx'

/** What the span sentence needs from the page's translator. */
type TFunction = ReturnType<typeof useT>['t']

/**
 * The span a period actually covered, in words — plus a pro-ration caveat when the
 * period ends in a still-open month, the same disclosure `Benchmark.tsx` gives its own
 * period (#323), generalized here for the first time to a card that never had one.
 *
 * Always printed, because a selectable window makes a bare percentage ambiguous, and a
 * fresh install asked for a year has three months — naming the real span is the same
 * honesty rule `committedApproximate` and the custody `basis` already follow (#288).
 *
 * Exported since #355: `Totals` on the Budget page needs the same sentence under its
 * own Spent/Income cards once a year's worth of flows replaces one month's, and a
 * second copy would be a second chance for the wording to drift.
 *
 * A second caveat joins the pro-ration one when `committedCents` is nonzero (#361):
 * the rate already folded in money a schedule promises but hasn't posted, which
 * makes it a prediction rather than a result until the open month closes. That
 * caveat names an amount, so unlike the other two sentences it is a `<Trans>`
 * wrapping `<Money>` rather than a plain `t()` string — the same reason `Metric`'s
 * `note` prop takes `ReactNode` — which is why this returns `ReactNode` rather
 * than `string` even though it usually is one.
 */
export function spanNote(savings: AbsolutePeriodSavings, t: TFunction, language: string): ReactNode {
  const span =
    savings.from === null || savings.to === null
      ? t('budget:savings.span.none')
      : savings.from === savings.to
        ? t('budget:savings.span.month', { month: formatMonth(savings.from, language) })
        : t('budget:savings.span.range', {
            months: t('time.monthCount', { count: savings.months }),
            from: formatMonth(savings.from, language),
            to: formatMonth(savings.to, language),
          })
  const parts: ReactNode[] = [span]
  if (savings.periodProgressBp < 10_000) {
    parts.push(t('budget:savings.period.prorated', { progress: formatBp(savings.periodProgressBp) }))
  }
  if (savings.committedCents > 0) {
    parts.push(
      <Trans
        key="estimate"
        i18nKey="budget:savings.period.estimate"
        components={{ money: <Money cents={savings.committedCents} options={{ whole: true }} /> }}
      />,
    )
  }
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? ' ' : null}
          {part}
        </Fragment>
      ))}
    </>
  )
}

export interface SavingsRateProps {
  /** Every stored month's flows, oldest first — as much history as the period picker can reach. */
  history: readonly SavingsMonth[]
  /** Every month with data, newest first, straight off the payload — for the picker's graying and year resolution. */
  months: readonly string[]
  /** The reader's own selection on Overview, or the page's own period on Budget (#345). */
  period: Period
  /**
   * Present only when this card owns its own selection (Overview). Absent means the
   * period is a prop the caller already controls, so the card has nothing to offer a
   * picker for — the figure just follows whatever the caller is showing (Budget).
   */
  onPeriodSelect?: (period: Period) => void
  /**
   * Whether to print the period's summed income and spend beneath the rate.
   *
   * Required rather than defaulted, because the two pages answer it differently and a
   * default would hide the decision. On the Overview page the answer is yes: nothing else
   * there carries a flow, so without the pair the rate is a percentage nobody can check.
   * On the Budget page it is no — full-size **Spent** and **Income** cards for the
   * selected month sit two positions to the left, and repeating a *period's* pair inside
   * this card would put four figures under two labels and invite the reader to compare
   * numbers that cover different spans.
   *
   * The rate itself, the picker and the span sentence are identical either way, which is
   * what #296 was actually about.
   */
  showFlows: boolean
}

export function SavingsRate({
  history,
  months,
  period,
  onPeriodSelect,
  showFlows,
}: SavingsRateProps): ReactNode {
  const { t, language } = useT()
  // `useId` rather than a literal, because two of these on one page would otherwise
  // give the same `id` to two pickers and the trigger would control the wrong popover.
  const periodSelectId = useId()

  const availableMonths = useMemo(() => new Set(months), [months])
  // A year selection needs a concrete month to sum from: the latest stored month in
  // that year, or December when nothing was ever computed for it — the same resolution
  // the year-aware server routes make (#345).
  const anchorMonth = period.kind === 'month' ? period.value : resolveYearAnchor(months, period.value)
  const savings = useMemo(
    () =>
      absolutePeriodSavings(history, period.kind, anchorMonth, new Date(), formatSettings().timeZone),
    [history, period.kind, anchorMonth],
  )

  // The period's own sums, never the anchor month's. A headline over a year above rows
  // for one of its months is the defect the Overview card would have inherited, where
  // these rows used to come from `totals` and covered a single month (#296).
  const rows: MetricRow[] = !showFlows
    ? []
    : [
        {
          label: t('budget:metric.income'),
          value: <Money cents={savings.incomeCents} options={{ whole: true }} />,
        },
        {
          label: t('budget:metric.spent'),
          value: <Money cents={savings.spentCents} options={{ whole: true }} />,
        },
      ]

  return (
    <Metric
      label={t('budget:metric.savingsRate')}
      value={savings.rateBp === null ? null : formatBp(savings.rateBp)}
      unknown={t('empty.unknown')}
      note={spanNote(savings, t, language)}
      rows={rows}
      control={
        onPeriodSelect === undefined ? undefined : (
          <PeriodPicker
            period={period}
            onSelect={onPeriodSelect}
            id={periodSelectId}
            label={t('budget:savings.periodLabel')}
            kindLabel={(kind) => t(`budget:savings.period.${kind}`)}
            availableMonths={availableMonths}
          />
        )
      }
      {...(savings.rateBp === null
        ? {}
        : { tone: savings.rateBp < 0 ? ('negative' as const) : ('positive' as const) })}
    />
  )
}
