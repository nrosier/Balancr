/**
 * Turning a drift into a trade, with the reason attached (#41).
 *
 * The issue's requirement is a sentence: *no suggestion without the drift figure that
 * motivates it.* This module makes that a type rather than a convention — `Suggestion`
 * carries the whole `DriftLine` it came from, so a suggestion cannot be constructed
 * without the numbers that justify it, and the page cannot show one without being able
 * to show why. Everything else here is the arithmetic and the two gates around it.
 *
 * **Sizing depends on where the money comes from, and that is not a detail.** A class
 * 15% under target is not 15% of the portfolio away from being fixed: buying from cash
 * grows the base that the share is a share of, so the purchase needed is nearly three
 * times the apparent gap at a 65% target. But when the same report also wants a sale,
 * the two fund each other and the invested total never moves — and then the gap *is* the
 * trade. So each suggestion states which of the two it is, in `funding`, and the sizes
 * differ accordingly. Quoting one figure for both cases would be wrong by a factor of
 * three in whichever case it was not written for.
 *
 * The sells and the buys in one report need not add up, and that is not a bug: the gaps
 * across all four classes sum to exactly zero, so the classes still inside their bands
 * absorb whatever the ones outside do not account for.
 *
 * **Two gates, and they are the point of the module.**
 *
 *  - A purchase may only name an instrument that came through `assertProposable`. Not
 *    "should" — the only way an ISIN reaches a `Suggestion` here is that function, and
 *    a class with no fresh fund for it produces a suggestion that says so instead of one
 *    naming something plausible. That is the guarantee #40 exists for, kept in the one
 *    module that would otherwise be tempted to reach past it.
 *  - Nothing is proposed that is not worth doing. A share one basis point outside its
 *    band is inside the noise of a day's prices, and a €300 rebalance pays beurstaks
 *    twice to move an allocation by three basis points. Both thresholds live in the
 *    profile, both are applied here, and a line they suppress is reported as `skipped`
 *    with the reason — because "the page shows a red band and suggests nothing" is a bug
 *    report waiting to happen.
 *
 * The tax figure is an estimate of what acting would cost, not part of the decision:
 * nothing here is sized to minimise tax. It also omits what it cannot know — the
 * realised gain on a sale depends on a cost base this app never sees — and says so in
 * `taxOmits` rather than presenting a total that quietly excludes capital gains.
 */
import { logger } from '../../logger.ts'
import type { TaxEstimate, TaxedInstrument } from '../tax/estimate.ts'
import { estimateTrade } from '../tax/estimate.ts'
import { taxedInstrumentFromFund } from '../tax/instrument.ts'
import type { TaxRules } from '../tax/rules.ts'
import type { InstrumentKind } from '../tax/schema.ts'
import type { AssetClass, FundEntry } from '../universe/schema.ts'
import { assertProposable, isStale, type FundUniverse } from '../universe/universe.ts'
import { correctionCents, driftReport, type AllocationInput, type DriftLine, type DriftReport } from './drift.ts'
import { bandsOf, isPreset, type BandClass, type ProfileId, type RiskProfile } from './profile.ts'

const log = logger.child({ module: 'advice/suggest' })

/**
 * Which fund class fills which band.
 *
 * `cash` is deliberately absent: cash is not a band (see `BAND_CLASSES`), so a money
 * market fund is never proposed to fill one. Holding cash is a decision about the
 * emergency fund, which is the budget half of the app.
 */
const UNIVERSE_CLASS: Record<BandClass, AssetClass> = {
  EQUITY: 'equity',
  FIXED_INCOME: 'bond',
  REAL_ESTATE: 'property',
  COMMODITY: 'commodity',
}

/** A position as the latest snapshot holds it — what a sale would come out of. */
export interface HeldPosition {
  readonly isin: string | null
  readonly name: string | null
  /** Ghostfolio's class label, as `allocationByAssetClass` keys on. */
  readonly assetClass: string | null
  /** Ghostfolio's sub-class — `ETF`, `STOCK`, `BOND`. What beurstaks turns on. */
  readonly assetSubClass?: string | null
  readonly valueCents: number
}

