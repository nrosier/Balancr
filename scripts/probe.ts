#!/usr/bin/env tsx
/**
 * `npm run probe` — validates Balancr against the real Actual and Ghostfolio.
 *
 * Both upstreams are moving targets: Actual's API is a version-pinned local sync
 * engine, and three of the four Ghostfolio endpoints Balancr reads are its
 * frontend's internal API. Neither can be verified from a unit test, so this
 * exists to be run after every upgrade of either — before a cron job discovers
 * the problem at 3am and writes a wrong number into the database.
 *
 * It reads only. Nothing here writes to either upstream or to Balancr's own
 * database, so it is safe to run against production data.
 *
 * Output is shape-level — counts, ranges, field presence. The two reconciliation
 * sections are the exception, and they print real totals precisely because the
 * acceptance test is "these agree with the other tool's own UI" (#46), and that
 * cannot be checked without seeing the numbers. So: read the output, do not paste
 * it anywhere. The figures below are the household's, not example data.
 */
import {
  actualHealth,
  closeActual,
  ENVELOPE_BUDGET_TYPES,
  syncActual,
} from '../src/adapters/actual/client.ts'
import {
  fetchAccounts as fetchActualAccounts,
  fetchBudgetMonth,
  fetchBudgetMonths,
  fetchCategories,
  fetchCategoryGroups,
  fetchRecomputedSpend,
  fetchTransactionDateRange,
} from '../src/adapters/actual/queries.ts'
import {
  fetchAccounts as fetchGhostfolioAccounts,
  fetchPortfolioDetails,
} from '../src/adapters/ghostfolio/client.ts'
import { probeGhostfolio } from '../src/adapters/ghostfolio/probe.ts'
import { toCents } from '../src/adapters/ghostfolio/types.ts'
import { config } from '../src/config.ts'
import { computePortfolioMetrics } from '../src/domain/portfolio/metrics.ts'
import {
  toAccountValues,
  toHoldingSnapshots,
} from '../src/domain/portfolio/snapshot.ts'
import { configureFormatting } from '../src/i18n/format-config.ts'
import { formatMoney } from '../src/i18n/format.ts'
import { currentMonthIn, endOfMonth, todayIn } from '../src/util/month.ts'

let failed = false

const heading = (text: string): void => void process.stdout.write(`\n\x1b[1m${text}\x1b[0m\n`)
const ok = (text: string): void => void process.stdout.write(`  \x1b[32m✓\x1b[0m ${text}\n`)
const warn = (text: string): void => void process.stdout.write(`  \x1b[33m!\x1b[0m ${text}\n`)
const line = (text: string): void => void process.stdout.write(`      ${text}\n`)
function bad(text: string): void {
  failed = true
  process.stdout.write(`  \x1b[31m✗\x1b[0m ${text}\n`)
}

/**
 * How many months the acceptance test reconciles (#46).
 *
 * Three rather than one, because the three failure modes that matter are only
 * visible over a span: a rule that mishandles a month with a transfer in it, a
 * carryover that drifts as it is rolled forward, and a category renamed
 * mid-quarter. One month passing says the arithmetic works on one month.
 */
const RECONCILED_MONTHS = 3

/**
 * Cents of slack that rounding at the boundary can legitimately produce.
 *
 * `toCents` rounds each holding's base-currency float once, so a portfolio of `n`
 * of them can sit up to `n / 2` cents away from a total Ghostfolio rounded a
 * single time. That is the only difference #46's third box accepts — anything
 * wider is a hygiene bug — which is why the bound is derived from the number of
 * roundings rather than picked as a tolerance.
 */
const roundingSlackCents = (roundings: number): number => Math.max(1, Math.ceil(roundings / 2))

