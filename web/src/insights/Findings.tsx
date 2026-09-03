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
 */
import { useMemo, type ReactNode } from 'react'
import { renderSignals, type WireSignal } from '../ai/signals.ts'
import { useT } from '../i18n.ts'
import { formatMonth, SEVERITY_RANK, type Severity } from '../shared.ts'

/** Worst first, from the table the server ranks with. */
const GROUPS = (Object.keys(SEVERITY_RANK) as Severity[]).sort(
  (a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b],
)

export interface FindingsProps {
  signals: readonly WireSignal[]
  /**
   * The month the findings are about. Named on the card because it is not always the
   * current one: the signals come from the last month that was aggregated, so a sync
   * that has not run since the 1st means these are last month's findings.
   */
  month: string | null
}

export function Findings({ signals, month }: FindingsProps): ReactNode {
  const { t, language } = useT()
  const rendered = useMemo(() => renderSignals(signals, t), [signals, t])

  return (
    <section className="card">
      <h2 className="card__title">{t('ai:findings.title')}</h2>
      {month === null ? null : (
        <p className="muted">{t('ai:findings.month', { month: formatMonth(month, language) })}</p>
      )}
      {rendered.length === 0 ? (
        <p className="muted">{t('ai:findings.none')}</p>
      ) : (
        GROUPS.map((severity) => {
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
                    {signal.text}
                  </li>
                ))}
              </ul>
            </div>
          )
        })
      )}
    </section>
  )
}
