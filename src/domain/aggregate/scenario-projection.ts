/**
 * The compounding math behind #51, split out of `scenario.ts` so the browser can
 * import it directly.
 *
 * `scenario.ts`'s `scenarioBaseline` reaches the database (`networth-store.ts`, which
 * imports `config`) to produce the real seed values, and `config` throws at import
 * time on a process with no `.env` — exactly what `custody.ts`'s and `savings.ts`'s
 * split from their own db-touching neighbours already avoids for the same reason (see
 * `web/src/shared.ts`'s own doc comment on `custodyShare`). `projectScenario` has
 * nothing to do with the database, so it lives here instead, with zero non-type
 * imports, and `scenario.ts` re-exports it for the server-side callers that already
 * import it from there.
 */

/** 5%/yr nominal. A documented assumption — see `scenario.ts`'s module comment on why
 *  no real return figure exists to derive this from. Meant to be edited on the page. */
export const DEFAULT_GROWTH_RATE_BP = 500
export const DEFAULT_HORIZON_MONTHS = 120 // 10 years
export const MAX_HORIZON_MONTHS = 360 // 30 years

export interface ScenarioMonth {
  /** 1-indexed months from now. */
  month: number
  /** The "as-is" path: today's contribution, no change. */
  baselineValueCents: number
  /** The "as-is" path plus the change being tested. */
  scenarioValueCents: number
  deltaCents: number
}

export interface ScenarioInput {
  startingValueCents: number
  /** Today's real monthly contribution — unaffected by the change being tested. */
  baselineCents: number
  /** The hypothetical being tested. Can be negative ("what if I invest less"). */
  changeCents: number
  /** true: `changeCents` is added every month. false: a one-time lump sum in month 1. */
  recurring: boolean
  /** Annual, basis points. */
  growthRateBp: number
  horizonMonths: number
}

/** A one-time lump sum is the same compounding loop as a recurring change, just
 *  applied only in month 1 instead of every month — the "natural subset" the plan
 *  for #51 calls for, rather than a second calculation. */
export function projectScenario(input: ScenarioInput): ScenarioMonth[] {
  const monthlyRate = Math.pow(1 + input.growthRateBp / 10_000, 1 / 12) - 1
  const months: ScenarioMonth[] = []
  let baselineValue = input.startingValueCents
  let scenarioValue = input.startingValueCents
  for (let month = 1; month <= input.horizonMonths; month++) {
    const extra = input.recurring || month === 1 ? input.changeCents : 0
    baselineValue = Math.round(baselineValue * (1 + monthlyRate) + input.baselineCents)
    scenarioValue = Math.round(scenarioValue * (1 + monthlyRate) + input.baselineCents + extra)
    months.push({
      month,
      baselineValueCents: baselineValue,
      scenarioValueCents: scenarioValue,
      deltaCents: scenarioValue - baselineValue,
    })
  }
  return months
}
