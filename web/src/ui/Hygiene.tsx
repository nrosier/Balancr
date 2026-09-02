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
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { formatBp, type Hygiene } from '../shared.ts'

export interface HygieneCardProps {
  hygiene: Hygiene
}

/** The reasons `hygiene.ts` can emit, and therefore the ones with a label. */
const KNOWN_REASONS = ['uncategorised', 'recompute_mismatch', 'unreconciled', 'stale_prices']

export function HygieneCard({ hygiene }: HygieneCardProps): ReactNode {
  const { t } = useT()
  const { deductions, scoreBp } = hygiene

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
            {deductions.map((deduction) => (
              <div className="metric__row" key={deduction.reason}>
                <dt>
                  {KNOWN_REASONS.includes(deduction.reason)
                    ? t(`budget:hygiene.reason.${deduction.reason}`)
                    : deduction.reason}
                </dt>
                <dd className="num metric__value--negative">
                  {formatBp(-deduction.bp)}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  )
}
