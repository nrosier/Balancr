/**
 * What is owned outright of a house, one row per property (#227).
 *
 * Deliberately its own table rather than a `Metric` tile per property: several
 * properties each carry several figures, which is a grid, not a headline number
 * with a caption. `HoldingsTable` is the pattern copied — real `<table>` semantics,
 * a `<caption>` naming the count, a scroll region for the narrow layout.
 *
 * Rent, cash flow and yield read `—` for a primary residence, or a rental with no
 * rent entered yet — both are "not tracked", not "zero", and `netCashFlowCents`/
 * `grossYieldBp` already come back `null` from the server for exactly that reason.
 * The mortgage-balance column has no such gate: a property with no mortgage and one
 * paid off in full are both, honestly, a balance of zero.
 */
import { useId, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { formatBp, type Portfolio } from '../shared.ts'
import { Money } from '../ui/Money.tsx'

export type PropertyRow = Portfolio['properties'][number]

const DASH = '—'

export function PropertyTable({ properties }: { properties: readonly PropertyRow[] }): ReactNode {
  const { t } = useT()
  const captionId = useId()

  return (
    <div className="table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
      <table className="table">
        <caption className="table__caption" id={captionId}>
          {t('portfolio:property.caption', { count: properties.length })}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t('portfolio:property.column.name')}</th>
            <th scope="col">{t('portfolio:property.column.kind')}</th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:property.column.value')}
            </th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:property.column.balance')}
            </th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:property.column.equity')}
            </th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:property.column.rent')}
            </th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:property.column.cashFlow')}
            </th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:property.column.yield')}
            </th>
          </tr>
        </thead>
        <tbody>
          {properties.map((property) => (
            <tr key={property.id}>
              <th scope="row" className="table__cell--name">
                {property.label}
              </th>
              <td>{t(`settings:property.kind.${property.kind}`)}</td>
              <td className="table__cell--number">
                {property.propertyValueCents === null ? (
                  DASH
                ) : (
                  <Money cents={property.propertyValueCents} options={{ whole: true }} />
                )}
              </td>
              <td className="table__cell--number">
                <Money cents={property.mortgageBalanceCents} options={{ whole: true }} />
              </td>
              <td className="table__cell--number">
                {property.equityCents === null ? (
                  DASH
                ) : (
                  <Money cents={property.equityCents} options={{ whole: true }} />
                )}
              </td>
              <td className="table__cell--number">
                {property.rentCents === null ? (
                  DASH
                ) : (
                  <Money cents={property.rentCents} options={{ whole: true }} />
                )}
              </td>
              <td className="table__cell--number">
                {property.netCashFlowCents === null ? (
                  DASH
                ) : (
                  <Money cents={property.netCashFlowCents} options={{ whole: true }} />
                )}
              </td>
              <td className="table__cell--number">
                {property.grossYieldBp === null ? DASH : formatBp(property.grossYieldBp)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
