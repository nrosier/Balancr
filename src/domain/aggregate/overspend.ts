/**
 * "Am I overspending?" — five different questions, answered separately.
 *
 * Merging them into one number is the mistake this file exists to avoid. In an
 * envelope budget these routinely disagree, and each disagreement is
 * informative:
 *
 *  - **`over_assigned`** — spent more than was assigned *this month*. Common and
 *    often fine: that is what a carried-over balance is for.
 *  - **`over_available`** — spent past the carry-in too, so the envelope is
 *    genuinely in the red. This is the one that costs money.
 *  - **`above_baseline`** — above your own norm for this category, whatever was
 *    assigned. Catches the envelope that was simply budgeted too generously.
 *  - **`above_benchmark`** — a bigger share of the budget than Belgian
 *    households spend on that line (#43). Group-level and always `info`: it is
 *    context about the country, not evidence about you. See `benchmarkSignals`.
 *  - **`committed_over_available`** — what is still scheduled to leave this month
 *    is more than the envelope has left (#159). The only one of the five that can
 *    fire on an envelope nothing has been spent from yet: €80 assigned, €0 spent,
 *    a €84,50 direct debit due on the 28th. Reported separately and never merged
 *    with the four above, because it is the only forward-looking *certainty* here
 *    — the others describe what happened, and the burn rate is an extrapolation.
 *
 * Every relative signal is gated on an absolute floor. A €7 envelope going 40%
 * over is €2.80: arithmetically true, and noise. Getting flagged for it is how
 * someone learns to ignore the whole panel.
 *
 * Pure. The clock arrives as `monthProgress`, so the burn-rate projection is
 * testable without mocking time.
 */
import { capSeverity, SEVERITY_RANK, type FindingCode, type Severity } from '../ai/codes.ts'
import type { BenchmarkComparison } from '../benchmark/compare.ts'
import { MIN_DELTA_BP } from '../benchmark/vocabulary.ts'
import type { AggregateParams } from './params.ts'
import type { MonthlyFact } from './spend.ts'

export interface Signal {
  code: FindingCode
  /** Null for household-level signals that belong to no single category. */
  categoryId: string | null
  categoryName: string | null
  severity: Severity
  /**
   * The numbers behind the claim, raw: cents as integer cents, ratios as basis
   * points, both spelled out in the key. The renderer formats these into the
   * `vars` that `FINDING_SPECS` declares — this layer never produces a string,
   * so nothing here can end up half-translated.
   */
  metrics: Readonly<Record<string, number>>
}

function signal(
  code: FindingCode,
  fact: MonthlyFact,
  severity: Severity,
  metrics: Record<string, number>,
): Signal {
  return {
    code,
    categoryId: fact.categoryId,
    categoryName: fact.categoryName,
    severity: capSeverity(code, severity),
    metrics,
  }
}

/**
 * The envelope and baseline signals for one month's facts.
 *
 * `monthProgress` is the fraction of the month elapsed in the configured
 * timezone (see `util/month.ts`). Pass 1 for a month that is over, which
 * suppresses the burn-rate projection — projecting a finished month would just
 * restate `over_assigned` in more confident language.
 */
