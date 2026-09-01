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
 * Output is shape-level — counts, ranges, field presence. The one exception is
 * the reconciliation section, which prints real totals precisely because the
 * acceptance test is "these agree with Actual's own UI", and that cannot be
 * checked without seeing the numbers.
 */
import {
  actualHealth,
  closeActual,
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
import { probeGhostfolio } from '../src/adapters/ghostfolio/probe.ts'
import { config } from '../src/config.ts'
import { configureFormatting } from '../src/i18n/format-config.ts'
import { formatMoney } from '../src/i18n/format.ts'

let failed = false

const heading = (text: string): void => void process.stdout.write(`\n\x1b[1m${text}\x1b[0m\n`)
const ok = (text: string): void => void process.stdout.write(`  \x1b[32m✓\x1b[0m ${text}\n`)
const warn = (text: string): void => void process.stdout.write(`  \x1b[33m!\x1b[0m ${text}\n`)
const line = (text: string): void => void process.stdout.write(`      ${text}\n`)
function bad(text: string): void {
  failed = true
  process.stdout.write(`  \x1b[31m✗\x1b[0m ${text}\n`)
}

/** Last day of `YYYY-MM`, without pulling in a date library. */
function endOfMonth(month: string): string {
  const year = Number(month.slice(0, 4))
  const monthIndex = Number(month.slice(5, 7))
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, monthIndex, 0)).toISOString().slice(0, 10)
}

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
  if (health.budgetType !== 'rollover') {
    warn(`budget type is "${health.budgetType ?? 'unknown'}", not rollover (envelope)`)
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

  const latest = months.at(-1)
  if (!latest) {
    bad('no budget months — there is nothing to aggregate')
    return
  }
  await reconcile(latest)
}

/**
 * Actual's own `spent` against our AQL recomputation, category by category.
 *
 * Actual's figure is the one Balancr stores, so a gap is not fatal — but it means
 * a hygiene rule (transfers, splits, off-budget, starting balances) disagrees
 * with Actual, and that same rule feeds the baselines and the AI findings.
 */
async function reconcile(month: string): Promise<void> {
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
    return
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
  }
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