async function probeActual(): Promise<void> {
  heading('Actual Budget')

  // The first call opens and downloads the budget; everything after is cheap.
  await syncActual()
  const health = actualHealth()
  ok(`connected — server ${health.serverVersion ?? 'unknown'}, api ${health.apiVersion}`)
  if (!health.versionAligned) {
    warn(
      `@actual-app/api ${health.apiVersion} does not match server ` +
        `${health.serverVersion ?? '?'} — pin the package to the server release`,
    )
  }
  // Both spellings, through the set the adapter already keeps: Actual renamed
  // `rollover` to `envelope`, and testing the old name alone warned that an envelope
  // budget was not one — on the very configuration this endorses. The server side of
  // that was fixed when the set was introduced; the probe kept its own copy of the
  // old check, and the acceptance test (#46) is what caught it against a live 26.9.
  if (health.budgetType === null || !ENVELOPE_BUDGET_TYPES.has(health.budgetType)) {
    warn(
      `budget type is "${health.budgetType ?? 'unknown'}", not envelope — the carryover ` +
        'figures Balancr reads are not what a tracking budget means by them',
    )
  }
  if (health.currencyCode && health.currencyCode !== config.BASE_CURRENCY) {
    warn(
      `budget currency ${health.currencyCode} differs from BASE_CURRENCY ` +
        `${config.BASE_CURRENCY} — no FX conversion exists yet`,
    )
  }

  const accounts = await fetchActualAccounts()
  const categories = await fetchCategories()
  const groups = await fetchCategoryGroups()
  const months = await fetchBudgetMonths()
  const range = await fetchTransactionDateRange()

  const offBudget = accounts.filter((a) => a.offbudget).length
  ok(`${accounts.length} accounts — ${accounts.length - offBudget} on-budget, ${offBudget} off-budget`)
  ok(`${categories.length} categories in ${groups.length} groups (${categories.filter((c) => c.hidden).length} hidden)`)
  ok(`${months.length} budget months: ${months.at(0) ?? '-'} … ${months.at(-1) ?? '-'}`)
  ok(`transactions span ${range.first ?? '-'} … ${range.last ?? '-'}`)

  const neverReconciled = accounts.filter((a) => !a.closed && !a.last_reconciled).length
  if (neverReconciled > 0) {
    warn(`${neverReconciled} open accounts have never been reconciled`)
  }

  // Months that have started, newest last. Actual's budget file runs ahead of the
  // calendar, so the last entry of `getBudgetMonths()` is routinely a month with no
  // transactions in it — which reconciles trivially and proves nothing.
  const started = months.filter((month) => month <= currentMonthIn(config.TZ))
  if (started.length === 0) {
    bad('no budget month has started yet — there is nothing to aggregate')
    return
  }
  const window = started.slice(-RECONCILED_MONTHS)
  if (window.length < RECONCILED_MONTHS) {
    warn(`only ${window.length} of ${RECONCILED_MONTHS} months exist to reconcile`)
  }

  const results: MonthReconciliation[] = []
  for (const month of window) results.push(await reconcile(month))

  heading('Reconciliation — verdict')
  const drifted = results.filter((result) => result.drift > 0)
  const compared = results.reduce((sum, result) => sum + result.categories, 0)
  if (drifted.length === 0) {
    ok(`${results.length} months, ${compared} category totals, no disagreement`)
    return
  }
  // Fails the probe rather than warning, on #46's third box: a category total that
  // differs from Actual's own is a hygiene bug, not a rounding issue. The per-month
  // sections above name the categories; this is the exit code.
  bad(
    `${drifted.length} of ${results.length} months disagree with our recomputation ` +
      `(${drifted.map((result) => `${result.month}: ${result.drift}`).join(', ')})`,
  )
}

/** What one month's reconciliation found, for the verdict at the end. */
interface MonthReconciliation {
  month: string
  /** Category totals compared. */
  categories: number
  /** How many of them disagreed. */
  drift: number
}

/**
 * Actual's own `spent` against our AQL recomputation, category by category.
 *
 * Actual's figure is the one Balancr stores, so a gap is not fatal — but it means
 * a hygiene rule (transfers, splits, off-budget, starting balances) disagrees
 * with Actual, and that same rule feeds the baselines and the AI findings.
 */
