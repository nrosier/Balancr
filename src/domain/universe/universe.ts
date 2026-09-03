/**
 * The fund universe: the only instruments advice may propose (#40).
 *
 * A model asked "what should I buy?" will answer, fluently, with a ticker it has seen
 * in text. That is the failure this module exists to make impossible — not by asking
 * the model to be careful, but by there being a list, written by the person whose money
 * it is, and nothing outside it having a name advice can use. `assertProposable` is the
 * gate, and `proposableIsinSchema` is the same gate as a parser, so a payload schema
 * cannot forget to call it.
 *
 * Three decisions about how it is held:
 *
 *  - **A file, read fresh, not a table.** Curating a universe is an evening with a
 *    broker's fund list open; a text file is the right tool and version control is a
 *    reasonable place for the result. Reading it per use rather than caching it at boot
 *    means an edit takes effect without a restart, which matters because the natural
 *    reaction to "advice proposed nothing" is to open the file and fix it.
 *  - **Absent means empty, and empty means silent.** No file is not an error: it is a
 *    new install, or someone who wants the budget half only. Advice with an empty
 *    universe proposes nothing and says why, in the same spirit as the AI layer standing
 *    down without a key (#165).
 *  - **Malformed is a loud warning at startup and an error at the point of use.** A
 *    typo in a fund list should not take the budget pages down with it, so `main.ts`
 *    calls `universeOrEmpty` and logs. Anything that would actually propose money calls
 *    `loadUniverse` and gets the exception, because "the file is broken so I ignored
 *    it" is not a thing to do quietly when the next step is a trade.
 *
 * Staleness is enforced rather than displayed. A TER changes, a share class merges, a
 * fund closes — and the file cannot know. An entry nobody has confirmed inside
 * `FUND_UNIVERSE_MAX_AGE_DAYS` is not proposable, which turns "we should re-check this
 * list some day" into a thing that stops working until someone does.
 */
import { z } from 'zod'
import { config } from '../../config.ts'
import { logger } from '../../logger.ts'
import { ageInDays } from '../verified-date.ts'
import { readYamlFile } from '../../yaml-file.ts'
import { normaliseIsin } from './isin.ts'
import { universeFileSchema, type FundEntry, type UniverseFile } from './schema.ts'

const log = logger.child({ module: 'universe' })

export class UniverseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UniverseError'
  }
}

export interface FundUniverse {
  /** Where it was read from, or `null` for the empty universe. */
  readonly path: string | null
  /** In file order, which is the order a person chose to write them in. */
  readonly funds: readonly FundEntry[]
  readonly byIsin: ReadonlyMap<string, FundEntry>
}

export const EMPTY_UNIVERSE: FundUniverse = {
  path: null,
  funds: [],
  byIsin: new Map(),
}

// ---------------------------------------------------------------------------
//  Loading
// ---------------------------------------------------------------------------

/**
 * Reads and validates one universe file.
 *
 * Throws `UniverseError` for anything wrong with the file and returns the empty
 * universe when there is no file at all — the distinction being that one of those is a
 * mistake and the other is a choice.
 *
 * Every message names the path, because this is read from an env var and the most
 * likely mistake is the path pointing somewhere else than the file being edited.
 */
export function loadUniverse(path: string = config.FUND_UNIVERSE_PATH): FundUniverse {
  const empty: UniverseFile = { version: 1, funds: [] }
  const read = readYamlFile(path, universeFileSchema, 'fund universe', { emptyValue: empty })
  // No file is not an error: it is a new install, or someone who wants the budget half
  // only. An emptied file is the same statement made deliberately, which is why the
  // reader is handed a value for it rather than left to fail the schema on a missing key.
  if (read.kind === 'absent') return EMPTY_UNIVERSE
  if (read.kind === 'problem') throw new UniverseError(read.message)

  const byIsin = new Map<string, FundEntry>()
  for (const fund of read.value.funds) {
    const existing = byIsin.get(fund.isin)
    if (existing !== undefined) {
      // Refused rather than last-one-wins: two rows for one ISIN disagree about
      // something — usually a TER that was updated in one place — and picking either
      // silently is how the file starts lying about which one was checked.
      throw new UniverseError(
        `${path} lists ${fund.isin} twice, as "${existing.name}" and "${fund.name}"`,
      )
    }
    byIsin.set(fund.isin, fund)
  }

  return { path, funds: read.value.funds, byIsin }
}

/**
 * The universe, or an empty one with the reason logged.
 *
 * For startup and for anything that only reads: a broken fund list is worth a warning
 * every boot and not worth refusing to serve a budget page over. Callers that are about
 * to propose money use `loadUniverse` and let it throw.
 */
export function universeOrEmpty(path: string = config.FUND_UNIVERSE_PATH): FundUniverse {
  try {
    return loadUniverse(path)
  } catch (error) {
    log.error(
      { path, err: error instanceof Error ? error.message : String(error) },
      'the fund universe could not be read; advice will propose nothing until it is fixed',
    )
    return EMPTY_UNIVERSE
  }
}

