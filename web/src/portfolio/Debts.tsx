/**
 * What is still owed on revolving debt — a credit card, a store card (#442), one row
 * per debt.
 *
 * `LoansTable` next door is the pattern copied, down to the `<table>` semantics and the
 * scroll region — with the one difference the domain has: `balanceCents` here is simply
 * the stored figure, never amortized forward from a date, so there is no `≈` and no info
 * tip explaining an estimate. The interest column reads `—` when no APR is on file, which
 * is a fact about what was entered, not a gap in the arithmetic.
 */
import { useId, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { formatBp, type Portfolio } from '../shared.ts'
import { Money } from '../ui/Money.tsx'

export type DebtRow = Portfolio['debts'][number]

const DASH = '—'

export function DebtsTable({ debts }: { debts: readonly DebtRow[] }): ReactNode {
  const { t } = useT()
  const captionId = useId()

  return (
    <div className="table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
      <table className="table">
        <caption className="table__caption" id={captionId}>
          {t('portfolio:debt.caption', { count: debts.length })}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t('portfolio:debt.column.name')}</th>
            <th scope="col">{t('portfolio:debt.column.kind')}</th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:debt.column.balance')}
            </th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:debt.column.minimumPayment')}
            </th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:debt.column.rate')}
            </th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:debt.column.estimatedInterest')}
            </th>
          </tr>
        </thead>
        <tbody>
          {debts.map((debt) => (
            <tr key={debt.id}>
              <th scope="row" className="table__cell--name">
                {debt.label}
              </th>
              <td>{t(`settings:debts.kind.${debt.kind}`)}</td>
              <td className="table__cell--number">
                <Money cents={debt.balanceCents} options={{ whole: true }} />
              </td>
              <td className="table__cell--number">
                <Money cents={debt.minimumPaymentCents} options={{ whole: true }} />
              </td>
              <td className="table__cell--number">
                {debt.aprBp === null ? DASH : formatBp(debt.aprBp, { maxFractionDigits: 2 })}
              </td>
              <td className="table__cell--number">
                {debt.estimatedMonthlyInterestCents === null ? (
                  DASH
                ) : (
                  <Money cents={debt.estimatedMonthlyInterestCents} options={{ whole: true }} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
