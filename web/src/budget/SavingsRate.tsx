/**
 * The savings-rate card, with the period chooser that gives its figure a meaning.
 *
 * One component in one file because the alternative is what #296 was filed about: #288
 * gave the Budget page's card four windows and left the Overview page's card on one
 * calendar month, so the same household figure read two different ways on two pages —
 * and the Overview one, being the first card most people see, was the less honest of the
 * two. Two copies of this markup would be two chances for that to happen again.
 *
 * Why this card is the one with a chooser, when none of its neighbours has one: it is a
 * ratio of *flows*, and a calendar month is the window most likely to distort a flow.
 * Rent leaves near the end of the month and the paycheck arrives near the end of the
 * month, so the boundary falls in the middle of the pattern. Assigned, available and
 * left-to-assign are states of a month's envelopes and have no meaning summed over
 * twelve, which is why they stay on their own cards and never gain a period.
 *
 * The arithmetic is not here. `periodSavings` lives in `domain/aggregate/savings.ts`,
 * is pure, and is re-exported through `shared.ts` — the arrangement `custodyShare`
 * already has, and for the same reason: a period rate is `(Σincome − Σspend)/Σincome`
 * and never the mean of the monthly rates, and two copies of that would be two chances
 * to average the percentages in one of them.
 *
 * Period state is the component's own and is not persisted — a reload returns to twelve
 * months, on both pages independently. That is what #288 shipped, and #296 kept it: a
 * shared selection would need somewhere to live, and two cards on two pages that a
 * reader visits one at a time do not obviously want to move together.
 */
import { useId, useMemo, useState, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import {
  DEFAULT_SAVINGS_PERIOD,
  formatBp,
  formatMonth,
  periodSavings,
  SAVINGS_PERIODS,
  type PeriodSavings,
  type SavingsMonth,
  type SavingsPeriod,
} from '../shared.ts'
import { Metric, type MetricRow } from '../ui/Metric.tsx'
import { Money } from '../ui/Money.tsx'

/** What the span sentence needs from the page's translator. */
type TFunction = ReturnType<typeof useT>['t']

/**
 * Which of the four windows the select is on, narrowed at the boundary.
 *
 * `event.target.value` is a `string`, and a value matching no period can only mean the
 * option list and this union have drifted apart — which the i18n check would have caught
 * first. Falling back to the default is the reading that still shows a figure.
 */
export const asPeriod = (value: string): SavingsPeriod =>
  (SAVINGS_PERIODS as readonly string[]).includes(value)
    ? (value as SavingsPeriod)
    : DEFAULT_SAVINGS_PERIOD

/**
 * The span a period actually covered, in words.
 *
 * Always printed, because a selectable window makes a bare percentage ambiguous, and a
 * fresh install asked for twelve months has three — naming the real span is the same
 * honesty rule `committedApproximate` and the custody `basis` already follow (#288).
 */
function spanNote(savings: PeriodSavings, t: TFunction, language: string): string {
  if (savings.from === null || savings.to === null) return t('budget:savings.span.none')
  if (savings.from === savings.to) {
    return t('budget:savings.span.month', { month: formatMonth(savings.from, language) })
  }
  return t('budget:savings.span.range', {
    months: t('time.monthCount', { count: savings.months }),
    from: formatMonth(savings.from, language),
    to: formatMonth(savings.to, language),
  })
}

export interface SavingsRateProps {
  /** A contiguous run of months, oldest first, ending at or after `month`. */
  history: readonly SavingsMonth[]
  /** The anchor: the month the reader has selected, or the newest one there is. */
  month: string
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
   * The rate itself, the chooser and the span sentence are identical either way, which is
   * what #296 was actually about.
   */
  showFlows: boolean
}

export function SavingsRate({ history, month, showFlows }: SavingsRateProps): ReactNode {
  const { t, language } = useT()
  // `useId` rather than a literal, because two of these on one page would otherwise
  // give the same `htmlFor` to two selects and the label would address the wrong one.
  const selectId = useId()

  const [period, setPeriod] = useState<SavingsPeriod>(DEFAULT_SAVINGS_PERIOD)
  const savings = useMemo(() => periodSavings(history, month, period), [history, month, period])

  // The period's own sums, never the anchor month's. A headline over twelve months above
  // rows for one of them is the defect the Overview card would have inherited, where these
  // rows used to come from `totals` and covered a single month (#296).
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
        <div className="field field--inline">
          <label className="field__label" htmlFor={selectId}>
            {t('budget:savings.periodLabel')}
          </label>
          <select
            id={selectId}
            className="field__input"
            value={period}
            onChange={(event) => setPeriod(asPeriod(event.target.value))}
          >
            {SAVINGS_PERIODS.map((option) => (
              <option key={option} value={option}>
                {t(`budget:savings.period.${option}`)}
              </option>
            ))}
          </select>
        </div>
      }
      {...(savings.rateBp === null
        ? {}
        : { tone: savings.rateBp < 0 ? ('negative' as const) : ('positive' as const) })}
    />
  )
}
