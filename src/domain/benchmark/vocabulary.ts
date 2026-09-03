/**
 * The ten lines a Belgian household budget is compared against, and the two thresholds
 * that decide when a comparison is worth drawing — in a module a browser can import (#43).
 *
 * Split out of `model.ts` for the reason `advice/vocabulary.ts` gives: that file reads a
 * file off disk and reaches `config`, and the settings screen needs nothing but the list
 * of groups it draws a picker over. Importing the loader to get ten strings would pull
 * `node:fs` and the YAML parser into the bundle.
 *
 * **Why groups rather than COICOP divisions.** COICOP has twelve consumption divisions;
 * Statbel's own published table has ten lines, because it reports communication,
 * education and miscellaneous goods and services together as "other expenditure items".
 * Balancr compares against what the source actually publishes, so the vocabulary is the
 * source's ten lines and each one names the divisions it covers. Inventing a twelve-line
 * comparison out of a ten-line table would mean deriving three shares that were never
 * published.
 *
 * Order is load-bearing — it is Statbel's own table order, so a list rendered by
 * iterating this array reads like the source it cites, and the same order appears in the
 * benchmark card, the mapping form and the YAML file.
 *
 * `OUTSIDE_CONSUMPTION` is not a group and deliberately so: it is the COICOP code Balancr
 * reserves for everything a budget contains that household consumption does not — a
 * savings transfer, a mortgage capital repayment, a tax bill, money moved to a broker.
 * Those categories are excluded from the comparison on both sides rather than counted as
 * unmapped, because a household that saves a third of its income is not a household
 * whose comparison should be suppressed for want of a mapping.
 */

/** Statbel's ten summary lines, in its own order. */
export const BENCHMARK_GROUPS = [
  'food',
  'alcohol_tobacco',
  'clothing',
  'housing',
  'furnishings',
  'health',
  'transport',
  'recreation',
  'hotels_restaurants',
  'other',
] as const
export type BenchmarkGroup = (typeof BENCHMARK_GROUPS)[number]

/** The twelve COICOP divisions that are household consumption, as two-digit strings. */
export const COICOP_DIVISIONS = [
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '10',
  '11',
  '12',
] as const
export type CoicopDivision = (typeof COICOP_DIVISIONS)[number]

/**
 * The file's three blocks, each verified — or not — on its own.
 *
 * A closed set because both screens name them: the benchmark card discloses which blocks
 * nobody has checked against the source, and the settings panel says the same thing beside
 * the form. Ids rather than sentences for the reason the groups are ids: `reference_household`
 * is a key, and the catalogue is the only place it has a name in either language.
 */
export const BENCHMARK_BLOCKS = ['source', 'equivalence', 'reference_household'] as const
export type BenchmarkBlock = (typeof BENCHMARK_BLOCKS)[number]

/**
 * The reserved code for "not household consumption": savings, transfers, taxes, debt
 * capital, money moved to an investment account.
 *
 * `00` is unused by COICOP 1999 and already accepted by the `category_meta` proposal
 * schema's format check, so nothing has to change for a category to carry it.
 */
export const OUTSIDE_CONSUMPTION = '00'

/**
 * The division a COICOP code belongs to, or null if it is not a code at all.
 *
 * Categories are mapped at whatever depth somebody had patience for — `04`, `04.5`,
 * `04.5.1` all mean housing — so the comparison keys on the first two digits and ignores
 * the rest. Returning null rather than throwing because this runs over rows a human or a
 * model wrote, and one bad value should cost that category its mapping, not the page.
 */
export function divisionOf(code: string): string | null {
  const match = /^(\d{2})(\.\d{1,2}){0,3}$/.exec(code.trim())
  return match?.[1] ?? null
}

/** Whether a code means "outside household consumption". */
export function isOutsideConsumption(code: string): boolean {
  return divisionOf(code) === OUTSIDE_CONSUMPTION
}

/** Whether a string is one of the ten group ids. */
export function isBenchmarkGroup(value: string): value is BenchmarkGroup {
  return (BENCHMARK_GROUPS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
//  Thresholds
// ---------------------------------------------------------------------------
//  Here rather than in `compare.ts` for the same reason the group list is: the card has
//  to name them. "Only 54% of your spending is mapped" is the whole content of the
//  `too_unmapped` sentence, and the card marks exactly the lines that produced a finding
//  — two numbers a component cannot hardcode without them drifting from the ones the
//  comparison actually applied.

/**
 * More people than this is a commune, and almost certainly a stuck form.
 *
 * Shared because both ends enforce it: the roster editor stops offering another row, and
 * `householdSchema` refuses one anyway — a limit enforced only in a form is a limit
 * enforced nowhere, and a form that lets somebody type a thirteenth row only to have the
 * save rejected is worse than one that says so.
 */
export const MAX_HOUSEHOLD_MEMBERS = 12

/**
 * How much of the month's spending must carry a COICOP code before a comparison is
 * drawn at all.
 *
 * 70% is a judgement, and it is deliberately not a round 100%: nobody maps every envelope,
 * and a rule that demanded it would mean the feature never switches on. It is also not
 * 50%, because a comparison built on a coin flip's worth of the money would be a chart
 * about the mapping.
 */
export const MIN_MAPPED_BP = 7_000

/**
 * How far above the reference a group has to be before it is worth a finding.
 *
 * Rounding, a category that straddles two divisions and a month with five weekends all
 * move a group by a few percent, and none of them is news. 20% is roughly where a
 * difference survives all three.
 */
export const MIN_DELTA_BP = 2_000
