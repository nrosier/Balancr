/**
 * How long a class has been outside its band, and the finding that says so (#183).
 *
 * The portfolio page already states today's drift: `EQUITY` is 76%, its ceiling is 65%,
 * here is the trade that would close it. What no screen states is that the same sentence
 * was true in August and in July. That is the fact worth a line on the insights page, and
 * the one a monthly narrative can actually use — "the surplus went to cash again, and
 * bonds are still under their floor" is a claim about a pattern, which is the thing a
 * language model is good at and a threshold is not.
 *
 * Four decisions, and the second and third are the ones to disagree with:
 *
 *  - **Today's figures come from the live report, the count from the history.** A
 *    `PersistentLine` is a `DriftLine` plus `monthsOutside`: the share, the band and the
 *    distance are the report `GET /api/portfolio` computed, so the number on the insights
 *    page is the number on the portfolio page rather than a second reading of the same
 *    snapshot. Only the count is derived here.
 *  - **Measured against today's bands, for every month.** The profile is not versioned
 *    and a band edited last week has no history, so the honest statement is "given the
 *    profile you have now, this class has been outside it for three months" — not "it was
 *    outside whatever the profile said at the time", which nothing stored can support.
 *    A band widened this morning therefore resets a run, which is correct: the household
 *    has just said that share is acceptable.
 *  - **A month nobody can measure ends the run.** A month with no metrics row at all, or
 *    one whose invested/cash split was never recorded, is not a month in which nothing
 *    drifted — it is a month nobody looked at. Both have to *end* the count rather than
 *    be skipped over, which is the whole difference between a run of one and a run of
 *    four on an instance whose snapshots were backfilled.
 *  - **The same side, or it is not the same drift.** A class that was below its floor in
 *    July and is above its ceiling in September has not persisted at anything; it has
 *    overshot, and calling that three months of the same problem would describe the
 *    opposite of what happened.
 *
 * Pure: a drift report, a series of month-end allocations and the bands go in, counts
 * come out. The reading is `bundle.ts`'s and the route's.
 */
import { addMonths } from '../../util/month.ts'
import { capSeverity, type Severity } from '../ai/codes.ts'
import type { AggregateParams } from '../aggregate/params.ts'
import type { Signal } from '../aggregate/overspend.ts'
import { driftReport, type AllocationInput, type DriftLine, type DriftState } from './drift.ts'
import type { Bands, ProfileId } from './profile.ts'

/** One month-end observation: what the portfolio held, and what it was worth invested. */
export interface AllocationMonth {
  /** `YYYY-MM`. The month, not the snapshot date — one observation per month. */
  readonly month: string
  readonly allocation: readonly AllocationInput[]
  /**
   * The denominator the shares are shares of.
   *
   * Zero means the split was never recorded for that month, which is not the same as a
   * portfolio worth nothing: measuring shares against a missing invested value would put
   * every class at 0% and below its floor. Such a month ends the count — see the file
   * comment.
   */
  readonly investedValueCents: number
}

export interface PersistentLine extends DriftLine {
  /**
   * Consecutive month-end observations, ending at the newest, in which this class was
   * outside its band on this side. 1 means only now.
   */
  readonly monthsOutside: number
}

export interface DriftPersistence {
  /** One line per band class, in the drift report's own order — worst first. */
  readonly lines: readonly PersistentLine[]
  readonly profile: ProfileId
  /** Whether the bands are still exactly the preset they are named after. */
  readonly isPreset: boolean
  /**
   * How many month ends, counting back from the newest, could be measured at all.
   *
   * The ceiling on how high a `monthsOutside` could have gone, which is what stops
   * "outside for one month" reading as good news on an instance that has only ever had
   * one snapshot. Today's own reading always counts for one on top of it, so a line
   * outside its band reports 1 even where this is 0.
   */
  readonly monthsObserved: number
}

export interface PersistenceInput {
  /** Today's report, from `buildAdvice` — the figures the portfolio page shows. */
  readonly drift: { readonly lines: readonly DriftLine[] }
  /** Month-end observations, oldest first, the newest being the current month. */
  readonly history: readonly AllocationMonth[]
  readonly bands: Bands
  readonly profile: ProfileId
  readonly isPreset: boolean
}

/**
 * The state of each class at each month end that can be read, newest first, stopping at
 * the first one that cannot.
 *
 * A chain rather than a filtered list, and that is the whole subtlety: filtering the
 * unreadable months out makes the ones either side of a hole adjacent, so a count of
 * "consecutive from the newest" runs straight through it. Two things break the chain, and
 * they are the same mistake twice — a month nobody snapshotted (absent from `history`
 * entirely, hence the calendar check rather than a length one) and a month whose invested
 * value was never recorded. Neither is evidence about a band.
 *
 * `history` is oldest first, so it is walked in reverse; the newest entry starts the chain
 * wherever it falls, because a portfolio last synced in July is still three readings even
 * when today is September.
 */
