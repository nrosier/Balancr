/**
 * What the analysis found, worst first.
 *
 * The list is grouped by severity rather than sorted by it, because a sorted list of
 * eighteen sentences has no shape: the reader cannot tell where "act on this" stops
 * and "for your information" begins, and the two need different amounts of attention.
 * A heading per group says it in one word, and the word is the same one the server
 * ranked by — `SEVERITY_RANK` is imported rather than an order written out here, so
 * the page cannot come to disagree with the ranking that chose which findings to
 * keep.
 *
 * The sentences are assembled in the browser by `renderSignals`, which is also what
 * decides that a finding is unrenderable and drops it. So an empty group is not
 * drawn, and a payload of findings this bundle cannot state renders as
 * `findings.none` — which is honest: this version has nothing to say about them.
 *
 * **Colour is never the only signal.** Each row is bordered by its severity, and the
 * severity is also the group's heading. Good news gets its own border rather than
 * inheriting `info`'s, because `below_baseline` and `no_spend_streak` are findings
 * whose whole point is that nothing is wrong.
 *
 * **A year is a list of months, not a new total (#352).** Most signals — envelope
 * carry-in, an EWMA baseline, "is today's price stale" — have no year-shaped equivalent
 * to compute, so year mode does not sum anything: it lists each month of the year's own
 * already-judged findings, newest first, reusing the exact same severity grouping per
 * month rather than inventing a second rendering.
 */
import { useMemo, type ReactNode } from 'react'
import { renderSignals, type RenderedSignal, type WireSignal } from '../ai/signals.ts'
import { useT } from '../i18n.ts'
import { formatMonth, SEVERITY_RANK, type Severity } from '../shared.ts'
import { Private } from '../ui/Money.tsx'
import type { Period } from '../ui/PeriodPicker.tsx'

/** Worst first, from the table the server ranks with. */
const GROUPS = (Object.keys(SEVERITY_RANK) as Severity[]).sort(
  (a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b],
)

export interface FindingsHistoryEntry {
  month: string
  signals: readonly WireSignal[]
}

export interface FindingsProps {
  signals: readonly WireSignal[]
  /** Year mode's widened list (#352): `month`'s year, newest first, months with nothing stored already left out. */
  history: readonly FindingsHistoryEntry[]
  /**
   * The month the findings are about. Named on the card because it is not always the
   * current one: the signals come from the last month that was aggregated, so a sync
   * that has not run since the 1st means these are last month's findings.
   */
  month: string | null
  /** Which of the two shapes above to draw — mirrors the picker mode above the card (#352). */
  period: Period | null
}

export function Findings({ signals, history, month, period }: FindingsProps): ReactNode {
  const { t } = useT()

  return (
    <section className="card">
      <h2 className="card__title">{t('ai:findings.title')}</h2>
      {period?.kind === 'year' ? (
        <FindingsYear history={history} />
      ) : (
        <FindingsMonth signals={signals} month={month} />
      )}
    </section>
  )
}

function FindingsMonth({
  signals,
  month,
}: {
  signals: readonly WireSignal[]
  month: string | null
}): ReactNode {
  const { t, language } = useT()
  const rendered = useMemo(() => renderSignals(signals, t), [signals, t])

  return (
    <>
      {month === null ? null : (
        <p className="muted">{t('ai:findings.month', { month: formatMonth(month, language) })}</p>
      )}
      {rendered.length === 0 ? (
        <p className="muted">{t('ai:findings.none')}</p>
      ) : (
        <FindingGroups rendered={rendered} />
      )}
    </>
  )
}

/** One section per history month that has anything renderable, newest first. */
function FindingsYear({ history }: { history: readonly FindingsHistoryEntry[] }): ReactNode {
  const { t, language } = useT()
  const sections = useMemo(
    () => history.map((entry) => ({ month: entry.month, rendered: renderSignals(entry.signals, t) })),
    [history, t],
  )
  const nonEmpty = sections.filter((section) => section.rendered.length > 0)

  if (nonEmpty.length === 0) return <p className="muted">{t('ai:findings.none')}</p>

  return (
    <>
      {nonEmpty.map((section) => (
        <div className="findings-month" key={section.month}>
          <h3 className="findings-month__title">{formatMonth(section.month, language)}</h3>
          <FindingGroups rendered={section.rendered} />
        </div>
      ))}
    </>
  )
}

function FindingGroups({ rendered }: { rendered: readonly RenderedSignal[] }): ReactNode {
  const { t } = useT()

  return (
    <>
      {GROUPS.map((severity) => {
        const group = rendered.filter((signal) => signal.severity === severity)
        if (group.length === 0) return null
        return (
          <div className="finding-group" key={severity}>
            <h3 className="finding-group__title">{t(`severity.${severity}`)}</h3>
            <ul className="findings">
              {group.map((signal, index) => (
                <li
                  // A code can legitimately repeat across categories, and a category
                  // can carry several codes, so neither alone is a key.
                  key={`${signal.code}:${signal.categoryId ?? ''}:${index}`}
                  className={`finding finding--${signal.negative ? severity : 'positive'}`}
                >
                  {/* The sentence is assembled client-side from `metrics` (#489): a
                      figure it names is never a separate node `data-private` could
                      mark, so the whole sentence is the unit privacy mode blurs. */}
                  <Private>{signal.text}</Private>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </>
  )
}
