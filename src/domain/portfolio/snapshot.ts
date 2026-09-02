/**
 * Ghostfolio's holdings, turned into rows we own.
 *
 * Why snapshot at all, when Ghostfolio already has this: because every figure on
 * a Balancr page has to be reproducible after the fact. "Net worth on 14 March"
 * has to keep meaning what it meant on 14 March, and Ghostfolio recomputes from
 * today's prices. A stored snapshot also means a Ghostfolio outage degrades to
 * stale-but-labelled figures rather than an empty page.
 *
 * Two conversions happen here and nowhere else:
 *
 *  - **Float to integer cents.** Ghostfolio sends base-currency floats;
 *    `toCents` rounds once, at this boundary, and nothing downstream sees a float.
 *  - **Quantity stays text.** Fractional shares are real and 0.30000000000000004
 *    is what binary floating point does to 0.1 + 0.2. Quantities are never summed
 *    by us — Ghostfolio's own value is what gets added up — so text loses nothing
 *    and keeps what the broker actually said.
 */
import {
  toCents,
  type GhostfolioAccounts,
  type PortfolioDetails,
} from '../../adapters/ghostfolio/types.ts'

export interface HoldingSnapshot {
  date: string
  /**
   * Primary key alongside `date`. ISIN when the data source gives one — it is
   * what a Belgian broker statement and the (deferred) TOB rules key on — and the
   * provider symbol otherwise, so a holding without an ISIN still gets a row
   * rather than being silently dropped.
   */
  instrument: string
  symbol: string | null
  isin: string | null
  name: string | null
  quantity: string
  priceCents: number
  valueCents: number
  currency: string
  /** Ghostfolio's own class labels, kept for the allocation view. */
  assetClass: string | null
  assetSubClass: string | null
}

export function toHoldingSnapshots(
  date: string,
  details: PortfolioDetails,
  baseCurrency: string,
): HoldingSnapshot[] {
  const rows: HoldingSnapshot[] = []

  for (const holding of details.holdings) {
    const price = holding.marketPrice ?? null
    const value = holding.valueInBaseCurrency ?? null
    // `holdingSchema` refuses a position with neither, and says why it refuses the
    // whole payload rather than skipping the row. This narrows that guarantee for
    // the type checker; reaching the throw would mean the schema stopped holding.
    const instrument = holding.isin ?? holding.symbol ?? null
    if (instrument === null || instrument === '') {
      throw new Error('holding reached toHoldingSnapshots with no ISIN and no symbol')
    }
    rows.push({
      date,
      instrument,
      symbol: holding.symbol ?? null,
      isin: holding.isin ?? null,
      name: holding.name ?? null,
      quantity: String(holding.quantity),
      priceCents: price === null ? 0 : toCents(price),
      valueCents: value === null ? 0 : toCents(value),
      // `holding.currency` is the instrument's own currency; the value we store is
      // already in base currency, so labelling the row with the instrument's
      // currency would misdescribe the number next to it. Which is also why that
      // field is optional in the schema — nothing here has ever read it.
      currency: baseCurrency,
      assetClass: holding.assetClass ?? null,
      assetSubClass: holding.assetSubClass ?? null,
    })
  }

  // Two holdings can share an ISIN — the same fund held at two brokers, or a
  // cross-listing. They are the same instrument and one position, so they are
  // merged rather than fighting over the primary key.
  const merged = new Map<string, HoldingSnapshot>()
  for (const row of rows) {
    const seen = merged.get(row.instrument)
    if (!seen) {
      merged.set(row.instrument, row)
      continue
    }
    merged.set(row.instrument, {
      ...seen,
      quantity: String(Number(seen.quantity) + Number(row.quantity)),
      valueCents: seen.valueCents + row.valueCents,
      // The price is per unit and identical for the same instrument; keeping the
      // first is right, and summing it would be nonsense.
      priceCents: seen.priceCents || row.priceCents,
      name: seen.name ?? row.name,
      isin: seen.isin ?? row.isin,
    })
  }

  return [...merged.values()].sort((a, b) => a.instrument.localeCompare(b.instrument))
}

/**
 * The value of each Ghostfolio account, for net worth.
 *
 * `valueInBaseCurrency` includes the positions held in the account;
 * `balance` is only its cash. Preferring the former is what makes a Ghostfolio
 * account comparable with the Actual account that mirrors it — and the fallback
 * matters, because a cash-only account may not report a value at all.
 *
 * `isExcluded` is Ghostfolio's own "leave this out of my portfolio" flag, and it
 * is honoured: overriding a decision the user already made in the other tool
 * would be an unpleasant surprise. `account_map.include_in_net_worth` is the knob
 * for changing it here.
 */
export interface GhostfolioAccountValue {
  externalId: string
  name: string
  valueCents: number
  excluded: boolean
}

export function toAccountValues(accounts: GhostfolioAccounts): GhostfolioAccountValue[] {
  return accounts.accounts.map((account) => ({
    externalId: account.id,
    name: account.name,
    valueCents: toCents(account.valueInBaseCurrency ?? account.balance),
    excluded: Boolean(account.isExcluded),
  }))
}
