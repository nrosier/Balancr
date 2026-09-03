/**
 * What a trade actually costs in Belgian tax, in euros, on the transaction (#42).
 *
 * The issue asks for tax "shown as euros on a concrete transaction, not as a percentage
 * in prose", and that phrasing is the whole design. "Belgian ETFs carry 1.32% beurstaks"
 * is a sentence somebody has to do arithmetic on before it changes a decision; "€ 13,20
 * beurstaks on this € 1.000 purchase, at 1.32%, capped at € 4.000, per WDRT art. 1262,
 * checked on 2026-09-03" is the decision. Everything here exists to produce the second
 * kind of line and to refuse to fake it.
 *
 * Three rules it keeps:
 *
 *  - **A missing fact is never a guess.** Whether a fund is registered for public
 *    distribution in Belgium decides between 0.12% and 1.32% — a factor of eleven — and
 *    it cannot be derived from the ISIN, the domicile or the exchange. When the universe
 *    entry does not say, the line comes back as a *range* with the field to fill in
 *    named, because "between € 1,20 and € 13,20, depending on whether it is registered"
 *    is both honest and actionable, where either single number is neither.
 *  - **Every figure carries where it came from.** Each line's `basis` holds the rate in
 *    basis points, the cap, the citation, the verification date and whether anybody has
 *    checked that citation. A number on screen without those is a number nobody can
 *    argue with, which is the opposite of useful for tax.
 *  - **An assumption is recorded, not absorbed.** Estimating capital-gains tax needs to
 *    know how much of this year's exemption is left; when nobody has said, the estimate
 *    assumes all of it and puts `full_annual_exemption` on the line, so the caller can
 *    say so rather than presenting the best case as the case.
 *
 * The rates themselves are nowhere in this file. They arrive as a `Ruleset` read from the
 * dated rules file, which is what makes a tax change an edit rather than a release.
 */
import {
  percentToBp,
  type Distribution,
  type InstrumentKind,
  type Ruleset,
  type TobTier,
} from './schema.ts'
import {
  assertRulesInForceOn,
  isoDay,
  rulesOf,
  TaxRulesError,
  transcribedRules,
  type TaxRuleId,
  type TaxRules,
} from './rules.ts'

// ---------------------------------------------------------------------------
//  What is being taxed
// ---------------------------------------------------------------------------

/** The facts about an instrument that a Belgian tax rate turns on. */
export interface TaxedInstrument {
  readonly kind: InstrumentKind
  /** How to name it in a line — a fund name, a ticker, a company. */
  readonly label: string
  readonly distribution?: Distribution
  /** Registered for public distribution in Belgium. Unset means nobody has said. */
  readonly fsma_registered?: boolean
  /** Share of assets in debt claims, for the Reynders threshold. */
  readonly debt_claims_percent?: number
  /** True when that share was inferred from the asset class rather than published. */
  readonly debt_claims_assumed?: boolean
}

export interface Trade {
  readonly side: 'buy' | 'sell'
  /** The day it happens, which decides which ruleset applies. Defaults to today. */
  readonly on?: string
  /** Quantity times price, before costs — what the beurstaks is charged on. */
  readonly consideration_cents: number
  readonly instrument: TaxedInstrument
  /** For a sale: the realised gain, when it is known. Negative for a loss. */
  readonly gain_cents?: number
  /** For a sale of a debt-claim fund: the interest component the fund publishes. */
  readonly interest_component_cents?: number
  /** How much of this year's capital-gains exemption is left, when known. */
  readonly exemption_remaining_cents?: number
}

// ---------------------------------------------------------------------------
//  What comes out
// ---------------------------------------------------------------------------

/**
 * The fact that is missing, named as the field that would supply it.
 *
 * Named after the field on purpose: an unknown is only worth showing if it says what to
 * go and find out, and "record `fsma_registered` for this fund" is a task where "the
 * registration status is unknown" is a shrug.
 */
