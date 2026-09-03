/**
 * What a month's shared costs actually cost you (#44).
 *
 * Paying the whole school bill in September is a 200% overrun against your own norm and
 * roughly half of it was never economically yours. This is the card that says so — beside
 * Actual's figure and never instead of it.
 *
 * Four decisions:
 *
 *  - **Two columns, and the first one is Actual's.** "You paid" is the number that
 *    reconciles with the bank and with Actual's own screen, so it is printed first and is
 *    never adjusted anywhere in this app. "Yours" is the second column and the new claim.
 *    A card that showed only the halved figure would be a card that quietly disagrees with
 *    every other total on the page.
 *  - **The assumption is on screen, always.** A borne figure rests on "you paid the whole
 *    invoice and bear this share of it", which is true of school fees and false of a cost
 *    the co-parent invoices you for. Nothing can check which, so the card states it and a
 *    wrongly flagged category becomes visible rather than silently halved.
 *  - **No colour and no severity**, for the reason the benchmark card gives: nobody has
 *    done anything wrong by paying a bill that gets split, and a red cell is an alert
 *    whatever the payload calls it. The matching finding is capped at `info`.
 *  - **Two of the three unavailable reasons draw nothing.** `no_shared` is the ordinary
 *    state of most budgets — the flag is opt-in, and a card explaining an absence nobody
 *    asked about is noise — and `no_month` already has its own notice above. `no_basis` is
 *    the one worth a box: categories are flagged, so somebody meant this to work.
 *
 * Nothing here is computed. Every figure arrives as an integer, including the offset,
 * which is a subtraction the server did.
 */
import { useId, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { formatBp, formatMonth, formatMoney, type CustodyWire } from '../shared.ts'

/** Whole euro, like every other total on this page. */
const euro = (cents: number): string => formatMoney(cents, { whole: true })

export function Custody({ custody }: { custody: CustodyWire }): ReactNode {
  const { t, language } = useT()
  const captionId = useId()

  if (custody.kind === 'unavailable') {
    if (custody.reason !== 'no_basis') return null
    return (
      <div className="notice notice--info" role="status">
        <p className="notice__lead">
          {t('budget:custody.unavailable.no_basis', {
            // `no_basis` always carries the flagged total; the nullable type is the
            // union's, not this branch's.
            amount: euro(custody.paidCents ?? 0),
          })}
        </p>
        <p className="notice__hint">{t('budget:custody.unavailable.hint')}</p>
      </div>
    )
  }

  const share = formatBp(custody.shareBp)

  return (
    <section className="card">
      <h2 className="card__title">{t('budget:custody.title')}</h2>

      <p className="custody__lede">
        {t('budget:custody.lede', {
          month: formatMonth(custody.month, language),
          paid: euro(custody.paidCents),
          borne: euro(custody.borneCents),
          offset: euro(custody.offsetCents),
        })}
      </p>

      <div className="table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
        <table className="table custody__table">
          <caption className="table__caption" id={captionId}>
            {t('budget:custody.caption')}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t('budget:custody.column.category')}</th>
              <th scope="col" className="table__cell--number">
                {t('budget:custody.column.paid')}
              </th>
              <th scope="col" className="table__cell--number">
                {t('budget:custody.column.borne')}
              </th>
            </tr>
          </thead>
          <tbody>
            {custody.lines.map((line) => (
              <tr key={line.categoryId}>
                <th scope="row" className="table__cell--name">
                  {line.categoryName}
                </th>
                <td className="table__cell--number">{euro(line.paidCents)}</td>
                <td className="table__cell--number">{euro(line.borneCents)}</td>
              </tr>
            ))}
          </tbody>
          {/*
            A footer rather than a last row, so a screen reader announces it as the
            summary it is and the rows above stay a list of categories. The two totals
            are the sums of the columns above them, which is why the server rounds each
            line rather than the total.
          */}
          <tfoot>
            <tr>
              <th scope="row">{t('budget:custody.total')}</th>
              <td className="table__cell--number">{euro(custody.paidCents)}</td>
              <td className="table__cell--number">{euro(custody.borneCents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <ul className="custody__meta">
        <li>
          {custody.basis === 'stated'
            ? t('budget:custody.basis.stated', { share })
            : t('budget:custody.basis.roster', { count: custody.members, share })}
        </li>
        <li>{t('budget:custody.share', { share: formatBp(custody.shareOfSpendBp) })}</li>
        <li>{t('budget:custody.assumption', { share })}</li>
      </ul>
    </section>
  )
}
