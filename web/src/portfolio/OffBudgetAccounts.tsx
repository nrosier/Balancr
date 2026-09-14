/**
 * The off-budget Actual accounts already folded into net worth, named (#353).
 *
 * A mortgage or a house-value tracker sits off-budget in Actual and has always
 * counted toward the total — this table only says which accounts and how much,
 * so the figure above stops being unexplained. Same table convention as
 * `Property.tsx`: a real `<table>`, a `<caption>` naming the count, a scroll
 * region for the narrow layout. Two columns only, since there is no
 * currency-conversion story to show here.
 */
import { useId, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import type { Portfolio } from '../shared.ts'
import { Money } from '../ui/Money.tsx'

export type OffBudgetAccountRow = Portfolio['offBudgetAccounts'][number]

export function OffBudgetAccountsTable({
  accounts,
}: {
  accounts: readonly OffBudgetAccountRow[]
}): ReactNode {
  const { t } = useT()
  const captionId = useId()

  return (
    <div className="table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
      <table className="table">
        <caption className="table__caption" id={captionId}>
          {t('portfolio:offBudget.caption', { count: accounts.length })}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t('portfolio:offBudget.column.name')}</th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:offBudget.column.balance')}
            </th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={account.id}>
              <th scope="row" className="table__cell--name">
                {account.name}
              </th>
              <td className="table__cell--number">
                <Money cents={account.balanceCents} options={{ whole: true }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
