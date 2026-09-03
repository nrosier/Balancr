/**
 * Your month against what Belgian households actually spend (#43).
 *
 * The card that is easiest to make convincingly wrong, so most of it is disclosure.
 * `compare.ts` refuses to draw a comparison it cannot stand behind; this is the other
 * half of that bargain — everything the refusal is based on is on screen, in the same
 * card as the figures it qualifies.
 *
 * Five decisions:
 *
 *  - **No colour, and no severity.** #43 asks for this as `info` and never as an alert,
 *    and a red cell is an alert whatever the payload says it is. A national average is a
 *    statement about the country, not evidence about you: a household with a long commute
 *    and no restaurant habit is above the transport line and below the hotels one, and
 *    neither is a finding about the household. The last column says the word instead, so
 *    what a sighted reader scans is what a screen reader is told.
 *  - **`categories === 0` is its own state, not a low figure.** A group nothing is mapped
 *    to reads as 0% of your spending, which looks like "you spend nothing on health" and
 *    means "health is not mapped yet". Those are opposite conclusions and the table has
 *    to distinguish them, so an unfed line says "not mapped" and its share is not a claim.
 *  - **The threshold comes from the domain, not from here.** `MIN_DELTA_BP` is the line
 *    `overspend.ts` emits a finding at, so the words in the last column mark exactly the
 *    rows that produced one and the card cannot start disagreeing with the insights page.
 *    Below is treated symmetrically at the same magnitude — it is a word, not a finding.
 *  - **Two of the four unavailability reasons render nothing at all.** `no_file` is a
 *    deployment that ships no benchmark, which is supported and not worth a box on every
 *    budget page; `no_month` is a month with no spending, which already has its own notice
 *    above. The other two are things the reader can fix, and say what and where.
 *  - **The basis is a sentence, not a badge.** A `mix` comparison is about how spending is
 *    *divided* and a `level` one about how much is *spent* — see `compare.ts` — and the
 *    euro column means something different in each. A card that did not say which would
 *    invite the stronger conclusion from the weaker comparison, so the lede says it in
 *    words and the reference column is explained rather than labelled.
 *
 * Nothing here is computed, in keeping with the rest of the page: every figure arrives as
 * an integer. The one arithmetic is basis points into a scale figure, which is the unit
 * conversion `formatBp` does internally and not a number this card decided.
 */
import { useId, type ReactNode } from 'react'
import { useT, type TFunction } from '../i18n.ts'
import {
  formatBp,
  formatDate,
  formatDecimal,
  formatList,
  formatMonth,
  formatMoney,
  MIN_DELTA_BP,
  MIN_MAPPED_BP,
  type BenchmarkGroupLine,
  type BenchmarkWire,
} from '../shared.ts'

/** Whole euro, like every other total on this page. Cents on a monthly figure are noise. */
const euro = (cents: number): string => formatMoney(cents, { whole: true })

/** The word in the last column, which is also the only judgement the card makes. */
type LineState = 'unmapped' | 'above' | 'below' | 'inLine'

/**
 * Where a line sits.
 *
 * `unmapped` is tested first and wins over everything: a group fed by no categories has
 * a share of zero for a reason that has nothing to do with spending, and calling that
 * "below the reference" would be the one genuinely misleading sentence on the page.
 */
function lineState(line: BenchmarkGroupLine): LineState {
  if (line.categories === 0) return 'unmapped'
  if (line.deltaBp === null || Math.abs(line.deltaBp) < MIN_DELTA_BP) return 'inLine'
  return line.deltaBp > 0 ? 'above' : 'below'
}

/** The household on the equivalence scale, in the sentences it takes to be honest. */
function householdLines(
  household: Extract<BenchmarkWire, { kind: 'ok' }>['household'],
  t: TFunction,
): string[] {
  // Basis points into adults: 13 000 is 1,3 people on the scale. Two decimals rather than
  // the default one, because custody proration produces figures the published scale never
  // does — a household of 1,15 rendered as "1,2" is a divisor that does not match the
  // weights listed two clicks away in settings.
  const scale = formatDecimal(household.bp / 10_000, 2)
  if (household.members === 0) return [t('budget:benchmark.household.solo', { scale })]

  const lines = [t('budget:benchmark.household.line', { count: household.members, scale })]
  if (household.children > 0) {
    lines.push(t('budget:benchmark.household.children', { count: household.children }))
  }
  // The scale has no notion of part-time membership at all, so prorating a member's
  // weight by their share of the time is Balancr's assumption and not the published
  // scale's. #43 asks for it to be stated on screen, and this is the screen.
  if (household.prorated) lines.push(t('budget:benchmark.household.prorated'))
  return lines
}

