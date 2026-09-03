/**
 * The fund universe file: loading, refusing, and the gate (#40).
 *
 * Real files in a temp directory rather than a mocked `readFileSync`, for the same
 * reason as `env-file.test.ts`: what is under test is the reading of a file somebody
 * hand-edited, including how it fails, and a mock would only assert that this test
 * agrees with itself about YAML.
 *
 * Every staleness assertion passes an explicit `asOf`. A test that used the real clock
 * would pass today and fail on a date nobody chose — except for the last block, which
 * checks the shipped template and is deliberately time-dependent.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  EMPTY_UNIVERSE,
  UniverseError,
  assertProposable,
  isStale,
  loadUniverse,
  lookupFund,
  proposableIsinSchema,
  staleFunds,
  universeForPrompt,
  universeOrEmpty,
  verificationAgeDays,
} from '../../src/domain/universe/universe.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'balancr-universe-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Writes a universe file and returns its path. */
function universeFile(body: string): string {
  const path = join(dir, 'fund-universe.yaml')
  writeFileSync(path, body)
  return path
}

/** One valid entry, with any field replaced or removed by a line of YAML. */
function entry(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    isin: 'IE00B4L5Y983',
    name: 'iShares Core MSCI World UCITS ETF USD (Acc)',
    ticker: 'IWDA',
    asset_class: 'equity',
    region: 'world',
    currency: 'USD',
    ter_percent: '0.20',
    domicile: 'IE',
    distribution: 'accumulating',
    ucits: 'true',
    source: 'https://www.ishares.com/example',
    last_verified: '2026-09-01',
    ...overrides,
  }
  return Object.entries(fields)
    .map(([key, value], index) => `${index === 0 ? '  - ' : '    '}${key}: ${value}`)
    .join('\n')
}

/** A whole file around one or more entries. */
function file(entries: string[], version = '1'): string {
  return `version: ${version}\nfunds:\n${entries.join('\n')}\n`
}

describe('loadUniverse', () => {
  it('reads a file and indexes it by ISIN', () => {
    const path = universeFile(file([entry()]))
    const universe = loadUniverse(path)

    expect(universe.path).toBe(path)
    expect(universe.funds).toHaveLength(1)
    expect(universe.funds[0]?.ticker).toBe('IWDA')
    expect(universe.byIsin.get('IE00B4L5Y983')?.ter_percent).toBe(0.2)
  })

  it('keeps file order, because a person chose it', () => {
    const path = universeFile(
      file([
        entry({ isin: 'IE00BK5BQT80', name: 'Vanguard FTSE All-World (Acc)' }),
        entry({ isin: 'IE00B4L5Y983', name: 'iShares Core MSCI World (Acc)' }),
      ]),
    )
    expect(loadUniverse(path).funds.map((fund) => fund.isin)).toEqual([
      'IE00BK5BQT80',
      'IE00B4L5Y983',
    ])
  })

  it('treats a missing file as an empty universe, not an error', () => {
    // A new install, or somebody who wants the budget half only (#165's spirit).
    expect(loadUniverse(join(dir, 'nothing-here.yaml'))).toBe(EMPTY_UNIVERSE)
  })

  it('treats an emptied file as no funds rather than a schema violation', () => {
    const path = universeFile('')
    const universe = loadUniverse(path)
    expect(universe.path).toBe(path)
    expect(universe.funds).toEqual([])
  })

  it('names the line when the YAML is malformed', () => {
    // The whole point of the message: this file is eighty entries long in real use.
    const path = universeFile('version: 1\nfunds:\n\t- isin: IE00B4L5Y983\n')
    expect(() => loadUniverse(path)).toThrow(/is not valid YAML at line 3, column 1/)
  })

  it('refuses two rows for one ISIN, naming both', () => {
    const path = universeFile(
      file([entry({ name: 'World, cheap version' }), entry({ name: 'World, old row' })]),
    )
    expect(() => loadUniverse(path)).toThrow(/lists IE00B4L5Y983 twice/)
    expect(() => loadUniverse(path)).toThrow(/World, cheap version.*World, old row/s)
  })

  it('names the path in every message, because the path is the likely mistake', () => {
    const path = universeFile(file([entry({ ucits: 'false' })]))
    expect(() => loadUniverse(path)).toThrow(new RegExp(path.replace(/[.]/g, '\\.')))
  })
})