export const UNKNOWN_REASONS = ['fsma_registered', 'distribution', 'interest_component'] as const
export type UnknownReason = (typeof UNKNOWN_REASONS)[number]

/** An input the estimate supplied for itself, and that the caller should repeat. */
export const ASSUMPTIONS = ['full_annual_exemption', 'debt_claims_from_asset_class'] as const
export type Assumption = (typeof ASSUMPTIONS)[number]

/**
 * A note on the `?: T | undefined` in the two interfaces below.
 *
 * They travel to the browser as JSON, inside `portfolioSchema`, and JSON has one way to
 * be absent where `exactOptionalPropertyTypes` has two. A line parsed back out of a
 * response schema therefore has `bounds?: … | undefined`, and without the `| undefined`
 * written here it would not be assignable to what `describeTaxEstimate` takes — which is
 * the one function that has to run on both sides of the wire. Producers are unaffected:
 * an omitted key still satisfies these, and nothing here writes an explicit `undefined`.
 */
/** Where a line's number came from — the rate, the cap, and who says so. */
export interface TaxBasis {
  readonly rate_bp: number
  readonly base_cents: number
  /** The per-transaction ceiling in cents, or `null` where the rule has none. */
  readonly cap_cents: number | null
  /** True when the cap, rather than the rate, decided the amount. */
  readonly capped: boolean
  /** Which beurstaks tier applied, for the rules that have tiers. */
  readonly tier?: string | undefined
  readonly citation: string
  readonly source_url?: string | undefined
  readonly last_verified: string
  readonly status: 'confirmed' | 'transcribed'
  /** Which dated ruleset this came from. */
  readonly effective_from: string
}

export interface TaxLine {
  readonly rule: TaxRuleId
  /** The amount owed, or `null` when a fact is missing — `bounds` then says how much. */
  readonly amount_cents: number | null
  /** What it could be, when the missing fact only chooses between known rates. */
  readonly bounds?: { readonly min_cents: number; readonly max_cents: number } | undefined
  readonly unknown?: UnknownReason | undefined
  /** `null` only on an unknown line, where no single rule applied. */
  readonly basis: TaxBasis | null
  readonly assumptions: readonly Assumption[]
}

export interface TaxEstimate {
  readonly lines: readonly TaxLine[]
  /** The sum of what is known — a floor when `complete` is false. */
  readonly total_cents: number
  /** The same sum with every range at its low end. */
  readonly total_min_cents: number
  /** At its high end, or `null` when an unknown line has no bounds at all. */
  readonly total_max_cents: number | null
  readonly complete: boolean
  /** The rules used here that nobody has checked against their citation yet. */
  readonly transcribed: readonly TaxRuleId[]
  readonly effective_from: string
  /** The oldest verification date among the rules used — the "checked on" date. */
  readonly last_verified: string
}

// ---------------------------------------------------------------------------
//  Arithmetic
// ---------------------------------------------------------------------------

/**
 * A percentage from the file as an exact number of basis points.
 *
 * The schema already refuses a third decimal, so this cannot fail on a file that loaded;
 * it throws rather than falling back to zero because a silent 0% is a tax line reading
 * "€ 0,00" for a tax that is owed, which is worse than no line.
 */
function bpOf(percent: number, rule: string): number {
  const bp = percentToBp(percent)
  if (bp === null) {
    throw new TaxRulesError(`the ${rule} rate ${percent}% is not a whole basis point`)
  }
  return bp
}

/**
 * Cents owed on a base at a rate, to the nearest cent.
 *
 * Nearest rather than rounded up: rounding up would be a claim about how brokers and the
 * tax authority round, which nothing here has verified, and the difference is one cent on
 * a figure whose job is to inform a decision about hundreds of euros. What the cent must
 * not do is come from an unstated convention, hence this being one function with a name.
 */
function taxOn(base_cents: number, rate_bp: number): number {
  return Math.round((base_cents * rate_bp) / 10_000)
}

