/**
 * A fund from the universe, as the tax rules see it (#42).
 *
 * The two modules are deliberately separate — the universe is about what may be proposed,
 * the tax rules are about what it costs — and this is the one function that joins them.
 * It exists so that the joining is done once, visibly, with its assumptions named,
 * instead of at each call site where a `debt_claims_percent` would quietly be invented.
 */
import type { FundEntry } from '../universe/schema.ts'
import type { TaxedInstrument } from './estimate.ts'

/**
 * How much of a fund is debt claims, judged from its asset class.
 *
 * A fallback for the funds that do not state it. Bond and cash funds are debt claims
 * essentially by definition; equity, property and commodity funds hold none to speak of.
 * The inference is marked as one on the estimate, and a fund that sits anywhere near the
 * threshold — a mixed fund, most obviously — should carry `debt_claims_percent` in the
 * universe file instead, which is why that field exists.
 */
function debtClaimsFromAssetClass(fund: FundEntry): number {
  switch (fund.asset_class) {
    case 'bond':
    case 'cash':
      return 100
    case 'equity':
    case 'property':
    case 'commodity':
      return 0
  }
}

/**
 * The tax-relevant facts about a fund in the universe.
 *
 * `distribution` is always `accumulating`, because that is all the universe accepts — the
 * schema refuses a distributing share class outright, on the grounds that its dividends
 * carry roerende voorheffing every year for no benefit. It is passed through explicitly
 * rather than assumed, so that relaxing that rule cannot silently change a tax rate.
 *
 * `fsma_registered` is passed through *including its absence*: an unset value has to
 * reach the estimate as unset, so the beurstaks line can come back as a range naming the
 * field. Defaulting it here — in either direction — would be the whole bug this design
 * is built to prevent.
 */
export function taxedInstrumentFromFund(fund: FundEntry): TaxedInstrument {
  const stated = fund.debt_claims_percent
  return {
    kind: 'fund',
    label: fund.name,
    distribution: fund.distribution,
    ...(fund.fsma_registered === undefined ? {} : { fsma_registered: fund.fsma_registered }),
    debt_claims_percent: stated ?? debtClaimsFromAssetClass(fund),
    ...(stated === undefined ? { debt_claims_assumed: true } : {}),
  }
}
