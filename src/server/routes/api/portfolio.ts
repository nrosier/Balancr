/**
 * `GET /api/portfolio` — the latest snapshot, its metrics and the value curve.
 *
 * Read from `portfolio_snapshots` and `portfolio_metrics`, never from Ghostfolio.
 * Which matters more here than anywhere else in the API: Ghostfolio's price
 * provider is the slowest thing in the stack and three of the four endpoints
 * Balancr reads from it are its frontend's internal API. A page that called it on
 * load would be both slow and fragile, and it would call the provider once per
 * refresh of a chart nobody is watching.
 *
 * `twrBp` is Ghostfolio's own reported net performance rather than a figure
 * computed here, and `mwrBp` is deliberately absent until the deferred work lands.
 * Reading it back as zero would be inventing a number, which is the one thing this
 * layer must never do.
 *
 * `advice` is the exception to "read, do not compute", and deliberately so — the reason
 * is in `domain/advice/latest.ts`, which computes it, along with why
 * `portfolio_metrics.drift_json` stays null. It lives there rather than here because the
 * AI bundle asks the same question, and "the narrative's figures match the portfolio
 * page" is only structural while both go through one function (#183).
 *
 * `properties` is the one field on this response that never touches Ghostfolio at all
 * (#227) — deliberately outside `allocation`/`advice`, see `domain/property/vocabulary.ts`.
 * Priced as of the request rather than as of `date`: a mortgage amortizes with the
 * calendar, not with whatever night Ghostfolio's snapshot last ran, and a fresh install
 * with no Ghostfolio holdings at all (`date === null`) still has properties to show.
 *
 * `loans` is the same kind of field for the same reasons (#441) — fixed-schedule car and
 * personal debt, amortized as of the request, with a projected payoff date. Reported
 * beside the properties rather than inside `allocation`: a car loan is not a position
 * `advice/{drift,suggest}.ts` could sell to correct a drift. The subtraction from net
 * worth happens on `/api/overview`, which is the response that has a total to subtract
 * from; here the balance is only ever reported.
 *
 * `debts` is the revolving counterpart (#442) — a credit card, a store card — reported
 * the same way and for the same reason, minus the amortization: a card balance is not
 * priced "as of the request" the way a loan is, so what is sent is simply the stored
 * record with `estimatedMonthlyInterestCents` alongside it.
 *
 * Always the latest snapshot — no `?asOf=` (#345). A picker over Ghostfolio's own
 * history duplicated the Benchmark card's month/year control without its pro-ration,
 * on a page whose whole point is where things stand right now.
 */
import type { Db } from '../../../db/index.ts'
import { integrationAvailability } from '../../../db/tenant-integrations.ts'
import { adviceFor } from '../../../domain/advice/latest.ts'
import { loadOffBudgetAccounts } from '../../../domain/aggregate/networth-store.ts'
import {
  estimatedMonthlyInterestCents,
  listDebts,
  totalDebtBalanceCents,
} from '../../../domain/debt/debts.ts'
import {
  effectiveMonthlyPaymentCents,
  listLoans,
  loanBalanceCents,
  loanPaidOffBp,
  loanPayoffDate,
  totalLoanBalanceCents,
} from '../../../domain/loan/loans.ts'
import { knownSplit } from '../../../domain/portfolio/metrics.ts'
import {
  latestSnapshotDate,
  loadPortfolioMetrics,
  loadPortfolioValueHistory,
  loadSnapshot,
} from '../../../domain/portfolio/store.ts'
import {
  earliestAnchorDate,
  grossYieldBp,
  loadProperties,
  netCashFlowCents,
  outstandingBalanceCents,
  paidOffBp,
  propertyEquityCents,
  totalEquityCents,
} from '../../../domain/property/properties.ts'
import { freshness } from './freshness.ts'
import { portfolioSchema, type Portfolio } from './schemas.ts'