// ---------------------------------------------------------------------------
//  Beurstaks
// ---------------------------------------------------------------------------

/** Whether a tier's conditions hold, fail, or depend on something nobody has said. */
type TierVerdict = 'applies' | 'does-not-apply' | { readonly untestable: UnknownReason }

function testTier(tier: TobTier, instrument: TaxedInstrument): TierVerdict {
  if (tier.when.kind !== instrument.kind) return 'does-not-apply'
  if (tier.when.distribution !== undefined) {
    if (instrument.distribution === undefined) return { untestable: 'distribution' }
    if (instrument.distribution !== tier.when.distribution) return 'does-not-apply'
  }
  if (tier.when.fsma_registered !== undefined) {
    if (instrument.fsma_registered === undefined) return { untestable: 'fsma_registered' }
    if (instrument.fsma_registered !== tier.when.fsma_registered) return 'does-not-apply'
  }
  return 'applies'
}

function tierBasis(
  tier: TobTier,
  base_cents: number,
  effective_from: string,
): { readonly amount_cents: number; readonly basis: TaxBasis } {
  const rate_bp = bpOf(tier.rate_percent, `beurstaks tier "${tier.id}"`)
  const cap_cents = tier.cap_eur === undefined ? null : tier.cap_eur * 100
  const uncapped = taxOn(base_cents, rate_bp)
  const capped = cap_cents !== null && uncapped > cap_cents
  return {
    amount_cents: capped && cap_cents !== null ? cap_cents : uncapped,
    basis: {
      rate_bp,
      base_cents,
      cap_cents,
      capped,
      tier: tier.id,
      citation: tier.citation,
      ...(tier.source_url === undefined ? {} : { source_url: tier.source_url }),
      last_verified: tier.last_verified,
      status: tier.status,
      effective_from,
    },
  }
}

/**
 * The beurstaks on one transaction.
 *
 * Tiers are matched in file order, and a tier whose condition cannot be tested does not
 * simply fall through to the next one: it is collected, and if a later tier does match,
 * the result is the range across all of them rather than the fallback's rate. Falling
 * through would be the dangerous behaviour, because the fallback rate for a fund is the
 * *low* one — a fund whose registration nobody recorded would quietly be estimated at a
 * eleventh of what it may cost, in the direction that makes a trade look cheap.
 */
export function beurstaks(ruleset: Ruleset, trade: Trade): TaxLine {
  const base = trade.consideration_cents
  const uncertain: TobTier[] = []
  let matched: TobTier | null = null
  let reason: UnknownReason | null = null

  for (const tier of ruleset.beurstaks.tiers) {
    const verdict = testTier(tier, trade.instrument)
    if (verdict === 'does-not-apply') continue
    if (verdict === 'applies') {
      matched = tier
      break
    }
    uncertain.push(tier)
    reason ??= verdict.untestable
  }

  if (matched === null) {
    // Unreachable on a file that loaded: the schema requires an unconditional tier per
    // kind precisely so that this cannot be an outcome. Named as a file problem anyway,
    // because the fix would be in the file and a thrown `undefined` says nothing.
    throw new TaxRulesError(
      `no beurstaks tier applies to a ${trade.instrument.kind}; the rules file is missing ` +
        `an unconditional tier for it`,
    )
  }

  const candidates = [...uncertain, matched].map((tier) =>
    tierBasis(tier, base, ruleset.effective_from),
  )
  const certain = candidates.at(-1)
  if (certain === undefined) throw new TaxRulesError('no beurstaks candidate was computed')
  if (uncertain.length === 0 || reason === null) {
    return { rule: 'tob', amount_cents: certain.amount_cents, basis: certain.basis, assumptions: [] }
  }

  const amounts = candidates.map((candidate) => candidate.amount_cents)
  return {
    rule: 'tob',
    amount_cents: null,
    bounds: { min_cents: Math.min(...amounts), max_cents: Math.max(...amounts) },
    unknown: reason,
    // No basis: the point of this line is that two rates are in play, and picking either
    // one's citation to display would suggest the question had been settled.
    basis: null,
    assumptions: [],
  }
}