/**
 * Ghostfolio's sub-class as a tax instrument kind.
 *
 * Only the three that change a rate are listed. Everything else — a crypto holding, a
 * bare commodity, an unlabelled row — falls through to `fund`, which is not a guess that
 * it *is* a fund: it is the kind whose beurstaks depends on facts a snapshot does not
 * record, so it produces a range naming the missing field rather than a rate. A wrong
 * single number would be worse than an honest interval.
 */
const SUB_CLASS_KIND: Readonly<Record<string, InstrumentKind>> = {
  STOCK: 'share',
  EQUITY: 'share',
  BOND: 'bond',
  ETF: 'fund',
  MUTUALFUND: 'fund',
}

/** The fund a purchase names, and how many others could have filled the same line. */
export interface SuggestedFund {
  readonly isin: string
  readonly name: string
  readonly terPercent: number
  /**
   * How many funds in the universe could have filled this line, this one included.
   *
   * Shown so that "we picked the cheapest of four" reads as a tie-break and not as a
   * recommendation: the choice between two ETFs on the same index is not a thing this
   * app has an opinion about, and the file is where the opinion belongs.
   */
  readonly alternatives: number
}

/** What a sale would come out of, when the snapshot lets it be named. */
export interface SuggestedPosition {
  readonly isin: string | null
  readonly name: string | null
  readonly valueCents: number
  /** How many positions are held in this class. More than one means take your pick. */
  readonly alternatives: number
}

/**
 * Why a suggestion names no instrument.
 *
 * A list rather than a bare union, like `AI_OFF_REASONS`, because the response schema
 * builds its enum from it: a third reason then reaches the wire and the client's
 * exhaustive switch as a compile error, rather than as a payload the schema starts
 * rejecting the day somebody's portfolio has one.
 */
export const UNAVAILABLE_REASONS = [
  // Nothing in the universe fills this class, or everything that does is stale.
  'no_fund_in_universe',
  // The class is overweight but the snapshot holds no position labelled with it.
  'not_held',
] as const
export type Unavailable = (typeof UNAVAILABLE_REASONS)[number]

/** What the tax figure leaves out because advice cannot know it. */
export const TAX_OMISSIONS = ['capital_gains'] as const
export type TaxOmission = (typeof TAX_OMISSIONS)[number]

/** Where the money for a trade comes from, which decides how it is sized. */
export const FUNDINGS = [
  // Matched by a trade on the other side, so the invested total does not move.
  'paired',
  // Out of, or into, cash — which moves the base the shares are shares of.
  'cash',
] as const
export type Funding = (typeof FUNDINGS)[number]

/** Why a line outside its band produced no suggestion after all. */
export const SKIP_REASONS = ['inside_tolerance', 'below_min_trade'] as const
export type SkipReason = (typeof SKIP_REASONS)[number]

export interface Suggestion {
  readonly action: 'buy' | 'sell'
  readonly assetClass: BandClass
  /** Always positive: the direction is `action`. */
  readonly amountCents: number
  readonly funding: Funding
  /** The drift that motivates it. Not a summary of it — the line itself. */
  readonly reason: DriftLine
  /** For a purchase: the fund, from the universe, or `null` with `unavailable` set. */
  readonly fund: SuggestedFund | null
  /** For a sale: the position it would come out of, when one can be named. */
  readonly position: SuggestedPosition | null
  readonly unavailable?: Unavailable
  /** What acting would cost, or `null` when there are no tax rules to price it with. */
  readonly tax: TaxEstimate | null
  readonly taxOmits: readonly TaxOmission[]
}

/** A line outside its band that produced no suggestion, and why. */
export interface SkippedLine {
  readonly assetClass: BandClass
  readonly outsideBp: number
  /** What the trade would have been, so the threshold can be judged against it. */
  readonly amountCents: number
  readonly reason: SkipReason
}

export interface Advice {
  readonly profile: ProfileId
  /** Whether the bands are still exactly the preset they are named after. */
  readonly isPreset: boolean
  readonly toleranceBp: number
  readonly minTradeCents: number
  readonly drift: DriftReport
  /** Worst drift first, in the drift report's own order. */
  readonly suggestions: readonly Suggestion[]
  readonly skipped: readonly SkippedLine[]
}

