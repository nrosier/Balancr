/**
 * What a household-budget benchmark file may say (#43).
 *
 * The same discipline as the tax rules (#42), for the same reason: **no reference figure
 * appears anywhere in Balancr's code.** A share in a `const` is a share that is silently
 * from 2018 three years from now, with nothing recording which survey it came from — and
 * unlike a tax rate, nobody would notice, because a benchmark that is slightly wrong
 * still looks exactly like a benchmark.
 *
 * So the file carries provenance twice over. The `source` block says which survey and
 * which year, and `status: transcribed` says whether anybody has read the numbers against
 * it — Balancr ships a transcribed file, and every comparison drawn from one says so on
 * screen. The `equivalence` block carries its own citation because the scale is a
 * different claim from a different publisher (Eurostat, not Statbel) and confirming one
 * says nothing about the other.
 *
 * Three structural rules are enforced here rather than left to a reader:
 *
 *  - **The ten groups are exactly the ten group ids, once each.** They are a closed
 *    vocabulary shared with the code and both catalogues, so a renamed or duplicated
 *    group is a load failure rather than a line that quietly disappears from the card.
 *  - **The COICOP divisions cover 01–12 exactly once between them.** A division in two
 *    groups double-counts spending; a division in none makes a category unmappable while
 *    the shares still sum to 100%, which reads as a complete comparison and is not one.
 *  - **The shares sum to 10 000 basis points, within a whole basis point.** Published
 *    shares are rounded, so an exact equality would refuse a faithful transcription; a
 *    tolerance of one basis point catches a transposed digit and forgives the rounding.
 *
 * `reference_household` is optional, and its absence is the shipped state. It is the only
 * thing that makes a *level* comparison — euros against euros — possible, and both of its
 * numbers live in a 7 MB spreadsheet rather than on the summary page. Making it optional
 * is how Balancr avoids the alternative: a plausible guess at an average household's
 * monthly spend, which would put a wrong euro figure next to every category on the page.
 */
import { z } from 'zod'
import { verifiedDateSchema } from '../verified-date.ts'
import { BENCHMARK_GROUPS, COICOP_DIVISIONS } from './vocabulary.ts'

/** Basis points as a share of a whole: 1400 is 14,00%. */
const shareBp = z.int().min(0).max(10_000)

/** The three fields that make a figure answerable — the tax file's, said again. */
const provenance = {
  /** The publication, by name and year: `Statbel, Household Budget Survey 2024 — …`. */
  citation: z.string().trim().min(8).max(200),
  /** A page that carries it, if there is a durable one. Optional; URLs rot. */
  source_url: z.url().optional(),
  last_verified: verifiedDateSchema,
  status: z.enum(['confirmed', 'transcribed']),
  /** What the figure alone does not say: what it includes, what it leaves out. */
  notes: z.string().trim().max(1_200).optional(),
}

export const benchmarkProvenanceSchema = z.object(provenance).strict()
export type BenchmarkProvenance = z.infer<typeof benchmarkProvenanceSchema>

/**
 * Which survey, and which year of it.
 *
 * The year is a separate field from the citation even though the citation contains it,
 * because the year is printed next to every comparison — #43 asks for source and year
 * beside each one — and parsing it back out of a prose string would be a parser waiting
 * to be wrong.
 */
const sourceSchema = z
  .object({
    survey: z.string().trim().min(3).max(120),
    year: z.int().min(1990).max(2100),
    ...provenance,
  })
  .strict()

/**
 * The scale that makes two households of different sizes comparable.
 *
 * Written out as three weights rather than named-only, so the file states what
 * `modified_oecd` means and a comparison can print it. `scale` is an enum of one on
 * purpose: a second scale is a real possibility (the OECD's original 1/0,7/0,5) and this
 * is where it would be added, but silently accepting a name Balancr does not implement
 * would produce a comparison scaled by numbers nobody chose.
 */
