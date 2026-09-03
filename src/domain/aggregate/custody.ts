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
 * So this computes a second figure beside the first, and refuses to replace it:
 *
 *  - **`paidCents` is Actual's own number.** Unchanged, and the card prints it first.
 *  - **`borneCents` is your share of it**, and `offsetCents` is the remainder — the
 *    co-parent's share of what you paid. That is the number that makes an overrun read
 *    as an arrangement rather than as a spending problem.
 *
 * Three decisions worth disagreeing with:
 *
 *  - **The share is one number for the household, not one per category.** A per-category
 *    share would be more expressive and would also be fifty fields nobody maintains; the
 *    arrangement people actually have is one split applied to the things that are shared.
 *    The flag says *which* categories, and this says *how much*.
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
 * The direction this deliberately does not model: a category where the *co-parent* pays
 * the invoice and you transfer your half. What Actual then holds is already your share,
 * so `paid` and `borne` are the same and flagging it would produce an offset that is not
 * there. That is what the flag being opt-in per category is for, and the card says which
 * assumption it is making so a wrong flag is visible rather than silently halving a line.
 *
 * Pure: the roster, the flags and the month's facts arrive as arguments. `jobs/signals.ts`
 * and `GET /api/budget` both build the input through `custody-context.ts`, the same
 * arrangement the benchmark has. Pure for the browser's sake as well — `web/src/shared.ts`
 * re-exports `custodyShare` so the settings panel can print what the roster currently
 * implies — so nothing here may reach the database, the clock or `config`.
 */
import type { Household } from '../benchmark/household.ts'
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
 */
export const CUSTODY_UNAVAILABLE = ['no_month', 'no_shared', 'no_basis'] as const
export type CustodyUnavailable = (typeof CUSTODY_UNAVAILABLE)[number]

export interface CustodyLine {
  categoryId: string
  categoryName: string
  /** Actual's figure for the month. */
  paidCents: number
  /** `paidCents` at the household's share, rounded once per line. */
  borneCents: number
}

export type CustodySplit =
  | {
      readonly kind: 'ok'
      readonly month: string
      readonly basis: CustodyBasis
      /** The share of a shared cost that is yours, in basis points. */
      readonly shareBp: number
      /** How many part-time members the derived share averaged. Zero when `stated`. */
      readonly members: number
      /** One per flagged category with spending this month, largest paid first. */
      readonly lines: readonly CustodyLine[]
      readonly paidCents: number
      readonly borneCents: number
      /** `paidCents − borneCents`: the co-parent's share of what you paid. */
      readonly offsetCents: number
      /** What the flagged categories are of the month's whole spend. */
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
 */
export function custodyShare(
  household: Household,
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

  // Rounded per line rather than once at the end, so the rows add up to the total the
  // card prints under them. A total rounded separately is off by a cent or two from its
  // own rows, and that cent is what somebody spends an evening looking for.
  const lines = flagged
    .map((row) => ({
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      paidCents: row.spentCents,
      borneCents: Math.round((row.spentCents * share.shareBp) / 10_000),
    }))
    .sort((a, b) => b.paidCents - a.paidCents || a.categoryName.localeCompare(b.categoryName))

  const borneCents = lines.reduce((sum, line) => sum + line.borneCents, 0)

  return {
    kind: 'ok',
    month: input.month,
    basis: share.basis,
    shareBp: share.shareBp,
    members: share.members,
    lines,
    paidCents,
    borneCents,
    offsetCents: paidCents - borneCents,
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
  if (split.offsetCents < params.overspend.materialityFloorCents) return []
  return [
    {
      code: 'custody_offset',
      categoryId: null,
      categoryName: null,
      severity: capSeverity('custody_offset', 'info'),
      metrics: {
        offsetCents: split.offsetCents,
        paidCents: split.paidCents,
        borneCents: split.borneCents,
        shareBp: split.shareBp,
      },
    },
  ]
}