export function buildPortfolio(db: Db, tenantId: string): Portfolio {
  const date = latestSnapshotDate(db, tenantId)
  const metrics = date === null ? null : loadPortfolioMetrics(db, tenantId, date)
  const holdings = date === null ? [] : loadSnapshot(db, tenantId, date)
  const split = knownSplit(metrics)
  const today = new Date().toISOString().slice(0, 10)
  const properties = loadProperties(db, tenantId).properties
  const loans = listLoans(db, tenantId)
  const debts = listDebts(db, tenantId)

  return portfolioSchema.parse({
    freshness: freshness(db, tenantId),
    date,
    totalValueCents: metrics?.totalValueCents ?? null,
    // `loadPortfolioMetrics` reads an absent split back as zero, which is the honest
    // reading of "no invested value recorded" — but on the wire that would draw a
    // card saying nothing is invested. A date whose split adds up to nothing while
    // its total does not is a date that never had one, so it is sent as null and the
    // page shows no split rather than a wrong one.
    ...split,
    twrBp: metrics?.twrBp ?? null,
    allocation: (metrics?.allocation ?? []).map((slice) => ({
      assetClass: slice.key,
      valueCents: slice.valueCents,
      shareBp: slice.shareBp,
    })),
    holdings: holdings
      .map((row) => ({
        instrument: row.instrument,
        symbol: row.symbol,
        isin: row.isin,
        name: row.name,
        quantity: row.quantity,
        priceCents: row.priceCents,
        // Null for rows snapshotted before the column existed. Their native
        // currency was never recorded, so the value currency is the only honest
        // answer left — the same one those rows were rendered with all along.
        priceCurrency: row.priceCurrency ?? row.currency,
        valueCents: row.valueCents,
        currency: row.currency,
      }))
      // Largest first: a holdings table is read to see what dominates.
      .sort((a, b) => b.valueCents - a.valueCents),
    // The whole curve, unconditionally: the chart's whole point is the trend up to now.
    history: loadPortfolioValueHistory(db, tenantId),
    // Against today's risk profile even when `metrics`/`holdings` are historical — there
    // is no historical profile to compare against, so "what would today's bands have
    // said back then" is the only reading available.
    advice: adviceFor(db, tenantId, metrics, split.investedValueCents, holdings),
    properties: properties.map((property) => ({
      id: property.id,
      kind: property.kind,
      label: property.label,
      propertyValueCents: property.propertyValueCents,
      // Priced as of the request (`today`), never as of `date` — see the file doc
      // comment (#227): mortgages amortize with the calendar, not with the snapshot.
      mortgageBalanceCents: outstandingBalanceCents(property.mortgages, today),
      // The earliest re-anchor point the estimate above amortizes forward from (#392,
      // #393), so the client can label it as an estimate rather than implying it's
      // straight off a statement.
      mortgageAnchorDate: earliestAnchorDate(property.mortgages),
      mortgagePaidOffBp: paidOffBp(property.mortgages, today),
      equityCents: propertyEquityCents(property, today),
      rentCents: property.rentCents,
      netCashFlowCents: netCashFlowCents(property),
      grossYieldBp: grossYieldBp(property),
    })),
    totalPropertyEquityCents: totalEquityCents(properties, today),
    // Fixed-schedule non-mortgage debt (#441), priced as of the request like the
    // properties above and for the same reason. `payoffDate` is a projection of the
    // stored schedule, not a promise — see `monthsToPayoff`.
    loans: loans.map((loan) => ({
      id: loan.id,
      kind: loan.kind,
      label: loan.label,
      openingDate: loan.openingDate,
      balanceCents: loanBalanceCents(loan, today),
      anchorDate: loan.anchorDate,
      paidOffBp: loanPaidOffBp(loan, today),
      // The effective payment, extra included: what the table is read for is what
      // actually leaves the account each month.
      monthlyPaymentCents: effectiveMonthlyPaymentCents(loan),
      rateBp: loan.rateBp,
      payoffDate: loanPayoffDate(loan),
    })),
    totalLoanBalanceCents: totalLoanBalanceCents(loans, today),
    // Revolving debt (#442), reported the same way and for the same reason as loans,
    // minus the amortization: `balanceCents` is the stored figure itself, never priced
    // forward from a date.
    debts: debts.map((debt) => ({
      id: debt.id,
      kind: debt.kind,
      label: debt.label,
      balanceCents: debt.balanceCents,
      minimumPaymentCents: debt.minimumPaymentCents,
      aprBp: debt.aprBp,
      estimatedMonthlyInterestCents: estimatedMonthlyInterestCents(debt),
    })),
    totalDebtBalanceCents: totalDebtBalanceCents(debts),
    // Every off-budget account, any kind — the full list `netWorth.liquidOffBudgetCents`
    // (on `overviewSchema`) only summarizes the liquid slice of (#353).
    offBudgetAccounts: loadOffBudgetAccounts(db, tenantId).map((account) => ({
      id: account.accountMapId,
      name: account.name,
      balanceCents: account.balanceCents,
      currency: account.currency,
    })),
    ghostfolioConfigured: integrationAvailability(db, tenantId).ghostfolio,
  })
}
