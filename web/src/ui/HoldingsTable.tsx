/**
 * What is actually held, largest first.
 *
 * The one place in the application where a row is a position rather than a figure, and
 * the decisions are all about not lying in a cell:
 *
 *  - **Quantity is printed from the provider's own decimal string**, never parsed into
 *    a number first. Fractional shares are real, `0.10000000000000001` is what parsing
 *    one costs, and a quantity is not money so the cents trick does not apply. The
 *    string is split on its decimal point and only the fractional length is used to
 *    tell `formatDecimal` how many places to keep — so `1.5` prints as `1,5` and
 *    `0.123456` keeps its precision, both with Belgian separators.
 *  - **Weight is the share of the total that is on screen**, computed here because the
 *    API does not send a per-holding share and inventing one server-side would mean two
 *    definitions of "weight". It is the one arithmetic on this page, it is a ratio of
 *    two figures in the same payload, and a total of zero yields no weight rather than a
 *    division.
 *  - **The price is rendered in the instrument's own currency, not the base one.** A
 *    quote is in whatever currency the instrument trades in while the value beside it
 *    is already converted, so the two cells in one row can carry two currencies. Under
 *    a Belgian format locale `Intl` distinguishes them by itself — `€ 1.234,56` against
 *    `US$ 1.234,56` — which is why no column gains a currency label: an all-euro
 *    portfolio reads exactly as it did, and a mixed one is unambiguous without being
 *    annotated.
 *  - **A missing name is not an empty cell.** A holding with no name is identified by
 *    its ISIN or symbol, which is the identity the row already has.
 *
 * Table semantics are real `<table>` markup with a `<caption>`, because a grid of divs
 * is unreadable to a screen reader and this is genuinely tabular. Column headers carry
 * `scope="col"`; the instrument cell is a row header. Rows arrive largest first from the
 * API, which is what the caption tells a reader who cannot see the column — sorting
 * again here would be a second definition of the same order.
 *
 * The scroll box takes `tabIndex={0}` because six columns of figures cannot reflow onto
 * a phone, so on a narrow screen this is the only way to reach the right-hand columns
 * without a pointer. That makes it a focus stop, and a focus stop with no role and no
 * name announces itself as nothing at all — so it is a `region` labelled by the same
 * caption that names the table. One accessible name, stated once, reached two ways.
 */
import { useId, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { formatBp, formatDecimal, type Portfolio } from '../shared.ts'
import { Money, Private } from './Money.tsx'

export type Holding = Portfolio['holdings'][number]

export interface HoldingsTableProps {
  holdings: readonly Holding[]
  /** The portfolio total, for the weight column. Null when no total is known. */
  totalValueCents: number | null
}

/**
 * A decimal string, formatted for the locale.
 *
 * The precision is the provider's — the number of places it sent is the number kept,
 * so `0.123456` does not get rounded to one decimal the way `formatDecimal`'s default
 * would. A string that is not a number at all is printed verbatim rather than turned
 * into `NaN`: an unparseable quantity is a data problem to be seen, not hidden.
 *
 * `formatDecimal` caps rather than pads, so a provider's trailing zero (`1.50`) prints
 * as `1,5`. That loses a statement about precision and nothing about the amount, which
 * is the right trade for a column that is read down.
 */
export function formatQuantity(quantity: string): string {
  const parsed = Number(quantity)
  if (!Number.isFinite(parsed) || quantity.trim() === '') return quantity
  return formatDecimal(parsed, quantity.split('.')[1]?.length ?? 0)
}

/** Basis points of the total, or null when there is no total to be a share of. */
function weightBp(valueCents: number, totalValueCents: number | null): number | null {
  if (totalValueCents === null || totalValueCents === 0) return null
  return Math.round((valueCents / totalValueCents) * 10_000)
}

export function HoldingsTable({ holdings, totalValueCents }: HoldingsTableProps): ReactNode {
  const { t } = useT()
  const captionId = useId()

  return (
    <div className="table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
      <table className="table">
        <caption className="table__caption" id={captionId}>
          {t('portfolio:holding.caption', { count: holdings.length })}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t('portfolio:holding.name')}</th>
            <th scope="col">{t('portfolio:holding.isin')}</th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:holding.quantity')}
            </th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:holding.price')}
            </th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:metric.value')}
            </th>
            <th scope="col" className="table__cell--number">
              {t('portfolio:holding.weight')}
            </th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((holding) => {
            const weight = weightBp(holding.valueCents, totalValueCents)
            return (
              <tr key={holding.instrument}>
                <th scope="row" className="table__cell--name">
                  {holding.name ?? holding.isin ?? holding.symbol ?? holding.instrument}
                </th>
                <td className="table__cell--code">{holding.isin ?? holding.symbol ?? '—'}</td>
                <td className="table__cell--number">
                  <Private>{formatQuantity(holding.quantity)}</Private>
                </td>
                <td className="table__cell--number">
                  <Money cents={holding.priceCents} options={{ currency: holding.priceCurrency }} />
                </td>
                <td className="table__cell--number">
                  <Money cents={holding.valueCents} options={{ whole: true }} />
                </td>
                <td className="table__cell--number">
                  {weight === null ? t('empty.unknown') : formatBp(weight)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