async function reconcile(month: string): Promise<MonthReconciliation> {
  heading(`Reconciliation — ${month}`)

  const budget = await fetchBudgetMonth(month)
  const rows = await fetchRecomputedSpend(`${month}-01`, endOfMonth(month))

  ok(
    `Actual reports income ${formatMoney(budget.totalIncomeCents)}, ` +
      `spent ${formatMoney(budget.totalSpentCents)}, ` +
      `assigned ${formatMoney(budget.totalBudgetedCents)}`,
  )

  const mine = new Map<string | null, number>()
  for (const row of rows.filter((r) => r.month === month)) {
    mine.set(row.categoryId, (mine.get(row.categoryId) ?? 0) + row.amountCents)
  }

  const uncategorised = mine.get(null)
  if (uncategorised !== undefined && uncategorised !== 0) {
    warn(`${formatMoney(-uncategorised)} of activity has no category this month`)
  }

  const drift = budget.categories
    .map((category) => {
      // `amountCents` is signed as Actual stores it (expenses negative), while
      // `spentCents` is positive-out. Flip expenses to compare like with like.
      const signed = mine.get(category.categoryId) ?? 0
      return {
        name: category.categoryName,
        theirs: category.spentCents,
        ours: category.isIncome ? signed : -signed,
      }
    })
    .filter((c) => c.theirs !== c.ours)

  if (drift.length === 0) {
    ok(`all ${budget.categories.length} category totals match our recomputation`)
    return { month, categories: budget.categories.length, drift: 0 }
  }

  warn(
    `${drift.length} of ${budget.categories.length} categories differ from our ` +
      `recomputation — this is the hygiene bug to fix before trusting any chart:`,
  )
  for (const c of drift.slice(0, 10)) {
    line(
      `${c.name}: Actual ${formatMoney(c.theirs)}, ours ${formatMoney(c.ours)} ` +
        `(${formatMoney(c.ours - c.theirs, { signed: true })})`,
    )
  }
  if (drift.length > 10) line(`… and ${drift.length - 10} more`)
  return { month, categories: budget.categories.length, drift: drift.length }
}

/**
 * The portfolio total Balancr would store, against the figure Ghostfolio's own
 * dashboard prints (#46).
 *
 * Same call, same functions and same rounding as `jobs/portfolio.ts`: the point is
 * not that a total can be added up, it is that the total Balancr *persists* is the
 * one the household already believes. `computePortfolioMetrics` states in so many
 * words that `totalValueCents` counts cash at the broker "because that is the
 * figure that reconciles against the Ghostfolio dashboard" — this is where that
 * claim gets checked instead of asserted.
 *
 * Four comparisons, and they fail differently:
 *
 *  - **The three halves of the summary** — total, invested and cash, each against
 *    the Ghostfolio field that means the same thing. Split rather than checked as
 *    one total because the halves are where a mistake actually lives: a cash
 *    position counted as an investment leaves the total right and every allocation
 *    share wrong, and one figure would pass. A real gap fails the probe.
 *  - **Against Ghostfolio's accounts** — the account values are what net worth is
 *    built from (`toAccountValues` → `account_map` → `computeNetWorth`), while the
 *    holdings are what the portfolio page shows. They cover the same money by two
 *    routes, so a gap means the two Balancr pages disagree with each other. It
 *    warns rather than fails: cash the two views count differently, and accounts
 *    excluded in Ghostfolio, are legitimate reasons for the difference, and only a
 *    person looking at the dashboard can say which it is.
 *
 * The field names are worth stating once, because the obvious one is a trap:
 * `currentValueInBaseCurrency` is the **investments**, not the portfolio, and
 * reading it as the total reports every instance whose Ghostfolio holds cash as
 * broken by exactly the cash. `totalValueInBaseCurrency` is the total.
 *
 * Read-only, like everything else here: nothing is written, and no `account_map`
 * is consulted, so this runs against production with no local database at all.
 */
/**
 * One of our figures against Ghostfolio's own, with rounding accounted for.
 *
 * A missing field warns rather than fails: three of the four endpoints here are an
 * unversioned internal API, so a renamed key is a thing to go and look at, not a
 * wrong number. A field that is present and disagrees is the wrong number.
 */
function reconcileFigure(
  what: string,
  ours: number,
  theirs: number | null | undefined,
  roundings: number,
): void {
  if (theirs === null || theirs === undefined) {
    warn(
      `Ghostfolio sent no ${what} figure — nothing to reconcile against, so compare ` +
        "the dashboard's own by hand and check whether this release renamed the field",
    )
    return
  }
  const gap = ours - toCents(theirs)
  const slack = roundingSlackCents(roundings)
  if (Math.abs(gap) <= slack) {
    ok(
      `${what} agrees with Ghostfolio, inside the ${slack} ` +
        `cent${slack === 1 ? '' : 's'} rounding can account for`,
    )
    return
  }
  bad(
    `${what}: Ghostfolio reports ${formatMoney(toCents(theirs))} and we derive ` +
      `${formatMoney(ours)} (${formatMoney(gap, { signed: true })}) — too wide for ` +
      'rounding, so a holding is being dropped, double-counted, classed as the wrong ' +
      'thing or valued in the wrong currency',
  )
}