export interface AdviceInput {
  readonly allocation: readonly AllocationInput[]
  readonly investedValueCents: number
  readonly profile: RiskProfile
  readonly universe: FundUniverse
  /** `null` when the tax rules could not be read: suggestions then carry no cost. */
  readonly rules: TaxRules | null
  /** The latest snapshot's positions, for naming what a sale comes out of. */
  readonly holdings?: readonly HeldPosition[]
  /** For freshness and for the tax day, so a test is not at the mercy of the clock. */
  readonly asOf?: Date
  readonly on?: string
}

// ---------------------------------------------------------------------------
//  Choosing what to name
// ---------------------------------------------------------------------------

/**
 * The cheapest fresh fund for a class, through the gate.
 *
 * Cheapest by TER because it is the only cost in the file that is comparable across two
 * funds, and by ISIN after that so the same universe always produces the same
 * suggestion — a page that proposes a different ETF on each reload is not advice.
 *
 * The chosen ISIN is put back through `assertProposable` rather than trusted from the
 * filter above it. The filter is a convenience; the gate is the guarantee, and a future
 * edit to the ordering cannot accidentally route around a function it still calls.
 */
function chooseFund(
  universe: FundUniverse,
  assetClass: BandClass,
  asOf: Date,
): { fund: FundEntry; alternatives: number } | null {
  const wanted = UNIVERSE_CLASS[assetClass]
  const candidates = universe.funds
    .filter((fund) => fund.asset_class === wanted && !isStale(fund, { asOf }))
    .sort((a, b) => a.ter_percent - b.ter_percent || a.isin.localeCompare(b.isin))

  const best = candidates[0]
  if (best === undefined) return null
  try {
    return { fund: assertProposable(universe, best.isin, { asOf }), alternatives: candidates.length }
  } catch (error) {
    // Unreachable while the filter above matches the gate. Logged rather than thrown,
    // because the honest outcome of "the universe cannot fill this class" is a
    // suggestion that says so, not a portfolio page that fails to render.
    log.error({ err: error, assetClass }, 'a fund passed the freshness filter and then the gate refused it')
    return null
  }
}

/** The largest position held in a class, which is what a sale should come out of first. */
function choosePosition(
  holdings: readonly HeldPosition[],
  assetClass: BandClass,
): { held: HeldPosition; position: SuggestedPosition } | null {
  const inClass = holdings
    .filter((position) => position.assetClass === assetClass)
    .sort((a, b) => b.valueCents - a.valueCents)
  const largest = inClass[0]
  if (largest === undefined) return null
  return {
    held: largest,
    position: {
      isin: largest.isin,
      name: largest.name,
      valueCents: largest.valueCents,
      alternatives: inClass.length,
    },
  }
}

/**
 * What a sale would be taxed as, from the little a snapshot knows.
 *
 * A held position is matched against the universe first, because that is where the facts
 * the rates turn on are written down. Failing that it is a fund with a name and nothing
 * else — which produces a beurstaks range naming the missing field rather than a number,
 * and that is the correct answer: a sale of something nobody recorded the registration
 * of costs somewhere between two rates that differ by a factor of eleven.
 *
 * Freshness is deliberately not required here. `assertProposable` guards what may be
 * *bought*; a position already held is a fact about the portfolio, and refusing to price
 * its sale because a fund list needs an evening would be the wrong refusal.
 */
function sellInstrument(universe: FundUniverse, position: HeldPosition | null): TaxedInstrument {
  const isin = position?.isin ?? null
  const entry = isin === null ? null : (universe.byIsin.get(isin) ?? null)
  if (entry !== null) return taxedInstrumentFromFund(entry)
  const subClass = position?.assetSubClass ?? null
  return {
    kind: (subClass === null ? undefined : SUB_CLASS_KIND[subClass.toUpperCase()]) ?? 'fund',
    label: position?.name ?? 'the position',
  }
}

/**
 * The tax on one leg, or `null`.
 *
 * Every failure here degrades to `null`. A tax file whose dated rulesets do not cover
 * today is a thing to fix in the file, not a reason for the portfolio page to fail — and
 * a suggestion without a cost estimate is still a suggestion, while a blank page is not.
 */