export function Benchmark({ benchmark }: { benchmark: BenchmarkWire }): ReactNode {
  const { t, language } = useT()
  const captionId = useId()

  if (benchmark.kind === 'unavailable') {
    if (benchmark.reason === 'no_file' || benchmark.reason === 'no_month') return null
    return (
      <div className="notice notice--info" role="status">
        <p className="notice__lead">
          {t(`budget:benchmark.unavailable.${benchmark.reason}`, {
            // Both remaining reasons carry a share — `no_mapping` is zero by
            // construction — and the nullable type is the union's, not this branch's.
            share: formatBp(benchmark.mappedShareBp ?? 0),
            floor: formatBp(MIN_MAPPED_BP),
          })}
        </p>
        <p className="notice__hint">{t('budget:benchmark.unavailable.hint')}</p>
      </div>
    )
  }

  const { groups, household, source, unmapped } = benchmark

  return (
    <section className="card">
      <h2 className="card__title">{t('budget:benchmark.title')}</h2>

      <p className="benchmark__lede">
        {t(`budget:benchmark.lede.${benchmark.basis}`, {
          month: formatMonth(benchmark.month, language),
          survey: source.survey,
          year: String(source.year),
          total: euro(benchmark.comparedCents),
        })}
      </p>

      <div className="table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
        <table className="table">
          <caption className="table__caption" id={captionId}>
            {t('budget:benchmark.caption', { survey: source.survey, year: String(source.year) })}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t('budget:benchmark.column.group')}</th>
              <th scope="col" className="table__cell--number">
                {t('budget:benchmark.column.yours')}
              </th>
              <th scope="col" className="table__cell--number">
                {t('budget:benchmark.column.yourShare')}
              </th>
              <th scope="col" className="table__cell--number">
                {t('budget:benchmark.column.referenceShare')}
              </th>
              <th scope="col" className="table__cell--number">
                {t('budget:benchmark.column.reference')}
              </th>
              <th scope="col" className="table__cell--number">
                {t('budget:benchmark.column.difference')}
              </th>
              <th scope="col">{t('budget:benchmark.column.state')}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((line) => {
              const state = lineState(line)
              return (
                <tr key={line.group}>
                  <th scope="row" className="table__cell--name">
                    {t(`budget:benchmark.group.${line.group}`)}
                  </th>
                  <td className="table__cell--number">{euro(line.yourCents)}</td>
                  <td className="table__cell--number">{formatBp(line.yourShareBp)}</td>
                  <td className="table__cell--number">{formatBp(line.referenceShareBp)}</td>
                  <td className="table__cell--number">{euro(line.benchmarkCents)}</td>
                  {/*
                    An em dash where the reference is zero: a group the survey puts no
                    money in makes every euro an infinite overshoot, and `deltaBp` is
                    null there rather than a number nobody should read.
                  */}
                  <td className="table__cell--number">
                    {line.deltaBp === null || state === 'unmapped'
                      ? '—'
                      : formatBp(line.deltaBp, { signed: true })}
                  </td>
                  <td className={`benchmark__state benchmark__state--${state}`}>
                    {t(`budget:benchmark.state.${state}`)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <ul className="benchmark__meta">
        <li>
          {t('budget:benchmark.mapped', {
            share: formatBp(benchmark.mappedShareBp),
            consumption: euro(benchmark.consumptionCents),
          })}
        </li>
        {benchmark.outsideCents === 0 ? null : (
          <li>{t('budget:benchmark.outside', { amount: euro(benchmark.outsideCents) })}</li>
        )}
        {householdLines(household, t).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      {unmapped.length === 0 ? null : (
        <div className="notice notice--warn" role="status">
          <p className="notice__lead">{t('budget:benchmark.unmapped.title')}</p>
          <ul className="notice__list">
            {unmapped.map((category) => (
              <li key={category.categoryId}>
                {t('budget:benchmark.unmapped.line', {
                  name: category.categoryName,
                  value: euro(category.spentCents),
                  share: formatBp(category.shareBp),
                })}
              </li>
            ))}
          </ul>
          <p className="notice__hint">{t('budget:benchmark.unmapped.hint')}</p>
        </div>
      )}

      {/*
        The provenance, always visible rather than behind a disclosure, for the reason
        the tax block gives: a figure nobody can trace is a figure this app made up.
        `transcribed` names the blocks of the file nobody has confirmed against the
        source, which is a weaker claim than the rest of the card and says so.
      */}
      <p className="benchmark__source">
        {t('budget:benchmark.source', {
          citation: source.citation,
          verified: formatDate(source.lastVerified),
        })}
      </p>
      {benchmark.transcribed.length === 0 ? null : (
        <p className="benchmark__source">
          {t('budget:benchmark.transcribed', {
            blocks: formatList(
              benchmark.transcribed.map((block) => t(`budget:benchmark.block.${block}`)),
              language,
            ),
          })}
        </p>
      )}
    </section>
  )
}
