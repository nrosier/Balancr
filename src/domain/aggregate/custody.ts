/**
 * What a shared cost actually costs you (#44).
 *
 * A category flagged `custody_shared` is one where the invoice arrives at one household
 * and the cost belongs to two: school fees, the winter coat, the orthodontist, the
 * insurance. Actual records what left your account, which is the only figure that
 * reconciles and is therefore never touched anywhere in this app — but it is not the
 * figure that answers "did I overspend". Paying the whole school bill in September is a
 * 200% overrun against your own norm and roughly half of it was never economically yours.
 *
 * So this computes further figures beside the first, and refuses to replace it:
 *
 *  - **`paidCents` is Actual's own number.** Unchanged, and the card prints it first.
 *  - **`totalCents` is what the thing cost**, `yoursCents` the part that is economically
 *    yours, and `otherCents` the co-parent's part. `total = yours + other` always. Those
 *    are the numbers that make an overrun read as an arrangement rather than as a spending
 *    problem.
 *
 * Three decisions worth disagreeing with:
 *
 *  - **The share is one number for the household, not one per category.** A per-category
 *    share would be more expressive and would also be fifty fields nobody maintains; the
 *    arrangement people actually have is one split applied to the things that are shared.
 *    The flag says *which* categories, and this says *how much*.
 *  - **Which way the share reads is stored, not guessed (#289).** The same €600 line is
 *    either a whole invoice you bear 60% of or your 60% of a €1 000 cost, and nothing in
 *    the data distinguishes them — so `sharedCostDirection` says which, and the two
 *    directions derive opposite things from the same number. `whole_invoice` multiplies
 *    down to your part; `my_share` divides up to the total the account never saw. Reading
 *    it the wrong way is not an approximation: it applies the share twice and asserts a
 *    debt that has already been settled.
 *  - **Derived from the roster, unless somebody states it.** A member who is here part of
 *    the time is exactly who a shared cost is about, so the default share is the mean of
 *    those members' `custodyBp` — no age threshold, no benchmark file, nothing invented.
 *    `sharedCostBp` overrides it, because the split in an agreement is a fact only a
 *    person knows and it is routinely not the split of the time.
 *  - **`basis` travels with the result.** A derived share is Balancr's assumption about
 *    somebody's arrangement, and every screen that prints a borne figure has to be able
 *    to say which of the two it was. #44 asks for both figures reported; a figure whose
 *    provenance is not on the wire cannot be reported honestly.
 *
 * `my_share` is the direction this once deliberately refused to model, on the grounds that
 * `paid` and `yours` would be the same figure. They are — and the figure worth having was
 * never `yours`, it was the *total*, which is exactly what that direction can recover and
 * the other cannot. What a household on that arrangement can now be told is what a child
 * actually costs, of which their own books only ever hold a part.
 *
 * A gross-up is a weaker claim than a discount and the card has to say so: a discount
 * divides a number Actual holds, a gross-up infers one it has never held from a share
 * somebody typed. The flag stays opt-in per category and the card keeps stating its
 * assumption, so a wrong flag or a wrong direction is visible rather than quietly
 * rewriting a line.
 *
 * Pure: the roster, the flags and the month's facts arrive as arguments. `jobs/signals.ts`
 * and `GET /api/budget` both build the input through `custody-context.ts`, the same
 * arrangement the benchmark has. Pure for the browser's sake as well — `web/src/shared.ts`
 * re-exports `custodyShare` so the settings panel can print what the roster currently
 * implies — so nothing here may reach the database, the clock or `config`.
 */
import type { Household } from '../benchmark/household.ts'
import type { SharedCostDirection } from '../benchmark/vocabulary.ts'
import { capSeverity } from '../ai/codes.ts'
import type { AggregateParams } from './params.ts'
import type { Signal } from './overspend.ts'
import type { MonthlyFact } from './spend.ts'

/**
 * Where the split came from.
 *
 * `stated` is a number somebody typed; `roster` is the mean share of the time the
 * part-time members of the household are here. Never merged into one field, because the
 * sentence the card prints differs: one is an arrangement, the other is a guess at one.
 */
export const CUSTODY_BASES = ['stated', 'roster'] as const
export type CustodyBasis = (typeof CUSTODY_BASES)[number]

/**
 * Why there is no split to report.
 *
 * `no_shared` is the ordinary state of most budgets and draws nothing at all — the flag
 * is opt-in, and a card explaining an absence nobody asked about is noise. `no_basis` is
 * the one that needs saying: categories are flagged, so somebody meant this to work, and
 * the share it needs is missing.
 *
 * `zero_share` is its own reason rather than a fourth cause of `no_basis` (#289): a stated
 * 0% under `my_share` is not a missing share, it is a share that cannot be divided by, and
 * telling somebody who typed a number that nothing says what their share is would be the
 * card contradicting the form.
 */