async function reconcileNetWorth(): Promise<void> {
  heading('Reconciliation — net worth')

  const date = todayIn(config.TZ)
  const details = await fetchPortfolioDetails()
  const holdings = toHoldingSnapshots(date, details, config.BASE_CURRENCY)
  // No performance: `twrBp` is not part of any total, and fetching it would make a
  // reconciliation depend on the one endpoint the nightly job already tolerates
  // losing.
  const metrics = computePortfolioMetrics(date, holdings, null)

  ok(
    `we derive ${formatMoney(metrics.totalValueCents)} from ${holdings.length} holdings — ` +
      `${formatMoney(metrics.investedValueCents)} invested, ` +
      `${formatMoney(metrics.cashValueCents)} cash at the broker`,
  )

  const summary = details.summary
  // The total first, then its two halves. All three, because the total agreeing while
  // the split is wrong is a real state and the one that misprices every band share.
  reconcileFigure('portfolio', metrics.totalValueCents, summary?.totalValueInBaseCurrency, holdings.length)
  reconcileFigure('invested', metrics.investedValueCents, summary?.currentValueInBaseCurrency, holdings.length)
  reconcileFigure('broker cash', metrics.cashValueCents, summary?.totalCashInBaseCurrency, holdings.length)

  const accounts = toAccountValues(await fetchGhostfolioAccounts())
  const counted = accounts.filter((account) => !account.excluded)
  const countedCents = counted.reduce((sum, account) => sum + account.valueCents, 0)
  const excluded = accounts.filter((account) => account.excluded)
  const excludedCents = excluded.reduce((sum, account) => sum + account.valueCents, 0)

  const accountGap = countedCents - metrics.totalValueCents
  if (Math.abs(accountGap) <= roundingSlackCents(counted.length)) {
    ok(`${counted.length} accounts add up to the same total, so net worth will agree with it`)
  } else {
    warn(
      `${counted.length} accounts add up to ${formatMoney(countedCents)}, ` +
        `${formatMoney(accountGap, { signed: true })} from the holdings total — net worth is ` +
        'built from the accounts and the portfolio page from the holdings, so check the ' +
        'dashboard before believing either',
    )
  }
  if (excluded.length > 0) {
    line(
      `${excluded.length} accounts are excluded in Ghostfolio (${formatMoney(excludedCents)}), ` +
        'and Balancr honours that flag',
    )
  }
}

async function probeGhostfolioSide(): Promise<void> {
  heading('Ghostfolio')
  const report = await probeGhostfolio()

  for (const check of report.checks) {
    if (check.status === 'ok') ok(`${check.path} — ${check.detail}`)
    else bad(`${check.path} [${check.status}] ${check.error ?? ''}`)
  }
  for (const warning of report.warnings) warn(warning)

  if (report.status === 'shape-mismatch') {
    bad('update src/adapters/ghostfolio/types.ts for this Ghostfolio version')
    return
  }
  if (report.status !== 'ok') return
  // Only once every endpoint parsed. Reconciling against a payload we already know
  // we misread would compare two of our own misreadings and call them agreement.
  await reconcileNetWorth()
}

async function main(): Promise<void> {
  configureFormatting({
    formatLocale: config.FORMAT_LOCALE,
    currency: config.BASE_CURRENCY,
    timeZone: config.TZ,
  })

  // Sequential: interleaved stdout is unreadable, and the Actual adapter
  // serialises its operations anyway.
  try {
    await probeActual()
  } catch (error) {
    bad(`Actual probe failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    // Leaving the budget open holds a lock on dataDir that the running container
    // needs.
    await closeActual()
  }

  try {
    await probeGhostfolioSide()
  } catch (error) {
    bad(`Ghostfolio probe failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  process.stdout.write(
    failed
      ? '\n\x1b[31mProbe failed.\x1b[0m Fix the items above before trusting any figure.\n'
      : '\n\x1b[32mProbe passed.\x1b[0m\n',
  )
  process.exit(failed ? 1 : 0)
}

await main()
