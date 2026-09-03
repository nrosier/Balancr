/**
 * What a Belgian tax rules file may say (#42).
 *
 * Four taxes decide what a euro of investment actually costs here: the beurstaks on
 * every transaction, roerende voorheffing on what is paid out, the Reynders levy on the
 * interest part of a bond fund, and — since 2026 — a tax on realised gains. All four are
 * rates and thresholds set by law and changed by a government, which is the whole reason
 * they are a file: **no rate appears anywhere in Balancr's code.** A rate in a `const` is
 * a rate that is wrong the year after next, in a place nobody thinks to look, with no
 * record of when it was last true.
 *
 * So this schema describes data, and three fields on every rule exist purely to make it
 * answerable later:
 *
 *  - **`citation`** — the law, by name and article. URLs to tax authority pages rot
 *    within a year or two; `WIB92 art. 269` does not, and it is what a tax adviser
 *    answers questions about. `source_url` is optional and additional.
 *  - **`last_verified`** — the day somebody read the rule against that citation and
 *    agreed. Not enforced the way the fund universe enforces it (#40): a slightly stale
 *    rate with its date attached is far more useful than a refusal to state any figure,
 *    because a rate that changed is news and a rate that did not is most years.
 *  - **`status`** — `confirmed` if somebody has actually read that citation, or
 *    `transcribed` if the line was written from published guidance and nobody has
 *    checked it at the source. Balancr ships a file of `transcribed` rules, and every
 *    estimate built from one says so. The alternative is a comment at the top of a file
 *    warning people to be careful, which is not a mechanism.
 *
 * `effective_from` on a ruleset is what makes the file *dated* rather than merely
 * timestamped: the tax on a sale in December 2025 is not the tax on the same sale in
 * January 2026, and both answers have to remain available. Unlike `last_verified`, a
 * future `effective_from` is legitimate — a rate announced now for next year belongs in
 * the file now, and starts applying on its own.
 */
import { z } from 'zod'
import { verifiedDateSchema } from '../verified-date.ts'

/** What kind of thing is being traded, as the beurstaks distinguishes them. */
export const INSTRUMENT_KINDS = ['share', 'bond', 'fund'] as const
export type InstrumentKind = (typeof INSTRUMENT_KINDS)[number]

/** What a fund does with its income — a beurstaks input, not a preference. */
export const DISTRIBUTIONS = ['accumulating', 'distributing'] as const
export type Distribution = (typeof DISTRIBUTIONS)[number]

/**
 * Percent as written by a human, converted to basis points for the arithmetic.
 *
 * Two decimals is exactly what Belgian tax rates use (`0.12`, `0.35`, `1.32`, `30`), so
 * a third is a typo — and refusing it means every rate is an exact number of basis
 * points, which is how they are multiplied and displayed. The check is a tolerance rather
 * than an equality because a percentage times a hundred is not always the integer it
 * looks like: `0.29 * 100` is `28.999999999999996`. The point is to catch `0.125`, not to
 * have an opinion about IEEE 754.
 */
export function percentToBp(percent: number): number | null {
  const bp = Math.round(percent * 100)
  return Math.abs(percent * 100 - bp) < 1e-9 ? bp : null
}

const ratePercent = z
  .number()
  .min(0)
  .max(100)
  .refine(
    (value) => percentToBp(value) !== null,
    'has more than two decimals, which no Belgian tax rate does — check for a typo',
  )

const dateShape = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'is not a yyyy-mm-dd date')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'is not a real date')

/** The three fields that make a rule answerable, on every rule. */
const provenance = {
  /** The law, by name and article: `WIB92 art. 269`, `WDRT art. 120-1252`. */
  citation: z.string().trim().min(8).max(200),
  /** A page that explains it, if there is a durable one. Optional; URLs rot. */
  source_url: z.url().optional(),
  last_verified: verifiedDateSchema,
  status: z.enum(['confirmed', 'transcribed']),
  /** What the rate alone does not say: exceptions, indexation, what is out of scope. */
  notes: z.string().trim().max(1_200).optional(),
}

/**
 * The provenance fields as a type, so consumers describe "any rule" without restating
 * them — and without drifting from what the schema actually accepts.
 */
export const provenanceSchema = z.object(provenance).strict()
export type RuleProvenance = z.infer<typeof provenanceSchema>

/**
 * One beurstaks rate, and the transactions it applies to.
 *
 * The conditions are data because the tiers are the part of Belgian tax law most likely
 * to be argued about by the person running this: whether a given ETF is registered here
 * decides between 0.12% and 1.32%, and a broker's own table is the practical authority.
 * Adding or correcting a tier should be an edit to this file, never a patch.
 */