export const CUSTODY_UNAVAILABLE = ['no_month', 'no_shared', 'no_basis', 'zero_share'] as const
export type CustodyUnavailable = (typeof CUSTODY_UNAVAILABLE)[number]

export interface CustodyLine {
  categoryId: string
  categoryName: string
  /** Actual's figure for the month. Never adjusted, in either direction. */
  paidCents: number
  /** What the thing cost in total: `paidCents` itself, or grossed up out of the share. */
  totalCents: number
  /** The part of `totalCents` that is economically yours. */
  yoursCents: number
  /** The rest of it: `totalCents − yoursCents`. */
  otherCents: number
}

export type CustodySplit =
  | {
      readonly kind: 'ok'
      readonly month: string
      readonly basis: CustodyBasis
      /** The share of a shared cost that is yours, in basis points. */
      readonly shareBp: number
      /** Which way the share was read. See `SHARED_COST_DIRECTIONS`. */
      readonly direction: SharedCostDirection
      /** How many part-time members the derived share averaged. Zero when `stated`. */
      readonly members: number
      /** One per flagged category with spending this month, largest paid first. */
      readonly lines: readonly CustodyLine[]
      /**
       * Actual's own figure, in both directions and always printed first.
       *
       * The one quantity whose relationship to the other three depends on the direction,
       * which is the whole of what a direction is: under `whole_invoice` it equals
       * `totalCents`, under `my_share` it equals `yoursCents`.
       */
      readonly paidCents: number
      /** What the flagged categories cost in total, both households together. */
      readonly totalCents: number
      /** Your part of that. */
      readonly yoursCents: number
      /**
       * The co-parent's part: `totalCents − yoursCents`.
       *
       * Money they owe you under `whole_invoice`, money that never reached your account
       * under `my_share`. The figure is the same shape; only the sentence differs, which
       * is why the direction travels with it.
       */
      readonly otherCents: number
      /** What the flagged categories are of the month's whole spend, as Actual holds it. */
      readonly shareOfSpendBp: number
    }
  | {
      readonly kind: 'unavailable'
      readonly reason: CustodyUnavailable
      /** Set when the reason is `no_basis`: what was flagged and went unsplit. */
      readonly paidCents: number | null
    }

export interface CustodyInput {
  readonly month: string
  /** The month's facts, as the aggregation stored them. */
  readonly rows: readonly MonthlyFact[]
  /** `categoryId` → whether the cost is shared with a co-parent. */
  readonly shared: ReadonlySet<string>
  readonly household: Household
}

/**
 * The share of a shared cost the household bears, and where that number came from.
 *
 * Exported because both the split and the settings panel print it: the panel has to show
 * what the roster currently implies *before* anybody states an override, or the field
 * reads as "0% until you type something".
 *
 * Two fields rather than the whole `Household`, because those are the two it reads. The
 * panel calls it with a roster it is holding and a deliberately null share to ask "what
 * would you derive from this?", and asking that question should not require inventing a
 * direction — the direction is what to *do* with the share, not where it came from (#289).
 */
export function custodyShare(
  household: Pick<Household, 'members' | 'sharedCostBp'>,
): { basis: CustodyBasis; shareBp: number; members: number } | null {
  if (household.sharedCostBp !== null) {
    return { basis: 'stated', shareBp: household.sharedCostBp, members: 0 }
  }
  // Full-time members are not who a shared cost is about: a partner who lives here does
  // not halve the school fees, and averaging them in would drag the share towards 100%
  // and quietly make the whole feature do nothing.
  const partTime = household.members.filter((member) => member.custodyBp < 10_000)
  if (partTime.length === 0) return null
  const total = partTime.reduce((sum, member) => sum + member.custodyBp, 0)
  return { basis: 'roster', shareBp: Math.round(total / partTime.length), members: partTime.length }
}

/**
 * A month's shared categories, split into what you paid and what you bear.
 *
 * Income and hidden categories are excluded for the reason they are everywhere else: a
 * shared *income* is not a cost, and a hidden envelope is one somebody has asked not to
 * see. A flagged category with no spending this month is left out of `lines` rather than
 * listed at zero — the card is a list of what the arrangement cost, and eleven zero rows
 * would bury the one row that did.
 */
