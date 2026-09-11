/**
 * The data-quality score, and what is costing it points.
 *
 * A bare score would be the least useful version of this. `hygiene.ts` deducts for
 * four specific, fixable things — a backlog of uncategorised transactions, a category
 * total that disagrees with Actual's own, an account nobody has reconciled, prices
 * past their staleness limit — and every one of them is an action rather than a fact.
 * So the deductions are listed with what each cost, and the score is the sum that is
 * left rather than a grade handed down.
 *
 * The reasons are codes on purpose: `hygiene.ts` emits `uncategorised`, and this is
 * where it becomes a sentence in the reader's language. A code with no catalogue entry
 * renders as itself rather than as blank — a new deduction shipping as
 * `stale_something` on screen is ugly and obvious, which is what makes it get fixed;
 * an empty row would be neither.
 *
 * A deduction is a total, not a lead — "recompute_mismatch: -10.00%" says a category
 * disagrees with Actual but not which one, or by how much. `hygiene.ts` already computes
 * that detail as `Signal[]` alongside the coarse deduction it sums into, and
 * `/api/overview` now carries the ones that fund each deduction on `hygiene.signals`. A
 * row with matching signals becomes a disclosure button; clicking it renders their
 * sentences in place via the same `renderSignals` the Insights and Budget pages use, so
 * a mismatch reads exactly the same way here as it does there.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { renderSignals } from '../ai/signals.ts'
import { useT } from '../i18n.ts'
import { formatBp, type FindingCode, type Hygiene } from '../shared.ts'

export interface HygieneCardProps {
  hygiene: Hygiene
}

/** The reasons `hygiene.ts` can emit, and therefore the ones with a label. */
const KNOWN_REASONS = ['uncategorised', 'recompute_mismatch', 'unreconciled', 'stale_prices']

/**
 * Which signal code funds each deduction reason. Kept as its own small, hand-written
 * map rather than shared with the server: `hygiene.ts`'s codes and reasons already
 * differ in name for two of the four (`uncategorised` vs `uncategorised_backlog`,
 * `unreconciled` vs `unreconciled_account`), and four entries are not worth a
 * cross-boundary import for — the same call `KNOWN_REASONS` above already makes.
 */
const REASON_CODE: Record<string, FindingCode> = {
  uncategorised: 'uncategorised_backlog',
  recompute_mismatch: 'recompute_mismatch',
  unreconciled: 'unreconciled_account',
  stale_prices: 'stale_prices',
}

export function HygieneCard({ hygiene }: HygieneCardProps): ReactNode {
  const { t } = useT()
  const { deductions, scoreBp, signals } = hygiene
  const rendered = useMemo(() => renderSignals(signals, t), [signals, t])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  const toggle = (reason: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(reason)) next.delete(reason)
      else next.add(reason)
      return next
    })
  }

  return (
    <section className="card hygiene">
      <h2 className="card__title">{t('budget:hygiene.title')}</h2>
      <p className="metric__value num">{formatBp(scoreBp)}</p>
      <p className="metric__note muted">{t('budget:hygiene.hint')}</p>

      {deductions.length === 0 ? (
        <p className="hygiene__clean">{t('budget:hygiene.clean')}</p>
      ) : (
        <>
          <h3 className="hygiene__heading">{t('budget:hygiene.deductions')}</h3>
          <dl className="metric__rows">
            {deductions.map((deduction) => {
              const code = REASON_CODE[deduction.reason]
              const details = code === undefined ? [] : rendered.filter((s) => s.code === code)
              const label = KNOWN_REASONS.includes(deduction.reason)
                ? t(`budget:hygiene.reason.${deduction.reason}`)
                : deduction.reason
              const isOpen = expanded.has(deduction.reason)

              return (
                <div className="metric__row-group" key={deduction.reason}>
                  <div className="metric__row">
                    <dt>
                      {details.length === 0 ? (
                        label
                      ) : (
                        <button
                          type="button"
                          className="hygiene__reasonButton"
                          aria-expanded={isOpen}
                          onClick={() => toggle(deduction.reason)}
                        >
                          {label}
                        </button>
                      )}
                    </dt>
                    <dd className="num metric__value--negative">{formatBp(-deduction.bp)}</dd>
                  </div>
                  {isOpen && details.length > 0 && (
                    <ul className="hygiene__signals">
                      {details.map((signal, index) => (
                        <li
                          key={`${signal.code}:${signal.categoryId ?? ''}:${index}`}
                          className={`hygiene__signal hygiene__signal--${signal.severity}`}
                        >
                          {signal.text}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            })}
          </dl>
        </>
      )}
    </section>
  )
}
