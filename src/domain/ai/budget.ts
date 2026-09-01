/**
 * The cost guard.
 *
 * Authentik can stop a stranger reaching the app; it cannot stop the app from
 * spending money, and a surprise bill is the fastest way for a tool like this to
 * be switched off for good. So every call asks this module first.
 *
 * Two rules, both about failure modes:
 *
 *  - **Never fail hard.** Over budget means "serve the last stored answer and say
 *    so", not an error page. The user's data is intact and yesterday's analysis is
 *    still true; refusing to show it would be a worse outcome than the cost.
 *  - **Never silently overspend.** A refusal is recorded as a `capped` run, so the
 *    banner has something to point at and the spend page shows what was skipped.
 *
 * Month-to-date comes from `ai_spend_monthly`, a view over `ai_runs` — the ledger
 * is the only place cost is stored, so there is nothing to reconcile.
 */
import { eq } from 'drizzle-orm'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { aiSpendMonthly } from '../../db/schema.ts'
import { eurToMicroEur, microEurToEur } from '../../adapters/gemini/pricing.ts'

/**
 * The month key the view groups by: a **UTC** month.
 *
 * Deliberately not `currentMonthIn(config.TZ)`, which is what every other month
 * in this codebase means. SQLite has no timezone database, so the view can only
 * group by UTC or by a fixed offset that is wrong half the year — and a budget
 * window that disagrees with the view it reads would be worse than one that
 * resets an hour or two after local midnight on the 1st. The nightly pass runs at
 * 03:00 local, well clear of the boundary either way.
 */
export function spendMonthOf(instant: Date): string {
  return instant.toISOString().slice(0, 7)
}

export interface SpendMonth {
  month: string
  runCount: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  costMicroEur: number
}

const EMPTY_MONTH = (month: string): SpendMonth => ({
  month,
  runCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  costMicroEur: 0,
})

/** One month's totals, straight off the view. Zeroes for a month with no runs. */
export function loadSpendMonth(db: Db, month: string): SpendMonth {
  const row = db.select().from(aiSpendMonthly).where(eq(aiSpendMonthly.month, month)).get()
  if (row === undefined) return EMPTY_MONTH(month)
  return {
    month: row.month,
    runCount: row.runCount,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedTokens: row.cachedTokens,
    costMicroEur: row.costMicroEur,
  }
}

/** Every month with spend, newest first — the history behind the spend page. */
export function loadSpendHistory(db: Db, limit = 24): SpendMonth[] {
  return db
    .select()
    .from(aiSpendMonthly)
    .orderBy(aiSpendMonthly.month)
    .all()
    .slice(-limit)
    .reverse()
}

export interface BudgetState {
  /** The UTC month this state describes. */
  month: string
  spentMicroEur: number
  budgetMicroEur: number
  /** Clamped at zero: an overspend is reported by `exceeded`, not by a negative. */
  remainingMicroEur: number
  /** Share of the budget used, in basis points. 10 000 = the whole budget. */
  usedBp: number
  /** True once the budget is spent. The caller serves cached output and a banner. */
  exceeded: boolean
}

/**
 * Where the month stands.
 *
 * `GEMINI_MONTHLY_BUDGET_EUR=0` means "no AI spend at all" and reads as exceeded
 * from the first call, which is the honest interpretation of a zero budget — the
 * alternative, treating it as unlimited, is the one reading that could produce a
 * bill nobody asked for.
 */
export function budgetState(db: Db, now: Date = new Date()): BudgetState {
  const month = spendMonthOf(now)
  const spentMicroEur = loadSpendMonth(db, month).costMicroEur
  const budgetMicroEur = eurToMicroEur(config.GEMINI_MONTHLY_BUDGET_EUR)

  return {
    month,
    spentMicroEur,
    budgetMicroEur,
    remainingMicroEur: Math.max(0, budgetMicroEur - spentMicroEur),
    usedBp:
      budgetMicroEur === 0
        ? 10_000
        : Math.min(10_000, Math.round((spentMicroEur / budgetMicroEur) * 10_000)),
    exceeded: spentMicroEur >= budgetMicroEur,
  }
}

export interface BudgetDecision {
  allowed: boolean
  state: BudgetState
  /**
   * Why, as a code rather than a sentence: the banner is rendered from the i18n
   * catalogue like every other piece of user-facing text.
   */
  reason: 'ok' | 'month_budget_exceeded' | 'estimate_exceeds_remaining'
}

/**
 * May this call happen?
 *
 * `estimateMicroEur` is checked against what is left, not just against the total.
 * A month at 95% of budget should not be allowed to start a run that costs half
 * the budget again — the estimate is deliberately generous (see
 * `estimateCostMicroEur`), so refusing on it errs toward the banner.
 */
export function checkBudget(
  db: Db,
  estimateMicroEur = 0,
  now: Date = new Date(),
): BudgetDecision {
  const state = budgetState(db, now)
  if (state.exceeded) return { allowed: false, state, reason: 'month_budget_exceeded' }
  if (estimateMicroEur > state.remainingMicroEur) {
    return { allowed: false, state, reason: 'estimate_exceeds_remaining' }
  }
  return { allowed: true, state, reason: 'ok' }
}

/** Euros, for a banner or a log line. Formatting itself belongs to `i18n`. */
export const budgetEur = (state: BudgetState): { spent: number; budget: number } => ({
  spent: microEurToEur(state.spentMicroEur),
  budget: microEurToEur(state.budgetMicroEur),
})
