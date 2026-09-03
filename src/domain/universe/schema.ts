/**
 * What a fund universe file may say (#40).
 *
 * The universe is the list of instruments advice may propose, and it is a *file* rather
 * than a table because it is a decision about money that a person makes deliberately,
 * in an editor, with the KID open in the next window — not something an app fills in
 * for them. Everything here follows from that: the schema is strict, the errors name
 * the field and the fund, and three fields exist only to make the vetting checkable
 * later (`source`, `last_verified`, `ucits`).
 *
 * The rules that are opinions, stated rather than buried:
 *
 *  - **Accumulating only.** A distributing share class pays dividends into the account,
 *    where Belgian roerende voorheffing takes 30% of them, every year, whether or not
 *    the money was needed. The accumulating class of the same index reinvests inside
 *    the fund and is not a taxable event until it is sold. Two share classes of one
 *    fund are therefore not interchangeable here, and accepting both would let advice
 *    propose the expensive one for no reason it could explain.
 *  - **EEA domicile.** A UCITS fund domiciled in the EEA has a KID in Dutch or French
 *    and a Belgian broker can sell it. A US-domiciled ETF has neither, which is why a
 *    Belgian retail investor cannot buy VTI however good the TER looks. Requiring the
 *    domicile to be an EEA country is the closest thing to a machine-checkable
 *    "Belgian-accessible" this file can hold.
 *  - **`ter_percent`, not `ter`.** The one number in this file where a factor-of-100
 *    mistake is invisible: `0.20` is right if it means percent per year and wrong by two
 *    orders of magnitude if it means a fraction. The key says which.
 *
 * What the schema cannot check is whether the ISIN belongs to the fund named beside
 * it. `isin.ts` catches typos; nothing here catches a valid ISIN copied from the wrong
 * row. That is what `source` and `last_verified` are for — the first makes the claim
 * checkable in one click, the second says when somebody last did.
 */
import { z } from 'zod'
import { isinProblem, normaliseIsin } from './isin.ts'

/**
 * What kind of thing this is, coarsely.
 *
 * Coarse on purpose: these are the buckets an allocation band is expressed in
 * ("60–75% equity"), not a classification of the fund. A finer taxonomy would invite
 * bands nobody can hold to.
 */
export const ASSET_CLASSES = ['equity', 'bond', 'cash', 'property', 'commodity'] as const
export type AssetClass = (typeof ASSET_CLASSES)[number]

/**
 * Where the money is, coarsely, for the same reason.
 *
 * `world` and `developed` are distinct because the difference is emerging markets, and
 * an investor holding a world fund plus an EM fund is deliberately overweighting them —
 * a fact advice has to be able to see.
 */
export const REGIONS = [
  'world',
  'developed',
  'emerging',
  'europe',
  'eurozone',
  'us',
  'belgium',
  'other',
] as const
export type Region = (typeof REGIONS)[number]

/**
 * The EEA, because that is the passport that decides what a Belgian broker may sell.
 *
 * Written out rather than derived from a country-code library: the list is stable, and
 * a dependency that quietly adds a country would widen what advice may propose.
 * The UK is deliberately absent — its funds lost EU passporting, and a UK-domiciled
 * share class is generally not available to a Belgian retail investor any more.
 */
export const EEA_DOMICILES = [
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU',
  'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE',
  'SI', 'SK',
] as const
export type Domicile = (typeof EEA_DOMICILES)[number]

/** A three-letter currency code. Shape only: the price feed decides what exists. */
const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'is not a three-letter currency code')

/**
 * An ISIN, normalised, with the check digit verified.
 *
 * The message says what is wrong with *this* string rather than "invalid ISIN",
 * because the person reading it has a KID in front of them and needs to know whether
 * to re-read the last character or all twelve.
 */
const isin = z
  .string()
  .transform((value) => normaliseIsin(value) ?? '')
  .superRefine((value, ctx) => {
    const problem = isinProblem(value)
    if (problem !== null) {
      ctx.addIssue({ code: 'custom', message: `ISIN ${value || '(empty)'} ${problem}` })
    }
  })

/**
 * The day someone last read this fund's KID and agreed with the row.
 *
 * A future date is refused rather than warned about: it is either a typo or an attempt
 * to make an entry look permanently fresh, and both should be fixed in the file. How
 * old is too old is a setting, not a schema rule — see `FUND_UNIVERSE_MAX_AGE_DAYS`.
 */
const verifiedDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'is not a yyyy-mm-dd date')
  .superRefine((value, ctx) => {
    // Nothing to add when the shape is already wrong: the regex said so, and a second
    // sentence about the same character helps nobody.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return
    const day = Date.parse(`${value}T00:00:00Z`)
    if (Number.isNaN(day)) {
      ctx.addIssue({ code: 'custom', message: 'is not a real date' })
      return
    }
    if (day > Date.now()) {
      ctx.addIssue({
        code: 'custom',
        message: `is in the future: nobody verified this fund on ${value} yet`,
      })
    }
  })

export const fundSchema = z
  .object({
    isin,
    /** As the KID names it, so it can be compared against a broker's search box. */
    name: z.string().trim().min(3).max(140),
    /** The listing symbol, if it helps you find it. Never used as an identifier. */
    ticker: z.string().trim().min(1).max(12).optional(),
    asset_class: z.enum(ASSET_CLASSES),
    region: z.enum(REGIONS),
    /** The fund's own currency, which is not necessarily what you pay in. */
    currency,
    /** Ongoing charges, percent per year: `0.2` is twenty basis points. */
    ter_percent: z.number().min(0).max(3),
    domicile: z.enum(EEA_DOMICILES),
    /**
     * Accumulating only. The value is spelled out rather than implied so a file that
     * lists a distributing class fails with a sentence about tax instead of silently
     * dropping the entry.
     */
    distribution: z.literal('accumulating', {
      message:
        'must be accumulating: a distributing class pays dividends that Belgian ' +
        'roerende voorheffing taxes at 30% each year, which is a different decision',
    }),
    /** UCITS, because that is what makes a KID and a Belgian listing exist. */
    ucits: z.literal(true, { message: 'must be true: advice proposes UCITS funds only' }),
    /** Set when the share class hedges its currency exposure, e.g. `EUR`. */
    hedged_to: currency.optional(),
    /** The issuer's page for this share class — where the numbers above came from. */
    source: z.url(),
    last_verified: verifiedDate,
    /** Anything the next reader should know. Shown nowhere; read by people. */
    notes: z.string().trim().max(500).optional(),
  })
  .strict()

export type FundEntry = z.infer<typeof fundSchema>

export const universeFileSchema = z
  .object({
    /**
     * The file format's version, so a future change can be detected rather than
     * misread. One file, one number; there is no migration to write yet.
     */
    version: z.literal(1),
    funds: z.array(fundSchema),
  })
  .strict()

export type UniverseFile = z.infer<typeof universeFileSchema>
