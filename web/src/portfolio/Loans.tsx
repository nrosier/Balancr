/**
 * What is still owed on the loans that are not mortgages, one row per loan (#441).
 *
 * `PropertyTable` next door is the pattern copied, down to the `≈` and the info tip: real
 * `<table>` semantics, a `<caption>` naming the count, a scroll region for the narrow
 * layout, and a balance that says out loud that it is an amortization forward from the
 * last statement the owner confirmed rather than a figure read off one today.
 *
 * The payoff column reads `—` when the schedule never clears the loan — a payment below
 * the monthly interest, or a term that runs out with something still owed. That is a
 * fact about the numbers on file, not a gap in them, and inventing a date for it is the
 * one thing this table must not do.
 */
import { useId, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { formatBp, formatDate, type Portfolio } from '../shared.ts'
import { InfoTip } from '../ui/InfoTip.tsx'
import { Money } from '../ui/Money.tsx'

export type LoanRow = Portfolio['loans'][number]

const DASH = '—'

export function LoansTable({ loans }: { loans: readonly LoanRow[] }): ReactNode {
  const { t } = useT()
  const captionId = useId()

  return (
    <div className="table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
      <table className="table">
        <caption className="table__caption" id={captionId}>
          {t('portfolio:loan.caption', { count: loans.length })}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t('portfolio:loan.column.name')}</th>
            <th scope="col">{t('portfolio:loan.column.kind')}</th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:loan.column.balance')}
            </th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:loan.column.paidOff')}
            </th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:loan.column.rate')}
            </th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:loan.column.payment')}
            </th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:loan.column.payoff')}
            </th>
          </tr>
        </thead>
        <tbody>
          {loans.map((loan) => (
            <tr key={loan.id}>
              <th scope="row" className="table__cell--name">
                {loan.label}
              </th>
              <td>{t(`settings:loans.kind.${loan.kind}`)}</td>
              <td className="table__cell--number">
                {'≈ '}
                <Money cents={loan.balanceCents} options={{ whole: true }} />{' '}
                <InfoTip
                  id={`loan-balance-tip-${loan.id}`}
                  text={t('portfolio:loan.balanceEstimate', {
                    date: formatDate(loan.anchorDate),
                  })}
                />
              </td>
              <td className="table__cell--number">
                {loan.paidOffBp === null ? DASH : formatBp(loan.paidOffBp)}
              </td>
              <td className="table__cell--number">
                {formatBp(loan.rateBp, { maxFractionDigits: 2 })}
              </td>
              <td className="table__cell--number">
                <Money cents={loan.monthlyPaymentCents} options={{ whole: true }} />
              </td>
              <td className="table__cell--number">
                {loan.payoffDate === null ? DASH : formatDate(loan.payoffDate)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