function measurableChain(input: PersistenceInput): Map<string, DriftState>[] {
  const chain: Map<string, DriftState>[] = []
  let expected: string | null = null

  for (const month of [...input.history].reverse()) {
    if (expected !== null && month.month !== expected) break
    if (month.investedValueCents <= 0) break
    const report = driftReport(month.allocation, input.bands, month.investedValueCents)
    chain.push(new Map(report.lines.map((line) => [line.assetClass, line.state])))
    expected = addMonths(month.month, -1)
  }

  return chain
}

/**
 * Today's drift, with how long each line has looked like this.
 *
 * `monthsOutside` is 1 for a class that only left its band this month and 0 for one
 * inside it — 0 rather than 1, because "inside its band" is not a duration and a caller
 * filtering on a threshold should not have to special-case the state as well.
 */
export function driftPersistence(input: PersistenceInput): DriftPersistence {
  const months = measurableChain(input)

  const lines = input.drift.lines.map((line): PersistentLine => {
    if (line.state === 'inside') return { ...line, monthsOutside: 0 }
    let monthsOutside = 0
    for (const observation of months) {
      if (observation.get(line.assetClass) !== line.state) break
      monthsOutside += 1
    }
    // The live report is the authority on today, and it may disagree with the newest
    // observation: the profile can have been edited since the snapshot was taken, and a
    // widened band means the class is inside now whatever it was this morning. A line
    // outside the band with no matching observation is still outside it for one month.
    return { ...line, monthsOutside: Math.max(monthsOutside, 1) }
  })

  return {
    lines,
    profile: input.profile,
    isPreset: input.isPreset,
    monthsObserved: months.length,
  }
}

// ---------------------------------------------------------------------------
//  The finding
// ---------------------------------------------------------------------------

/**
 * Two codes rather than one `drift_persistent`, and the reason is the sentence.
 *
 * "Bonds have been under their floor of 20% for three months, at 12%" and "equities have
 * been over their ceiling of 65% for three months, at 76%" name different edges and
 * suggest opposite actions. One code would have to say "outside its band", which drops
 * the only part a reader can act on, or carry a direction variable, which is a second
 * sentence hidden inside one catalogue entry — and the renderers would each need a
 * special case for it, as `never_reconciled` already shows.
 */
const CODE_FOR: Readonly<Record<'above' | 'below', 'drift_above_band' | 'drift_below_band'>> = {
  above: 'drift_above_band',
  below: 'drift_below_band',
}

/**
 * A finding per class that has been outside its band for long enough.
 *
 * `warn`, not `alert` and not `info`. Unlike `above_benchmark` — where the reference is a
 * national average and the household never agreed to it — a band is a number this
 * household set, so months spent outside it is a drift from a stated intention rather
 * than context about the country. And unlike an overspend, no money has been lost: the
 * position is worth what it is worth, and the cost of leaving it is a risk profile that
 * is not the one on the settings page.
 *
 * Nothing is emitted before `persistentMonths` observations, which is what keeps this off
 * the insights page for a drift the portfolio page is already showing. A single month
 * outside a band is what a market does; three is a decision not to rebalance.
 */
export function driftSignals(
  persistence: DriftPersistence | null,
  params: AggregateParams,
): Signal[] {
  if (persistence === null) return []
  const { persistentMonths } = params.drift
  const signals: Signal[] = []

  for (const line of persistence.lines) {
    if (line.state === 'inside') continue
    if (line.monthsOutside < persistentMonths) continue
    const code = CODE_FOR[line.state]
    const severity: Severity = capSeverity(code, 'warn')
    signals.push({
      code,
      // No category and no account: an asset class is neither, and the label is the
      // class itself — a fixed enum, translated on the way to a screen, never user text.
      categoryId: null,
      categoryName: line.assetClass,
      severity,
      metrics: {
        monthsOutside: line.monthsOutside,
        shareBp: line.shareBp,
        minBp: line.minBp,
        targetBp: line.targetBp,
        maxBp: line.maxBp,
        outsideBp: line.outsideBp,
        driftBp: line.driftBp,
        // Signed as `drift.ts` defines it — positive means short of target — and the
        // one metric here whose key ends in `Cents`, so `sortSignals` ranks two drifts
        // by the money in the wrong place rather than by asset-class name.
        gapCents: line.gapCents,
      },
    })
  }

  return signals
}