export function categorySignals(
  facts: readonly MonthlyFact[],
  monthProgress: number,
  params: AggregateParams,
): Signal[] {
  const { overspend, burnRate } = params
  const signals: Signal[] = []

  for (const fact of facts) {
    // Income is judged by `income_change` against its own baseline, not by
    // whether it exceeded an envelope: earning more than assigned is not a
    // finding, and the four signals below would all read backwards.
    if (fact.isIncome) continue

    const { spentCents, budgetedCents, availableCents } = fact

    // 1. Over the amount assigned this month.
    const overAssignedCents = spentCents - budgetedCents
    if (budgetedCents > 0 && overAssignedCents >= overspend.materialityFloorCents) {
      signals.push(
        signal('over_assigned', fact, 'warn', {
          spentCents,
          assignedCents: budgetedCents,
          overAssignedCents,
        }),
      )
    }

    // 2. Past the carry-in as well: the envelope is actually in the red. No
    // materiality floor of its own — `availableFloorCents` already is one, and a
    // negative envelope is a fact about the budget rather than an inference.
    if (availableCents < -overspend.availableFloorCents) {
      signals.push(
        signal('over_available', fact, 'alert', {
          availableCents,
          overspendCents: -availableCents,
        }),
      )
    }

    // 5. More still scheduled to leave than the envelope has left (#159).
    // Beside signal 2 because both read `availableCents`, and deliberately not
    // folded into it: a negative envelope is money already gone, this is money
    // that has not moved yet and still will. `committedCents` counts only the
    // occurrences between today and month end, so a past month is always zero
    // here and a finished direct debit stops being a warning the day it posts.
    const committedCents = fact.committedCents
    const committedShortfallCents = committedCents - availableCents
    if (committedCents > 0 && committedShortfallCents >= overspend.materialityFloorCents) {
      signals.push(
        signal('committed_over_available', fact, 'warn', {
          committedCents,
          availableCents,
          committedShortfallCents,
        }),
      )
    }

    // 3. Above your own norm. `deltaBp` is null when the baseline is zero, which
    // is a first-ever expense rather than an overspend — `irregular_expense`.
    const baseline = fact.baseline
    if (baseline) {
      const excessCents = baseline.currentCents - baseline.baselineCents
      if (baseline.deltaBp === null) {
        if (spentCents >= overspend.materialityFloorCents) {
          signals.push(
            signal('irregular_expense', fact, 'info', {
              amountCents: spentCents,
              monthsUsed: baseline.monthsUsed,
            }),
          )
        }
      } else if (
        baseline.deltaBp >= overspend.baselineWarnBp &&
        excessCents >= overspend.materialityFloorCents
      ) {
        signals.push(
          signal(
            'above_baseline',
            fact,
            baseline.deltaBp >= overspend.baselineAlertBp ? 'alert' : 'warn',
            {
              deltaBp: baseline.deltaBp,
              baselineCents: baseline.baselineCents,
              currentCents: baseline.currentCents,
              excessCents,
              windowMonths: baseline.windowMonths,
            },
          ),
        )
      } else if (
        baseline.deltaBp <= -overspend.baselineWarnBp &&
        -excessCents >= overspend.materialityFloorCents
      ) {
        // Good news, and worth saying: a category that quietly halved is the
        // evidence that a change someone made actually worked.
        signals.push(
          signal('below_baseline', fact, 'info', {
            deltaBp: baseline.deltaBp,
            baselineCents: baseline.baselineCents,
            currentCents: baseline.currentCents,
            savedCents: -excessCents,
          }),
        )
      }
    }

    // Burn rate: mid-month projection, so an alert arrives while it can still be
    // acted on rather than as a post-mortem on the 1st.
    //
    // Two halves, because a month's spending is two different things (#159). What
    // is scheduled is *known*, and extrapolating it is what produced the two
    // famous wrong answers: rent paid on the 1st projected to six rents by the
    // 5th, and a subscription due on the 28th projected to nothing at all. So the
    // schedules are added at face value and only the rest of the spending — what
    // no schedule accounts for — is extrapolated over the remaining days:
    //
    //     projected = spent + committed + max(0, spent − committedToDate) × (1/p − 1)
    //
    // With no schedules anywhere both committed figures are zero and this reduces
    // exactly to `spent / p`, which is why an install without schedules sees no
    // change at all. `committedToDateCents` is stored for precisely this line:
    // subtracting it leaves the variable spending, and clamping at zero handles a
    // direct debit that has not posted yet or landed a day early.
    const variableToDateCents = Math.max(0, spentCents - fact.committedToDateCents)
    if (
      monthProgress >= burnRate.minMonthProgress &&
      monthProgress < 1 &&
      budgetedCents > 0 &&
      (spentCents > 0 || committedCents > 0)
    ) {
      const projectedCents =
        spentCents +
        committedCents +
        Math.round(variableToDateCents * (1 / monthProgress - 1))
      const toleranceCents = Math.round(budgetedCents * (1 + burnRate.toleranceBp / 10_000))
      const projectedOverrunCents = projectedCents - budgetedCents
      if (
        projectedCents > toleranceCents &&
        projectedOverrunCents >= overspend.materialityFloorCents
      ) {
        signals.push(
          signal('burn_rate_over', fact, 'warn', {
            projectedCents,
            assignedCents: budgetedCents,
            spentCents,
            committedCents,
            projectedOverrunCents,
            monthProgressBp: Math.round(monthProgress * 10_000),
          }),
        )
      }
    }
  }

  return sortSignals(signals)
}

