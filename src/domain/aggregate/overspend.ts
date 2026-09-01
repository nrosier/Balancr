/**
 * "Am I overspending?" — four different questions, answered separately.
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
 *  - **`above_benchmark`** — above what a comparable household spends. Stubbed
 *    until the Statbel model lands; see `benchmarkSignals`.
 *
 * Every relative signal is gated on an absolute floor. A €7 envelope going 40%
 * over is €2.80: arithmetically true, and noise. Getting flagged for it is how
 * someone learns to ignore the whole panel.
 *
 * Pure. The clock arrives as `monthProgress`, so the burn-rate projection is
 * testable without mocking time.
 */
import { capSeverity, SEVERITY_RANK, type FindingCode, type Severity } from '../ai/codes.ts'
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
    if (
      monthProgress >= burnRate.minMonthProgress &&
      monthProgress < 1 &&
      budgetedCents > 0 &&
      spentCents > 0
    ) {
      const projectedCents = Math.round(spentCents / monthProgress)
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
 * External-benchmark comparison. Returns nothing in v1, by design.
 *
 * The comparison the app was asked for — against median spending for a Belgian
 * single-parent household with joint custody of one teenager — needs a Statbel
 * HBS mapping plus an equivalence scale, and neither can be invented here. The
 * code exists in the vocabulary and this is where it will be produced, so the
 * gap is visible in the source rather than implied by its absence. Returning an
 * empty array keeps every caller and chart already written for it correct.
 */
export function benchmarkSignals(): Signal[] {
  return []
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
    const byMagnitude = magnitude(b) - magnitude(a)
    if (byMagnitude !== 0) return byMagnitude
    return (a.categoryName ?? '').localeCompare(b.categoryName ?? '')
  })
}

/** Largest cents figure in a signal — a rough "how much does this matter". */
function magnitude(signal: Signal): number {
  let largest = 0
  for (const [name, value] of Object.entries(signal.metrics)) {
    if (name.endsWith('Cents')) largest = Math.max(largest, Math.abs(value))
  }
  return largest
}