export function splitCustody(input: CustodyInput): CustodySplit {
  const spending = input.rows.filter((row) => !row.isIncome && !row.hidden)
  const spentCents = spending.reduce((sum, row) => sum + row.spentCents, 0)
  if (spending.length === 0 || spentCents <= 0) {
    return { kind: 'unavailable', reason: 'no_month', paidCents: null }
  }

  const flagged = spending.filter((row) => input.shared.has(row.categoryId) && row.spentCents > 0)
  if (flagged.length === 0) {
    return { kind: 'unavailable', reason: 'no_shared', paidCents: null }
  }

  const paidCents = flagged.reduce((sum, row) => sum + row.spentCents, 0)
  const share = custodyShare(input.household)
  if (share === null) {
    return { kind: 'unavailable', reason: 'no_basis', paidCents }
  }

  // A gross-up divides by the share, so a stated 0% has no total rather than an infinite
  // one — the same guard `savingsRateBp` puts on its own denominator. `whole_invoice` is
  // unaffected: it multiplies, and a 0% share there is a legitimate "none of this is
  // mine".
  const direction = input.household.sharedCostDirection
  if (direction === 'my_share' && share.shareBp === 0) {
    return { kind: 'unavailable', reason: 'zero_share', paidCents }
  }

  // Rounded per line rather than once at the end, so the rows add up to the total the
  // card prints under them. A total rounded separately is off by a cent or two from its
  // own rows, and that cent is what somebody spends an evening looking for.
  //
  // The two directions round different quantities, because each derives a different one:
  // `whole_invoice` knows the total and computes your part of it, `my_share` knows your
  // part and recovers the total. In both, `otherCents` is the subtraction rather than a
  // third rounding, so `total = yours + other` holds exactly on every line.
  const lines = flagged
    .map((row) => {
      const paidCents = row.spentCents
      const totalCents =
        direction === 'whole_invoice'
          ? paidCents
          : Math.round((paidCents * 10_000) / share.shareBp)
      const yoursCents =
        direction === 'whole_invoice' ? Math.round((paidCents * share.shareBp) / 10_000) : paidCents
      return {
        categoryId: row.categoryId,
        categoryName: row.categoryName,
        paidCents,
        totalCents,
        yoursCents,
        otherCents: totalCents - yoursCents,
      }
    })
    .sort((a, b) => b.paidCents - a.paidCents || a.categoryName.localeCompare(b.categoryName))

  const totalCents = lines.reduce((sum, line) => sum + line.totalCents, 0)
  const yoursCents = lines.reduce((sum, line) => sum + line.yoursCents, 0)

  return {
    kind: 'ok',
    month: input.month,
    basis: share.basis,
    shareBp: share.shareBp,
    direction,
    members: share.members,
    lines,
    paidCents,
    totalCents,
    yoursCents,
    otherCents: totalCents - yoursCents,
    // Against what Actual holds, in both directions. The denominator is the month's real
    // spend, so grossing a flagged line up must not inflate the numerator — "38% of what
    // I spent went on shared costs" is a fact about the bank account, and a share of a
    // total that includes money the account never saw would be over 100% soon enough.
    shareOfSpendBp: Math.round((paidCents / spentCents) * 10_000),
  }
}

/**
 * One `info` finding: how much of what you paid is the other household's share.
 *
 * Household-level, and one signal rather than one per category. A finding per flagged
 * envelope would say the same thing five times in a month where five of them were paid,
 * and the useful figure is the total — it is what the month's overrun should be read
 * against.
 *
 * `info` and capped there, for the reason the benchmark's finding is: this is context
 * about an arrangement, not a judgement about spending. Nobody has done anything wrong by
 * paying a bill that gets split, and a `warn` would put a joint-custody household at the
 * top of the insights page every month for the shape of its family.
 *
 * Gated on the same materiality floor as every relative signal, so a €4 offset on a
 * shared subscription stays quiet.
 */
export function custodySignals(split: CustodySplit, params: AggregateParams): Signal[] {
  if (split.kind !== 'ok') return []
  if (split.otherCents < params.overspend.materialityFloorCents) return []
  // Two codes rather than one sentence with swapped numbers, because the two directions
  // make different claims about the same figure: one says money is owed to you, the other
  // says money was never yours to begin with. A single sentence could only be vague enough
  // to be true of both.
  const code = split.direction === 'whole_invoice' ? 'custody_offset' : 'custody_total'
  return [
    {
      code,
      categoryId: null,
      categoryName: null,
      severity: capSeverity(code, 'info'),
      metrics: {
        otherCents: split.otherCents,
        paidCents: split.paidCents,
        totalCents: split.totalCents,
        yoursCents: split.yoursCents,
        shareBp: split.shareBp,
      },
    },
  ]
}