/**
 * Where your spending sits against what Belgian households spend (#43).
 *
 * Group-level, not category-level, and that is the whole shape of it. The reference is
 * ten published lines of a household budget survey, so the only thing it can be compared
 * with is your spending aggregated the same way — a single envelope has no counterpart in
 * the source, and inventing one per category would be the reference figure divided by
 * however many envelopes somebody happens to keep.
 *
 * Three restraints, and each of them is a decision not to overclaim:
 *
 *  - **Only above, never below.** `above_benchmark` has no opposite in the vocabulary on
 *    purpose. Spending less than average on transport is what not owning a car looks like,
 *    and a page that flagged it would be telling somebody their frugality is a finding.
 *  - **`info`, always.** `capSeverity` enforces it, and `FINDING_SPECS` says why: this is
 *    context. Your own baseline is evidence about you; a national average is evidence
 *    about the country, and it cannot know that you live in Brussels or that your rent
 *    includes heating.
 *  - **Two thresholds, both absolute.** `MIN_DELTA_BP` for the relative gap and the shared
 *    materiality floor for the euros, so a line that is 40% over by €12 stays quiet — the
 *    same rule every other signal in this file is gated on.
 *
 * The group id travels in `categoryName`, which is why this builds its signals literally
 * rather than through `signal()`: there is no `MonthlyFact` behind a group, and `vars.ts`
 * translates the id through the catalogue rather than printing it. `categoryId` stays null
 * for the same reason it is null for a household-level signal — a benchmark line belongs
 * to no single envelope, and attaching it to one would make it show up under that
 * envelope's name on the budget page.
 */
export function benchmarkSignals(
  comparison: BenchmarkComparison,
  params: AggregateParams,
): Signal[] {
  if (comparison.kind !== 'ok') return []
  const { materialityFloorCents } = params.overspend
  const signals: Signal[] = []

  for (const line of comparison.groups) {
    if (line.deltaBp === null) continue
    if (line.deltaBp < MIN_DELTA_BP) continue
    if (line.deltaCents < materialityFloorCents) continue
    signals.push({
      code: 'above_benchmark',
      categoryId: null,
      categoryName: line.group,
      severity: capSeverity('above_benchmark', 'info'),
      metrics: {
        deltaBp: line.deltaBp,
        benchmarkCents: line.benchmarkCents,
        yourCents: line.yourCents,
        excessCents: line.deltaCents,
        referenceShareBp: line.referenceShareBp,
        yourShareBp: line.yourShareBp,
      },
    })
  }

  return sortSignals(signals)
}

/**
 * Alert before warn before info, then by size, then by name.
 *
 * The tail-breakers are not cosmetic: without them the order depends on Map
 * iteration order, and a golden test on the top finding would pass or fail
 * depending on which category happened to be inserted first.
 */
export function sortSignals(signals: readonly Signal[]): Signal[] {
  return [...signals].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (bySeverity !== 0) return bySeverity
    const byMagnitude = signalMagnitude(b) - signalMagnitude(a)
    if (byMagnitude !== 0) return byMagnitude
    return (a.categoryName ?? '').localeCompare(b.categoryName ?? '')
  })
}

/**
 * Largest cents figure in a signal — a rough "how much does this matter".
 *
 * Exported because `domain/ai/findings.ts` breaks its own ties the same way, and
 * two definitions of "which of these matters more" that can disagree would put
 * the caps and the sort order out of step with each other.
 */
export function signalMagnitude(signal: Signal): number {
  let largest = 0
  for (const [name, value] of Object.entries(signal.metrics)) {
    if (name.endsWith('Cents')) largest = Math.max(largest, Math.abs(value))
  }
  return largest
}
