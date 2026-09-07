/**
 * What a month's shared costs actually cost you (#44).
 *
 * Paying the whole school bill in September is a 200% overrun against your own norm and
 * roughly half of it was never economically yours. This is the card that says so — beside
 * Actual's figure and never instead of it.
 *
 * Five decisions:
 *
 *  - **Two columns, and the first one is Actual's.** "You paid" is the number that
 *    reconciles with the bank and with Actual's own screen, so it is printed first and is
 *    never adjusted anywhere in this app. The second column is the new claim. A card that
 *    showed only the derived figure would be a card that quietly disagrees with every
 *    other total on the page.
 *  - **The direction decides every word, not just the numbers (#289).** Under
 *    `whole_invoice` the second column is your part of a bill you paid whole; under
 *    `my_share` it is the total a bill came to, of which your account only ever held a
 *    part. Those are opposite sentences about the same three figures — one says money is
 *    owed to you, the other says money was never yours — so the card branches on
 *    `custody.direction` rather than relabelling a column.
 *  - **The assumption is on screen, always, and the two are not equally strong.** A
 *    discount divides a number Actual holds. A gross-up infers one it has never held from
 *    a share somebody typed, so a wrong share there does not produce a slightly-off
 *    figure — it produces a fiction, and the `my_share` caveat says so in as many words.
 *  - **No colour and no severity**, for the reason the benchmark card gives: nobody has
 *    done anything wrong by paying a bill that gets split, and a red cell is an alert
 *    whatever the payload calls it. The matching findings are capped at `info`.
 *  - **Every unavailable reason draws something (#280).** This once returned `null` for
 *    `no_shared` and `no_month`, and that was right while the split was a card at the
 *    bottom of the Budget page: the flag is opt-in, and a card explaining an absence
 *    nobody asked about is noise on a page already full of content. Then #230 put the
 *    card behind a tab of its own, which inverted the reasoning — a reader who clicked
 *    the label asked about exactly this absence, and an empty pane leaves them guessing
 *    between unimplemented, broken and opt-in. So all four reasons get a box, and each
 *    names its own way out: `no_shared` the two things to set, `no_basis` the share,
 *    `zero_share` a share it cannot divide by, `no_month` the month itself — whose
 *    notice on the Overview section is not on screen from here.
 *
 * Nothing here is computed. Every figure arrives as an integer, including the co-parent's
 * part, which is a subtraction the server did.
 */
import { useId, type ReactNode } from 'react'
import { Trans } from 'react-i18next'
import { useT } from '../i18n.ts'
import { formatBp, formatMonth, type CustodyWire } from '../shared.ts'
import { Money } from '../ui/Money.tsx'

/** Whole euro, like every other total on this page. */
const euro = (cents: number): ReactNode => <Money cents={cents} options={{ whole: true }} />

export function Custody({ custody }: { custody: CustodyWire }): ReactNode {
  const { t, language } = useT()
  const captionId = useId()

  if (custody.kind === 'unavailable') {
    // Two of the four reasons name the flagged total, and can: something was flagged, so
    // there is a figure to report. The other two have nothing to put in a sentence —
    // `no_shared` because nothing is flagged and `no_month` because nothing was
    // aggregated — so they are plain `t()` rather than a `Trans` around a euro that would
    // print as nought.
    const withFigure = custody.reason === 'no_basis' || custody.reason === 'zero_share'
    return (
      <div className="notice notice--info" role="status">
        <p className="notice__lead">
          {withFigure ? (
            <Trans
              i18nKey={`budget:custody.unavailable.${custody.reason}`}
              // Both of these reasons always carry the flagged total; the nullable type is
              // the union's, not this branch's.
              components={{
                money: <Money cents={custody.paidCents ?? 0} options={{ whole: true }} />,
              }}
            />
          ) : (
            t(`budget:custody.unavailable.${custody.reason}`)
          )}
        </p>
        <p className="notice__hint">{t(`budget:custody.unavailable.hint.${custody.reason}`)}</p>
      </div>
    )
  }

  const share = formatBp(custody.shareBp)
  // The direction picks the sentence, and the derived column with it. Named once here
  // rather than tested at each of the four places it matters, so a future third direction
  // fails to compile in one spot instead of quietly taking the whole-invoice branch four
  // times over.
  const grossedUp = custody.direction === 'my_share'
  const derived = (line: { totalCents: number; yoursCents: number }): number =>
    grossedUp ? line.totalCents : line.yoursCents

  return (
    <section className="card">
      <h2 className="card__title">{t('budget:custody.title')}</h2>

      <p className="custody__lede">
        <Trans
          i18nKey={`budget:custody.lede.${custody.direction}`}
          values={{ month: formatMonth(custody.month, language) }}
          components={{
            money: <Money cents={custody.paidCents} options={{ whole: true }} />,
            money2: <Money cents={derived(custody)} options={{ whole: true }} />,
            money3: <Money cents={custody.otherCents} options={{ whole: true }} />,
          }}
        />
      </p>

      <div className="table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
        <table className="table custody__table">
          <caption className="table__caption" id={captionId}>
            {t(`budget:custody.caption.${custody.direction}`)}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t('budget:custody.column.category')}</th>
              <th scope="col" className="table__cell--number">
                {t('budget:custody.column.paid')}
              </th>
              <th scope="col" className="table__cell--number">
                {t(grossedUp ? 'budget:custody.column.total' : 'budget:custody.column.borne')}
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
                <td className="table__cell--number">{euro(derived(line))}</td>
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
              <td className="table__cell--number">{euro(derived(custody))}</td>
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
        <li>{t(`budget:custody.assumption.${custody.direction}`, { share })}</li>
      </ul>
    </section>
  )
}
