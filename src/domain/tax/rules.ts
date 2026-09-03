/**
 * Loading the dated Belgian tax rules, and picking the set that applied on a day (#42).
 *
 * The loader is the fund universe's (#40) with two deliberate differences, both about
 * what a missing or stale answer costs.
 *
 * **Absent is a problem here, not a choice.** An absent fund universe means somebody
 * wants the budget half only; an absent tax file means `TAX_RULES_PATH` points at
 * nothing, because Balancr ships the file and defaults to it. So the message says where
 * the shipped one is rather than quietly treating "no rules" as "no tax".
 *
 * **Staleness is reported, never enforced.** A stale fund entry means buying the wrong
 * instrument, so #40 refuses. A stale tax rate is, most years, still the rate — and a
 * figure carrying "0,12%, WDRT art. 1262, checked on 2026-09-03" is worth far more than
 * a refusal to say anything. `oldestVerification` and `transcribedRules` exist so the
 * startup log and every estimate can carry that qualification with them.
 */
import { config } from '../../config.ts'
import { logger } from '../../logger.ts'
import { readYamlFile } from '../../yaml-file.ts'
import { ageInDays } from '../verified-date.ts'
import { taxRulesFileSchema, type RuleProvenance, type Ruleset } from './schema.ts'

const log = logger.child({ module: 'tax' })

export class TaxRulesError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaxRulesError'
  }
}

export interface TaxRules {
  readonly path: string
  readonly jurisdiction: 'BE'
  /** Newest first, so the set in force on a date is the first one that has begun. */
  readonly rulesets: readonly Ruleset[]
}

/** The four rules in a ruleset, named as the glossary names them. */
/** Where a rule comes from and when somebody last checked it — see the schema. */
export type { RuleProvenance }

export const TAX_RULE_IDS = ['tob', 'roerendeVoorheffing', 'reynders', 'meerwaarde'] as const
export type TaxRuleId = (typeof TAX_RULE_IDS)[number]

// ---------------------------------------------------------------------------
//  Loading
// ---------------------------------------------------------------------------

/**
 * Reads and validates one tax rules file, newest ruleset first.
 *
 * Throws `TaxRulesError` for every failure including a missing file, and names the path
 * in all of them.
 */
export function loadTaxRules(path: string = config.TAX_RULES_PATH): TaxRules {
  const read = readYamlFile(path, taxRulesFileSchema, 'tax rules')
  if (read.kind === 'absent') {
    throw new TaxRulesError(
      `there is no tax rules file at ${path}; Balancr ships one at ` +
        `config/belgian-tax.yaml — point TAX_RULES_PATH at it, or at your own copy`,
    )
  }
  if (read.kind === 'problem') throw new TaxRulesError(read.message)

  // Sorted here rather than required in the file: the file is written by hand and the
  // order rulesets are read in is not a thing an author should have to keep right.
  const rulesets = [...read.value.rulesets].sort((a, b) =>
    b.effective_from.localeCompare(a.effective_from),
  )
  return { path, jurisdiction: read.value.jurisdiction, rulesets }
}

/**
 * The rules, or `null` with the reason logged.
 *
 * For startup and for anything that can do without a tax figure: a broken tax file
 * should cost the tax lines, not the pages they appear on. Anything that would put a
 * euro amount on screen calls `loadTaxRules` and lets it throw, because "the rates were
 * unreadable so I used none" is not a thing to do quietly next to a number.
 */
export function taxRulesOrNull(path: string = config.TAX_RULES_PATH): TaxRules | null {
  try {
    return loadTaxRules(path)
  } catch (error) {
    log.error(
      { path, err: error instanceof Error ? error.message : String(error) },
      'the tax rules could not be read; estimates will omit tax until it is fixed',
    )
    return null
  }
}

// ---------------------------------------------------------------------------
//  Reading it
// ---------------------------------------------------------------------------

/** A yyyy-mm-dd day string for a `Date`, in UTC — the form the file is written in. */
export function isoDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