// ---------------------------------------------------------------------------
//  Roerende voorheffing
// ---------------------------------------------------------------------------

/**
 * Withholding tax on a gross distribution.
 *
 * Deliberately not net-of-exemption: the dividend exemption is claimed on a tax return
 * for the year as a whole and reclaimed afterwards, which is not a fact about this
 * payment. The rules file's `notes` is where that is said, and the line shows what is
 * actually withheld.
 */
export function roerendeVoorheffing(ruleset: Ruleset, gross_cents: number): TaxLine {
  const rule = ruleset.roerende_voorheffing
  const rate_bp = bpOf(rule.rate_percent, 'roerende voorheffing')
  return {
    rule: 'roerendeVoorheffing',
    amount_cents: taxOn(gross_cents, rate_bp),
    basis: {
      rate_bp,
      base_cents: gross_cents,
      cap_cents: null,
      capped: false,
      citation: rule.citation,
      ...(rule.source_url === undefined ? {} : { source_url: rule.source_url }),
      last_verified: rule.last_verified,
      status: rule.status,
      effective_from: ruleset.effective_from,
    },
    assumptions: [],
  }
}

// ---------------------------------------------------------------------------
//  Reynders
// ---------------------------------------------------------------------------

/**
 * The Reynders levy on the interest component of a sale, or `null` where it cannot apply.
 *
 * `null` rather than a zero line for a fund below the debt-claims threshold: an equity
 * ETF has nothing to say about this tax, and a "€ 0,00 Reynders" row on every equity
 * trade trains people to skim the tax block.
 *
 * When it does apply, the amount is almost always unknown, and that is not a shortcoming
 * to apologise for — the taxable base is the interest component the fund publishes in its
 * Belgian TIS, which is not derivable from a price. The line names it so the number can
 * be looked up, rather than inventing one from the whole gain.
 */
export function reynders(ruleset: Ruleset, trade: Trade): TaxLine | null {
  const rule = ruleset.reynders
  const share = trade.instrument.debt_claims_percent
  if (share === undefined || share <= rule.debt_claims_threshold_percent) return null

  const rate_bp = bpOf(rule.rate_percent, 'Reynders levy')
  const assumptions: Assumption[] =
    trade.instrument.debt_claims_assumed === true ? ['debt_claims_from_asset_class'] : []
  const provenance = {
    rate_bp,
    cap_cents: null,
    capped: false,
    citation: rule.citation,
    ...(rule.source_url === undefined ? {} : { source_url: rule.source_url }),
    last_verified: rule.last_verified,
    status: rule.status,
    effective_from: ruleset.effective_from,
  } as const

  if (trade.interest_component_cents === undefined) {
    return {
      rule: 'reynders',
      amount_cents: null,
      unknown: 'interest_component',
      basis: { ...provenance, base_cents: 0 },
      assumptions,
    }
  }
  return {
    rule: 'reynders',
    amount_cents: taxOn(trade.interest_component_cents, rate_bp),
    basis: { ...provenance, base_cents: trade.interest_component_cents },
    assumptions,
  }
}

// ---------------------------------------------------------------------------
//  Capital gains
// ---------------------------------------------------------------------------

/**
 * Tax on a realised gain, after this year's exempt tranche.
 *
 * A zero rate produces a zero line rather than no line, because "no capital-gains tax
 * applies, per the rules in force from 2018-01-01" is information — it is the answer to
 * the question everybody was asking in 2025 about what would change.
 *
 * With nothing said about the exemption, the whole year's tranche is assumed available
 * and `full_annual_exemption` goes on the line. That is the best case, and the assumption
 * travels with the number so nobody has to remember it was made.
 */