// ---------------------------------------------------------------------------
//  Reading it
// ---------------------------------------------------------------------------

/** One fund by ISIN, in any spelling, or `null`. */
export function lookupFund(universe: FundUniverse, isin: string): FundEntry | null {
  const key = normaliseIsin(isin)
  if (key === null) return null
  return universe.byIsin.get(key) ?? null
}

/** How many days ago this entry was last confirmed against its source. */
export function verificationAgeDays(fund: FundEntry, asOf: Date = new Date()): number {
  return ageInDays(fund.last_verified, asOf)
}

export interface FreshnessOptions {
  asOf?: Date
  maxAgeDays?: number
}

/**
 * Whether this entry is too old to act on.
 *
 * A date in the future counts as fresh rather than as an error here: the schema already
 * refuses one, so reaching this with a future date means the clock moved, and a wrong
 * clock should not make every fund unproposable.
 */
export function isStale(fund: FundEntry, options: FreshnessOptions = {}): boolean {
  const maxAge = options.maxAgeDays ?? config.FUND_UNIVERSE_MAX_AGE_DAYS
  return verificationAgeDays(fund, options.asOf ?? new Date()) > maxAge
}

/** The entries nobody has confirmed lately, oldest first — a to-do list, in order. */
export function staleFunds(
  universe: FundUniverse,
  options: FreshnessOptions = {},
): readonly FundEntry[] {
  const asOf = options.asOf ?? new Date()
  return universe.funds
    .filter((fund) => isStale(fund, { ...options, asOf }))
    .sort((a, b) => a.last_verified.localeCompare(b.last_verified))
}

// ---------------------------------------------------------------------------
//  The gate
// ---------------------------------------------------------------------------

/**
 * The fund this ISIN names, or an exception saying why it cannot be proposed.
 *
 * The only way to turn an ISIN into something advice may act on. Two refusals, with
 * different messages because they need different fixes: an unknown ISIN means the model
 * invented one or the universe is missing a fund somebody meant to add, and a stale one
 * means the list needs an evening rather than an edit.
 */
export function assertProposable(
  universe: FundUniverse,
  isin: string,
  options: FreshnessOptions = {},
): FundEntry {
  const fund = lookupFund(universe, isin)
  if (fund === null) {
    const where = universe.path === null ? 'the fund universe is empty' : `${universe.path}`
    throw new UniverseError(`${normaliseIsin(isin) ?? '(empty)'} is not in ${where}`)
  }
  const maxAge = options.maxAgeDays ?? config.FUND_UNIVERSE_MAX_AGE_DAYS
  if (isStale(fund, { ...options, maxAgeDays: maxAge })) {
    throw new UniverseError(
      `${fund.isin} (${fund.name}) was last verified ${fund.last_verified}, ` +
        `${verificationAgeDays(fund, options.asOf ?? new Date())} days ago; ` +
        `re-check it against ${fund.source} and update last_verified`,
    )
  }
  return fund
}

/**
 * `assertProposable` as a parser, for a proposal payload's instrument field.
 *
 * Exported so that a payload schema cannot be written without the check: the type of a
 * proposable instrument is "whatever this schema returns", and there is no other
 * constructor. The alternative — a plain string field and a call to `assertProposable`
 * somewhere in the handler — is one refactor away from being skipped.
 */
export function proposableIsinSchema(
  universe: FundUniverse,
  options: FreshnessOptions = {},
): z.ZodType<FundEntry> {
  return z.string().transform((value, ctx) => {
    try {
      return assertProposable(universe, value, options)
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : String(error),
      })
      return z.NEVER
    }
  })
}

// ---------------------------------------------------------------------------
//  What the model sees
// ---------------------------------------------------------------------------

export interface PromptFund {
  isin: string
  name: string
  asset_class: string
  region: string
  currency: string
  ter_percent: number
  domicile: string
  hedged_to?: string
}

/**
 * The universe as the model gets it.
 *
 * Only the fields a suggestion could turn on. `source`, `notes` and `last_verified` are
 * the human's audit trail and would be tokens in every cached prompt for nothing;
 * `ticker` is left out deliberately, so that a suggestion has to come back as an ISIN
 * and be matched against this list rather than as a symbol that could mean two things
 * on two exchanges.
 *
 * Stale entries are excluded: the model should not be able to name an instrument that
 * `assertProposable` would then refuse, because a refusal at that point reads to the
 * user as the app breaking rather than as the list needing attention.
 */
export function universeForPrompt(
  universe: FundUniverse,
  options: FreshnessOptions = {},
): PromptFund[] {
  const asOf = options.asOf ?? new Date()
  return universe.funds
    .filter((fund) => !isStale(fund, { ...options, asOf }))
    .map((fund) => ({
      isin: fund.isin,
      name: fund.name,
      asset_class: fund.asset_class,
      region: fund.region,
      currency: fund.currency,
      ter_percent: fund.ter_percent,
      domicile: fund.domicile,
      ...(fund.hedged_to === undefined ? {} : { hedged_to: fund.hedged_to }),
    }))
}