describe('the rules the schema enforces', () => {
  /** The message thrown for a file containing one entry with these overrides. */
  function refusalFor(overrides: Record<string, string>): string {
    const path = universeFile(file([entry(overrides)]))
    try {
      loadUniverse(path)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    throw new Error('expected the entry to be refused')
  }

  it('refuses a distributing share class, and says it is about tax', () => {
    expect(refusalFor({ distribution: 'distributing' })).toMatch(/roerende voorheffing/)
  })

  it('refuses a non-EEA domicile', () => {
    // This is why VTI is not on the list: no KID, and no Belgian broker can sell it.
    expect(refusalFor({ isin: 'US9229087690', domicile: 'US' })).toMatch(/domicile/)
  })

  it('refuses a non-UCITS fund', () => {
    expect(refusalFor({ ucits: 'false' })).toMatch(/UCITS funds only/)
  })

  it('refuses a mistyped ISIN with the reason', () => {
    expect(refusalFor({ isin: 'IE00B4L5Y984' })).toMatch(/check digit is 3/)
  })

  it('refuses a TER that is out by two orders of magnitude', () => {
    // `20` for a 0.20% fund is the mistake `ter_percent` is named to prevent, and the
    // range is the backstop for when the name does not help.
    expect(refusalFor({ ter_percent: '20' })).toMatch(/ter_percent/)
  })

  it('refuses a last_verified in the future', () => {
    expect(refusalFor({ last_verified: '2027-01-01' })).toMatch(/last_verified/)
  })

  it('refuses a source that is not a URL', () => {
    expect(refusalFor({ source: 'the KID I read once' })).toMatch(/source/)
  })

  it('refuses a key nobody defined', () => {
    // Strict, so a typo like `ter_pecent` is a refusal rather than a silent default.
    expect(refusalFor({ ter_pecent: '0.20' })).toMatch(/ter_pecent/)
  })

  it('refuses a file format version it does not know', () => {
    const path = universeFile(file([entry()], '2'))
    expect(() => loadUniverse(path)).toThrow(/version/)
  })
})

describe('universeOrEmpty', () => {
  it('returns the universe when the file is good', () => {
    const path = universeFile(file([entry()]))
    expect(universeOrEmpty(path).funds).toHaveLength(1)
  })

  it('swallows a broken file so the rest of the app still serves', () => {
    // A typo in a fund list must not take the budget pages down; the callers that are
    // about to propose money use `loadUniverse` and get the exception.
    const path = universeFile('version: 1\nfunds: "not a list"\n')
    expect(universeOrEmpty(path)).toBe(EMPTY_UNIVERSE)
  })
})

describe('lookupFund', () => {
  it('finds a fund however the ISIN was pasted', () => {
    const universe = loadUniverse(universeFile(file([entry()])))
    for (const spelling of ['IE00B4L5Y983', 'ie00b4l5y983', 'IE00 B4L5 Y983']) {
      expect(lookupFund(universe, spelling)?.ticker).toBe('IWDA')
    }
  })

  it('returns null for an unknown or empty ISIN', () => {
    const universe = loadUniverse(universeFile(file([entry()])))
    expect(lookupFund(universe, 'IE00B5BMR087')).toBeNull()
    expect(lookupFund(universe, '  ')).toBeNull()
  })
})

describe('staleness', () => {
  const asOf = new Date('2026-09-03T12:00:00Z')

  it('counts whole days since the entry was confirmed', () => {
    const universe = loadUniverse(universeFile(file([entry({ last_verified: '2026-08-04' })])))
    expect(verificationAgeDays(universe.funds[0]!, asOf)).toBe(30)
  })

  it('is only stale past the configured window', () => {
    const universe = loadUniverse(universeFile(file([entry({ last_verified: '2026-08-04' })])))
    const fund = universe.funds[0]!
    expect(isStale(fund, { asOf, maxAgeDays: 30 })).toBe(false)
    expect(isStale(fund, { asOf, maxAgeDays: 29 })).toBe(true)
  })

  it('lists the entries needing attention, oldest first', () => {
    const universe = loadUniverse(
      universeFile(
        file([
          entry({ isin: 'IE00B4L5Y983', last_verified: '2026-01-15' }),
          entry({ isin: 'IE00BK5BQT80', last_verified: '2025-03-02' }),
          entry({ isin: 'IE00B5BMR087', last_verified: '2026-09-01' }),
        ]),
      ),
    )
    expect(staleFunds(universe, { asOf, maxAgeDays: 90 }).map((f) => f.isin)).toEqual([
      'IE00BK5BQT80',
      'IE00B4L5Y983',
    ])
  })

  it('treats a future date as fresh, because a wrong clock is not a reason to stop', () => {
    // The schema already refuses a future date, so reaching this means the clock moved.
    const universe = loadUniverse(universeFile(file([entry({ last_verified: '2026-09-01' })])))
    expect(isStale(universe.funds[0]!, { asOf: new Date('2020-01-01T00:00:00Z') })).toBe(false)
  })

  it('uses FUND_UNIVERSE_MAX_AGE_DAYS when no window is given', () => {
    // The default is 365; an entry from four years ago is stale under it and would not
    // be under a window this test invented.
    const universe = loadUniverse(universeFile(file([entry({ last_verified: '2022-01-03' })])))
    expect(isStale(universe.funds[0]!)).toBe(true)
  })
})

describe('assertProposable', () => {
  const asOf = new Date('2026-09-03T12:00:00Z')

  it('returns the fund for an ISIN in the universe', () => {
    const universe = loadUniverse(universeFile(file([entry()])))
    expect(assertProposable(universe, 'ie00 b4l5 y983', { asOf }).ticker).toBe('IWDA')
  })

  it('refuses an ISIN the model invented, naming the file to add it to', () => {
    const path = universeFile(file([entry()]))
    const universe = loadUniverse(path)
    expect(() => assertProposable(universe, 'IE00B5BMR087', { asOf })).toThrow(UniverseError)
    expect(() => assertProposable(universe, 'IE00B5BMR087', { asOf })).toThrow(
      new RegExp(`IE00B5BMR087 is not in ${path.replace(/[.]/g, '\\.')}`),
    )
  })

  it('says the universe is empty rather than naming a file there is none of', () => {
    expect(() => assertProposable(EMPTY_UNIVERSE, 'IE00B4L5Y983')).toThrow(
      /the fund universe is empty/,
    )
  })

  it('refuses a stale entry and says what to do about it', () => {
    // The refusal that turns "re-check the list some day" into a thing that stops
    // working: it names the age and the page to check it against.
    const universe = loadUniverse(universeFile(file([entry({ last_verified: '2025-01-02' })])))
    expect(() => assertProposable(universe, 'IE00B4L5Y983', { asOf })).toThrow(
      /was last verified 2025-01-02, 609 days ago; re-check it against https/,
    )
  })
})

describe('proposableIsinSchema', () => {
  const asOf = new Date('2026-09-03T12:00:00Z')

  /** The shape a proposal payload will have (#41), with the gate as its parser. */
  function payloadSchema(path: string) {
    return z.object({
      instrument: proposableIsinSchema(loadUniverse(path), { asOf }),
      amount_cents: z.number().int().positive(),
    })
  }

  it('parses an ISIN into the fund itself, so a handler cannot hold a bare string', () => {
    const schema = payloadSchema(universeFile(file([entry()])))
    const parsed = schema.parse({ instrument: 'IE00B4L5Y983', amount_cents: 50_000 })
    expect(parsed.instrument.name).toContain('MSCI World')
    expect(parsed.instrument.ter_percent).toBe(0.2)
  })

  it('fails the whole payload when the instrument is outside the universe', () => {
    const schema = payloadSchema(universeFile(file([entry()])))
    const result = schema.safeParse({ instrument: 'US0378331005', amount_cents: 50_000 })
    expect(result.success).toBe(false)
    expect(z.prettifyError(result.error!)).toMatch(/US0378331005 is not in/)
  })

  it('fails the payload for a stale instrument too', () => {
    const schema = payloadSchema(universeFile(file([entry({ last_verified: '2025-01-02' })])))
    const result = schema.safeParse({ instrument: 'IE00B4L5Y983', amount_cents: 50_000 })
    expect(result.success).toBe(false)
    expect(z.prettifyError(result.error!)).toMatch(/re-check it against/)
  })
})

describe('universeForPrompt', () => {
  const asOf = new Date('2026-09-03T12:00:00Z')

  it('sends only the fields a suggestion could turn on', () => {
    const universe = loadUniverse(
      universeFile(file([entry({ notes: 'the cheapest of the three' })])),
    )
    expect(universeForPrompt(universe, { asOf })).toEqual([
      {
        isin: 'IE00B4L5Y983',
        name: 'iShares Core MSCI World UCITS ETF USD (Acc)',
        asset_class: 'equity',
        region: 'world',
        currency: 'USD',
        ter_percent: 0.2,
        domicile: 'IE',
      },
    ])
  })

  it('omits the ticker deliberately', () => {
    // A symbol can mean two things on two exchanges, so a suggestion has to come back
    // as an ISIN that this list can be matched against.
    const universe = loadUniverse(universeFile(file([entry()])))
    expect(Object.keys(universeForPrompt(universe, { asOf })[0]!)).not.toContain('ticker')
  })

  it('keeps hedged_to, because it changes what the fund is', () => {
    const universe = loadUniverse(
      universeFile(
        file([
          entry({
            isin: 'IE00BDBRDM35',
            name: 'iShares Core Global Aggregate Bond EUR Hedged (Acc)',
            asset_class: 'bond',
            hedged_to: 'EUR',
          }),
        ]),
      ),
    )
    expect(universeForPrompt(universe, { asOf })[0]?.hedged_to).toBe('EUR')
  })

  it('excludes stale entries, so the model cannot name one that would be refused', () => {
    // A refusal at apply time reads as the app breaking; not offering it reads as the
    // list needing attention, which is what it is.
    const universe = loadUniverse(
      universeFile(
        file([
          entry({ isin: 'IE00B4L5Y983', last_verified: '2024-02-02' }),
          entry({ isin: 'IE00B5BMR087', last_verified: '2026-09-01' }),
        ]),
      ),
    )
    expect(universeForPrompt(universe, { asOf }).map((f) => f.isin)).toEqual(['IE00B5BMR087'])
  })
})

describe('the shipped template', () => {
  const path = 'config/fund-universe.example.yaml'

  it('parses under the schema it is an example of', () => {
    // It is copied by hand into a volume and it is data, so nothing but a test reads it
    // before a person does. A typo here ships.
    const universe = loadUniverse(path)
    expect(universe.funds.length).toBeGreaterThan(5)
  })

  it('spans more than equities, so a risk profile has something to hold', () => {
    const classes = new Set(loadUniverse(path).funds.map((fund) => fund.asset_class))
    expect(classes).toContain('equity')
    expect(classes).toContain('bond')
    expect(classes).toContain('cash')
  })

  it('is still inside its own verification window', () => {
    // Deliberately dependent on today's date: a template whose entries are past
    // FUND_UNIVERSE_MAX_AGE_DAYS would load, propose nothing, and look broken. When
    // this fails, the fix is to re-read each fund's KID and update `last_verified` —
    // not to widen the window.
    expect(staleFunds(loadUniverse(path)).map((fund) => fund.isin)).toEqual([])
  })
})