export function meerwaarde(ruleset: Ruleset, trade: Trade): TaxLine | null {
  if (trade.gain_cents === undefined) return null
  const rule = ruleset.meerwaarde
  const rate_bp = bpOf(rule.rate_percent, 'capital gains tax')
  // Only worth recording when it could change the answer: under a zero rate — which is
  // what applied until 2026 — nothing was assumed that anybody needs to know about.
  const assumptions: Assumption[] =
    trade.exemption_remaining_cents === undefined && rate_bp > 0 ? ['full_annual_exemption'] : []
  const exemption = trade.exemption_remaining_cents ?? rule.annual_exemption_eur * 100
  // A loss is not a negative tax. Whether it offsets a gain elsewhere in the same year is
  // a return-level question, and the rules file's `notes` says so.
  const taxable = Math.max(0, trade.gain_cents - exemption)
  return {
    rule: 'meerwaarde',
    amount_cents: taxOn(taxable, rate_bp),
    basis: {
      rate_bp,
      base_cents: taxable,
      cap_cents: null,
      capped: false,
      citation: rule.citation,
      ...(rule.source_url === undefined ? {} : { source_url: rule.source_url }),
      last_verified: rule.last_verified,
      status: rule.status,
      effective_from: ruleset.effective_from,
    },
    assumptions,
  }
}

// ---------------------------------------------------------------------------
//  Putting it together
// ---------------------------------------------------------------------------

function summarise(ruleset: Ruleset, lines: readonly TaxLine[]): TaxEstimate {
  const known = lines.filter((line) => line.amount_cents !== null)
  const total = known.reduce((sum, line) => sum + (line.amount_cents ?? 0), 0)
  const unknown = lines.filter((line) => line.amount_cents === null)
  const min = unknown.reduce((sum, line) => sum + (line.bounds?.min_cents ?? 0), 0)
  const bounded = unknown.every((line) => line.bounds !== undefined)
  const max = unknown.reduce((sum, line) => sum + (line.bounds?.max_cents ?? 0), 0)

  const used = new Set(lines.map((line) => line.rule))
  const rules = rulesOf(ruleset).filter((rule) => used.has(rule.id))
  const dates = [...rules].sort((a, b) => a.last_verified.localeCompare(b.last_verified))
  const oldest = dates[0]

  return {
    lines,
    total_cents: total,
    total_min_cents: total + min,
    total_max_cents: bounded ? total + max : null,
    complete: unknown.length === 0,
    transcribed: transcribedRules(ruleset).filter((id) => used.has(id)),
    effective_from: ruleset.effective_from,
    last_verified: oldest?.last_verified ?? ruleset.effective_from,
  }
}

/**
 * Every tax on one trade, in euros, with the rules that produced each figure.
 *
 * A purchase is beurstaks and nothing else. A sale is beurstaks again — it is charged on
 * both sides, which is the fact most often forgotten when comparing a fund's TER against
 * the cost of switching — plus the Reynders levy where the fund is a debt-claim one, plus
 * capital-gains tax where the gain is known.
 */
export function estimateTrade(rules: TaxRules, trade: Trade): TaxEstimate {
  const ruleset = assertRulesInForceOn(rules, trade.on ?? isoDay())
  const lines: TaxLine[] = [beurstaks(ruleset, trade)]
  if (trade.side === 'sell') {
    const levy = reynders(ruleset, trade)
    if (levy !== null) lines.push(levy)
    const gains = meerwaarde(ruleset, trade)
    if (gains !== null) lines.push(gains)
  }
  return summarise(ruleset, lines)
}

/** The withholding on one distribution — the other place a euro of tax shows up. */
export function estimateDividend(
  rules: TaxRules,
  dividend: { readonly gross_cents: number; readonly on?: string },
): TaxEstimate {
  const ruleset = assertRulesInForceOn(rules, dividend.on ?? isoDay())
  return summarise(ruleset, [roerendeVoorheffing(ruleset, dividend.gross_cents)])
}