const equivalenceSchema = z
  .object({
    scale: z.enum(['modified_oecd']),
    /** The first person in the household. 10 000 by definition of the scale. */
    first_person_bp: shareBp,
    /** Every further person at or above `child_age_below`. */
    additional_person_bp: shareBp,
    /** Every person below `child_age_below`. */
    child_bp: shareBp,
    child_age_below: z.int().min(1).max(25),
    ...provenance,
  })
  .strict()

export type Equivalence = z.infer<typeof equivalenceSchema>

/**
 * The average household in euros per month, and how big it is on the scale.
 *
 * Both or neither: a total without a size cannot be scaled to your household, and a size
 * without a total has nothing to scale. `.strict()` plus two required fields is that
 * rule, and it is why this is one optional block rather than two optional numbers.
 */
const referenceHouseholdSchema = z
  .object({
    mean_monthly_cents: z.int().positive(),
    equivalent_adults_bp: z.int().min(10_000).max(200_000),
    ...provenance,
  })
  .strict()

export type ReferenceHousehold = z.infer<typeof referenceHouseholdSchema>

const groupSchema = z
  .object({
    id: z.enum(BENCHMARK_GROUPS),
    share_bp: shareBp,
    /**
     * The COICOP divisions this group covers, as two-digit strings. A list because
     * Statbel's residual line genuinely is three divisions, and quoting the source's own
     * aggregation is what lets a category mapped to `10` find its way to a published
     * share.
     */
    coicop: z.array(z.enum(COICOP_DIVISIONS)).min(1),
  })
  .strict()

export type BenchmarkGroupEntry = z.infer<typeof groupSchema>

export const benchmarkFileSchema = z
  .object({
    version: z.literal(1),
    jurisdiction: z.literal('BE'),
    source: sourceSchema,
    equivalence: equivalenceSchema,
    reference_household: referenceHouseholdSchema.optional(),
    groups: z.array(groupSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Every group once. `z.enum` already refuses a name that is not one of the ten, so
    // what is left to catch is a file with `housing` twice — which passes every other
    // check, sums to 100% if the two halves do, and drops a line off the card.
    const seen = new Set<string>()
    for (const group of value.groups) {
      if (seen.has(group.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `group "${group.id}" appears twice; each of the ten appears exactly once`,
        })
      }
      seen.add(group.id)
    }
    const missing = BENCHMARK_GROUPS.filter((id) => !seen.has(id))
    if (missing.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          `has no entry for ${missing.join(', ')}; all ten groups are needed, with ` +
          `\`share_bp: 0\` if the survey reports nothing for one`,
      })
    }

    // Every division once, across the groups. Twice means a category's spending lands in
    // two groups and is counted twice against a total that only counted it once; never
    // means a category mapped to it can never be compared, while the shares still add up
    // to a convincing 100%.
    const owner = new Map<string, string>()
    for (const group of value.groups) {
      for (const division of group.coicop) {
        const already = owner.get(division)
        if (already !== undefined) {
          ctx.addIssue({
            code: 'custom',
            message:
              `COICOP division ${division} is claimed by both "${already}" and ` +
              `"${group.id}"; spending mapped to it would be counted twice`,
          })
          continue
        }
        owner.set(division, group.id)
      }
    }
    const uncovered = COICOP_DIVISIONS.filter((division) => !owner.has(division))
    if (uncovered.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          `no group covers COICOP division${uncovered.length === 1 ? '' : 's'} ` +
          `${uncovered.join(', ')}; a category mapped there could never be compared`,
      })
    }

    // The shares. One basis point of tolerance, because the published figures are
    // rounded to two decimals and an exact sum would refuse an honest transcription.
    const total = value.groups.reduce((sum, group) => sum + group.share_bp, 0)
    if (Math.abs(total - 10_000) > 1) {
      ctx.addIssue({
        code: 'custom',
        message:
          `the ten shares add up to ${total} basis points rather than 10000 ` +
          `(${(total / 100).toFixed(2)}% of the budget); check for a transposed digit`,
      })
    }
  })

export type BenchmarkFile = z.infer<typeof benchmarkFileSchema>