/**
 * The ruleset in force on `day`, or `null` if the file says nothing about then.
 *
 * `null` rather than the oldest set, because a date before every ruleset is a question
 * the file cannot answer, and answering it with rates from years later is how a tax
 * figure ends up confidently wrong about a sale that already happened.
 */
export function rulesInForceOn(rules: TaxRules, day: string = isoDay()): Ruleset | null {
  return rules.rulesets.find((ruleset) => ruleset.effective_from <= day) ?? null
}

/**
 * The ruleset in force on `day`, or an exception naming what the file does cover.
 *
 * For the estimate path, where there is no useful way to continue without rates.
 */
export function assertRulesInForceOn(rules: TaxRules, day: string = isoDay()): Ruleset {
  const ruleset = rulesInForceOn(rules, day)
  if (ruleset === null) {
    const oldest = rules.rulesets.at(-1)?.effective_from ?? '(none)'
    throw new TaxRulesError(
      `${rules.path} has no rules for ${day}; the oldest ruleset in it starts ${oldest}`,
    )
  }
  return ruleset
}

/** Each rule in a ruleset with its id, for the checks that treat all four alike. */
export function rulesOf(ruleset: Ruleset): readonly (RuleProvenance & { id: TaxRuleId })[] {
  return [
    // The beurstaks is a list of tiers rather than one rate, and each tier is verified
    // separately — a broker's TOB table is corrected a line at a time. Taking the oldest
    // means the block is only as fresh as its stalest tier, which is the honest reading.
    { ...oldestOf(ruleset.beurstaks.tiers), id: 'tob' },
    { ...provenanceOf(ruleset.roerende_voorheffing), id: 'roerendeVoorheffing' },
    { ...provenanceOf(ruleset.reynders), id: 'reynders' },
    { ...provenanceOf(ruleset.meerwaarde), id: 'meerwaarde' },
  ]
}

/**
 * Just the provenance of a rule.
 *
 * Projected rather than spread whole, because a tier carries its own `id` and spreading
 * it into a `{ id }` would silently overwrite the rule's name with the tier's — which it
 * did, and which showed up as an estimate reporting no unchecked rules while using four.
 */
function provenanceOf(rule: RuleProvenance): RuleProvenance {
  return {
    citation: rule.citation,
    ...(rule.source_url === undefined ? {} : { source_url: rule.source_url }),
    last_verified: rule.last_verified,
    status: rule.status,
    ...(rule.notes === undefined ? {} : { notes: rule.notes }),
  }
}

function oldestOf<T extends RuleProvenance>(rules: readonly T[]): RuleProvenance {
  // A ruleset's tier list is non-empty by schema, so the fallback is unreachable; it is
  // here because `noUncheckedIndexedAccess` is right that the compiler cannot know that.
  const sorted = [...rules].sort((a, b) => a.last_verified.localeCompare(b.last_verified))
  const oldest = sorted[0]
  if (oldest !== undefined) return provenanceOf(oldest)
  throw new TaxRulesError('a ruleset has no beurstaks tiers')
}

/** The oldest verification date in a ruleset, and how many days ago that was. */
export function oldestVerification(
  ruleset: Ruleset,
  asOf: Date = new Date(),
): { readonly rule: TaxRuleId; readonly date: string; readonly ageDays: number } {
  const rules = [...rulesOf(ruleset)].sort((a, b) =>
    a.last_verified.localeCompare(b.last_verified),
  )
  const oldest = rules[0]
  if (oldest === undefined) throw new TaxRulesError('a ruleset has no rules')
  return {
    rule: oldest.id,
    date: oldest.last_verified,
    ageDays: ageInDays(oldest.last_verified, asOf),
  }
}

/**
 * The rules nobody has read at the source yet.
 *
 * Not a warning about the file's quality: it is the list that decides whether an
 * estimate says "these rates are transcribed from published guidance and not checked
 * against the law". Empty is the goal and is not the shipped state.
 */
export function transcribedRules(ruleset: Ruleset): readonly TaxRuleId[] {
  return rulesOf(ruleset)
    .filter((rule) => rule.status === 'transcribed')
    .map((rule) => rule.id)
}
