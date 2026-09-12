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
 *  - **Every unavailability reason draws a notice (#300).** Two of them returned `null`
 *    while this was a card on a long page, and that was right then: `no_file` is a
 *    deployment that ships no benchmark, which is supported and not worth a box under a
 *    month's figures, and `no_month` already had its own notice above it. #230 put the
 *    comparison behind a tab, which inverted both — a reader who clicked *Benchmark* asked
 *    about exactly this absence, and the empty-month notice lives inside the overview
 *    section and is not on screen from here. The hint is therefore per reason rather than
 *    shared: two of the four are the reader's to fix, `no_month` is the month, and
 *    `no_file` is neither — it is a config and log question, so the box says the
 *    comparison is off and sends whoever can act on it to the panel that already explains
 *    it, rather than restating an operator's file path in a budget pane.
 *  - **The basis is a sentence, not a badge.** A `mix` comparison is about how spending is
 *    *divided* and a `level` one about how much is *spent* — see `compare.ts` — and the
 *    euro column means something different in each. A card that did not say which would
 *    invite the stronger conclusion from the weaker comparison, so the lede says it in
 *    words and the reference column is explained rather than labelled.
 *
 * A sixth, added by #323: **the period picker is a page control, not a fact about the
 * data.** `unavailable` carries no `period` field — a mapping problem has nothing to do
 * with the window asked for — so the selected value has to come from the page as a prop,
 * the same arrangement `MonthPicker` already has with `Budget.tsx`'s own `month` state.
 * It is drawn above both branches for that reason: switching away from a mapping problem
 * is exactly the thing a reader who hit one might try first.
 *
 * Nothing here is computed, in keeping with the rest of the page: every figure arrives as
 * an integer. The one arithmetic is basis points into a scale figure, which is the unit
 * conversion `formatBp` does internally and not a number this card decided.
 */
import { useId, type ReactNode } from 'react'
import { Trans } from 'react-i18next'
import { useT, type TFunction } from '../i18n.ts'
import {
  BENCHMARK_PERIODS,
  formatBp,
  formatDate,
  formatDecimal,
  formatList,
  formatMonth,
  MIN_DELTA_BP,
  MIN_MAPPED_BP,
  type BenchmarkGroupLine,
  type BenchmarkPeriodKind,
  type BenchmarkWire,
} from '../shared.ts'
import { Money } from '../ui/Money.tsx'

/** Whole euro, like every other total on this page. Cents on a monthly figure are noise. */
const euro = (cents: number): ReactNode => <Money cents={cents} options={{ whole: true }} />

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

/** A `<select>` value narrowed to a real period, the same guard `SavingsRate` uses. */
function asBenchmarkPeriod(value: string): BenchmarkPeriodKind {
  return (BENCHMARK_PERIODS as readonly string[]).includes(value)
    ? (value as BenchmarkPeriodKind)
    : 'month'
}

export interface BenchmarkProps {
  benchmark: BenchmarkWire
  /** The page's own selection (#323) — not on the wire, since `unavailable` has none. */
  period: BenchmarkPeriodKind
  onPeriodSelect: (period: BenchmarkPeriodKind) => void
}

export function Benchmark({ benchmark, period, onPeriodSelect }: BenchmarkProps): ReactNode {
  const { t, language } = useT()
  const captionId = useId()
  const periodSelectId = useId()

  const picker = (
    <div className="toolbar">
      <div className="field field--inline">
        <label className="field__label" htmlFor={periodSelectId}>
          {t('budget:benchmark.periodLabel')}
        </label>
        <select
          id={periodSelectId}
          className="field__input"
          value={period}
          onChange={(event) => onPeriodSelect(asBenchmarkPeriod(event.target.value))}
        >
          {BENCHMARK_PERIODS.map((option) => (
            <option key={option} value={option}>
              {t(`budget:benchmark.period.${option}`)}
            </option>
          ))}
        </select>
      </div>
    </div>
  )

  if (benchmark.kind === 'unavailable') {
    return (
      <>
        {picker}
        <div className="notice notice--info" role="status">
          <p className="notice__lead">
            {t(`budget:benchmark.unavailable.${benchmark.reason}`, {
              // Only `too_unmapped` prints either of these, and it always has the share —
              // `no_mapping` is zero by construction, and the two reasons that predate any
              // mapping have nothing to report, so the nullable type is the union's rather
              // than this branch's. Passed for all four because an unused variable costs a
              // `t()` call nothing, and a fifth reason that needs one should not have to
              // find its way back in here.
              share: formatBp(benchmark.mappedShareBp ?? 0),
              floor: formatBp(MIN_MAPPED_BP),
            })}
          </p>
          <p className="notice__hint">
            {t(`budget:benchmark.unavailable.hint.${benchmark.reason}`)}
          </p>
        </div>
      </>
    )
  }

  const { groups, household, source, unmapped } = benchmark

  return (
    <>
      {picker}
      <section className="card">
        <h2 className="card__title">{t('budget:benchmark.title')}</h2>

        <p className="benchmark__lede">
          <Trans
            i18nKey={`budget:benchmark.lede.${benchmark.basis}.${benchmark.period}`}
            values={{
              month: formatMonth(benchmark.month, language),
              // The window's own calendar year for `year` — always the anchor month's,
              // since that is what `year` sums from January through.
              year: benchmark.month.slice(0, 4),
              survey: source.survey,
              surveyYear: String(source.year),
            }}
            components={{ money: <Money cents={benchmark.comparedCents} options={{ whole: true }} /> }}
          />
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
          {/*
            Only when the reference side is not counting a whole period: a finished
            month or a finished year needs no caveat, and printing one anyway would
            train the reader to skip it on the months it actually matters (#323).
          */}
          {benchmark.periodProgressBp >= 10_000 ? null : (
            <li>
              {t('budget:benchmark.period.prorated', {
                progress: formatBp(benchmark.periodProgressBp),
              })}
            </li>
          )}
          <li>
            <Trans
              i18nKey="budget:benchmark.mapped"
              values={{ share: formatBp(benchmark.mappedShareBp) }}
              components={{ money: <Money cents={benchmark.consumptionCents} options={{ whole: true }} /> }}
            />
          </li>
          {benchmark.outsideCents === 0 ? null : (
            <li>
              <Trans
                i18nKey="budget:benchmark.outside"
                components={{ money: <Money cents={benchmark.outsideCents} options={{ whole: true }} /> }}
              />
            </li>
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
                  <Trans
                    i18nKey="budget:benchmark.unmapped.line"
                    values={{ name: category.categoryName, share: formatBp(category.shareBp) }}
                    components={{ money: <Money cents={category.spentCents} options={{ whole: true }} /> }}
                  />
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
    </>
  )
}