const tobTierSchema = z
  .object({
    /** Stable identifier, so an estimate can say which tier produced its figure. */
    id: z
      .string()
      .regex(/^[a-z0-9_]+$/, 'must be lowercase letters, digits and underscores'),
    /**
     * The facts a transaction must have for this tier to apply. Omitting a fact means
     * the tier does not care about it; `kind` is always required, because a file that
     * cannot say which kind of instrument a rate is for cannot be checked by anybody.
     */
    when: z
      .object({
        kind: z.enum(INSTRUMENT_KINDS),
        distribution: z.enum(DISTRIBUTIONS).optional(),
        fsma_registered: z.boolean().optional(),
      })
      .strict(),
    rate_percent: ratePercent,
    /** The per-transaction ceiling, in whole euros. Omitted where there is none. */
    cap_eur: z.number().int().positive().optional(),
    ...provenance,
  })
  .strict()

export type TobTier = z.infer<typeof tobTierSchema>

/** Which facts a tier's conditions depend on, beyond the kind. */
export function conditionsOf(tier: TobTier): readonly ('distribution' | 'fsma_registered')[] {
  const keys: ('distribution' | 'fsma_registered')[] = []
  if (tier.when.distribution !== undefined) keys.push('distribution')
  if (tier.when.fsma_registered !== undefined) keys.push('fsma_registered')
  return keys
}

const beurstaksSchema = z
  .object({ tiers: z.array(tobTierSchema).min(1) })
  .strict()
  .superRefine((value, ctx) => {
    // Two structural rules, both about a file that looks complete and is not.
    //
    // First: every kind of instrument needs a tier that applies to it unconditionally.
    // Tiers are matched in order and the specific ones test facts that may be unknown,
    // so without a fallback per kind a transaction can reach the end of the list — and
    // "no rate found" is not an answer anybody can act on.
    for (const kind of INSTRUMENT_KINDS) {
      const fallback = value.tiers.find(
        (tier) => tier.when.kind === kind && conditionsOf(tier).length === 0,
      )
      if (fallback === undefined) {
        ctx.addIssue({
          code: 'custom',
          message:
            `has no unconditional tier for ${kind}: add one whose \`when\` is only ` +
            `\`kind: ${kind}\`, or a ${kind} transaction has no rate at all`,
        })
      }
    }

    // Second: order matters, so a fallback written above a specific tier silently wins
    // and the specific one never applies. That is invisible on reading and shows up as a
    // rate that is quietly too low.
    for (const [index, tier] of value.tiers.entries()) {
      if (conditionsOf(tier).length > 0) continue
      const shadowed = value.tiers
        .slice(index + 1)
        .filter((later) => later.when.kind === tier.when.kind && conditionsOf(later).length > 0)
      if (shadowed.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message:
            `tier "${tier.id}" applies to every ${tier.when.kind} and comes before ` +
            `${shadowed.map((later) => `"${later.id}"`).join(', ')}, which can therefore ` +
            `never apply — move it below them`,
        })
      }
    }
  })

const withholdingSchema = z.object({ rate_percent: ratePercent, ...provenance }).strict()

const reyndersSchema = z
  .object({
    rate_percent: ratePercent,
    /**
     * Above this share of the fund's assets in debt claims, the levy applies. The test
     * is on the fund, not on the gain, which is why it lives here as a number rather
     * than as a list of funds.
     */
    debt_claims_threshold_percent: z.number().min(0).max(100),
    ...provenance,
  })
  .strict()

const capitalGainsSchema = z
  .object({
    rate_percent: ratePercent,
    /** The yearly tranche that is not taxed, in whole euros. */
    annual_exemption_eur: z.number().int().min(0),
    ...provenance,
  })
  .strict()

export const rulesetSchema = z
  .object({
    /**
     * The day these rules start applying. A ruleset stays in force until a later one
     * begins, so there is no end date to keep in step with the next one's start.
     */
    effective_from: dateShape,
    /** Beurstaks — taks op de beursverrichtingen, on both sides of a transaction. */
    beurstaks: beurstaksSchema,
    /** Roerende voorheffing — withheld at source on dividends and interest. */
    roerende_voorheffing: withholdingSchema,
    /** The Reynders levy on the interest component of a debt-claim fund. */
    reynders: reyndersSchema,
    /** Tax on realised capital gains. Zero is a rate, and was the rate for years. */
    meerwaarde: capitalGainsSchema,
  })
  .strict()

export type Ruleset = z.infer<typeof rulesetSchema>

export const taxRulesFileSchema = z
  .object({
    version: z.literal(1),
    /**
     * Belgium only, said out loud. Every rule in here is Belgian, the glossary is
     * Belgian, and a file for somewhere else would need different taxes rather than
     * different numbers — so this is a guard against a plausible mistake, not a
     * dimension the code supports.
     */
    jurisdiction: z.literal('BE'),
    rulesets: z.array(rulesetSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    for (const ruleset of value.rulesets) {
      if (seen.has(ruleset.effective_from)) {
        // Two rulesets starting the same day means one of them is unreachable, and which
        // one depends on the order they happen to be written in.
        ctx.addIssue({
          code: 'custom',
          message: `has two rulesets effective from ${ruleset.effective_from}`,
        })
      }
      seen.add(ruleset.effective_from)
    }
  })

export type TaxRulesFile = z.infer<typeof taxRulesFileSchema>