function priceTrade(
  rules: TaxRules | null,
  trade: { side: 'buy' | 'sell'; consideration_cents: number; instrument: TaxedInstrument; on?: string },
): TaxEstimate | null {
  if (rules === null) return null
  try {
    return estimateTrade(rules, trade)
  } catch (error) {
    log.error({ err: error, side: trade.side }, 'the tax rules could not price a suggested trade')
    return null
  }
}

// ---------------------------------------------------------------------------
//  The advice
// ---------------------------------------------------------------------------

/**
 * Drift, and the trades that would close it.
 *
 * Suggestions come out in the drift report's order, worst first, so the page does not
 * have to decide what matters most — the distance past the band edge already did.
 */
export function buildAdvice(input: AdviceInput): Advice {
  const asOf = input.asOf ?? new Date()
  const bands = bandsOf(input.profile)
  const drift = driftReport(input.allocation, bands, input.investedValueCents)
  const { toleranceBp, minTradeCents } = input.profile

  const outside = drift.lines.filter((line) => line.state !== 'inside')
  // Whether each side has a counterparty, before any threshold is applied: the funding
  // question is "does the report want a trade the other way", and a sale suppressed for
  // being too small still means the money for a purchase is not coming from cash.
  const hasSell = outside.some((line) => line.state === 'above')
  const hasBuy = outside.some((line) => line.state === 'below')

  const suggestions: Suggestion[] = []
  const skipped: SkippedLine[] = []

  for (const line of outside) {
    const action = line.state === 'above' ? 'sell' : 'buy'
    const funding: Funding = (action === 'sell' ? hasBuy : hasSell) ? 'paired' : 'cash'
    const amountCents = Math.abs(
      funding === 'paired' ? line.gapCents : correctionCents(line, drift.investedValueCents),
    )

    if (line.outsideBp <= toleranceBp) {
      skipped.push({ assetClass: line.assetClass, outsideBp: line.outsideBp, amountCents, reason: 'inside_tolerance' })
      continue
    }
    if (amountCents < minTradeCents) {
      skipped.push({ assetClass: line.assetClass, outsideBp: line.outsideBp, amountCents, reason: 'below_min_trade' })
      continue
    }

    if (action === 'buy') {
      const chosen = chooseFund(input.universe, line.assetClass, asOf)
      const fund =
        chosen === null
          ? null
          : {
              isin: chosen.fund.isin,
              name: chosen.fund.name,
              terPercent: chosen.fund.ter_percent,
              alternatives: chosen.alternatives,
            }
      suggestions.push({
        action,
        assetClass: line.assetClass,
        amountCents,
        funding,
        reason: line,
        fund,
        position: null,
        ...(chosen === null ? { unavailable: 'no_fund_in_universe' as const } : {}),
        tax:
          chosen === null
            ? null
            : priceTrade(input.rules, {
                side: 'buy',
                consideration_cents: amountCents,
                instrument: taxedInstrumentFromFund(chosen.fund),
                ...(input.on === undefined ? {} : { on: input.on }),
              }),
        taxOmits: [],
      })
      continue
    }

    const chosen = choosePosition(input.holdings ?? [], line.assetClass)
    suggestions.push({
      action,
      assetClass: line.assetClass,
      amountCents,
      funding,
      reason: line,
      fund: null,
      position: chosen?.position ?? null,
      ...(chosen === null ? { unavailable: 'not_held' as const } : {}),
      tax: priceTrade(input.rules, {
        side: 'sell',
        consideration_cents: amountCents,
        instrument: sellInstrument(input.universe, chosen?.held ?? null),
        ...(input.on === undefined ? {} : { on: input.on }),
      }),
      // The realised gain depends on a cost base this app never sees, so the capital
      // gains line is absent from the estimate rather than guessed. Said out loud here,
      // because an estimate that silently excludes a 10% tax reads as a complete one.
      taxOmits: ['capital_gains'],
    })
  }

  return {
    profile: input.profile.profile,
    isPreset: isPreset(input.profile),
    toleranceBp,
    minTradeCents,
    drift,
    suggestions,
    skipped,
  }
}
