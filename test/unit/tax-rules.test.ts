/**
 * The Belgian tax rules file: loading it, refusing it, and dating it (#42).
 *
 * Real files in a temp directory, like the fund universe tests and for the same reason:
 * what is under test is a file a person edits by hand, including every way that goes
 * wrong, and a mocked reader would only prove this test agrees with itself.
 *
 * Fixtures are built as objects and serialised with `yaml.stringify`, because a ruleset
 * is five rules deep and a hand-written string fixture per refusal would be unreadable.
 * The exception is the YAML-level failure, which is raw text — there is no other way to
 * write a file that does not parse.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import {
  TaxRulesError,
  assertRulesInForceOn,
  isoDay,
  loadTaxRules,
  oldestVerification,
  rulesInForceOn,
  rulesOf,
  taxRulesOrNull,
  transcribedRules,
} from '../../src/domain/tax/rules.ts'
import { conditionsOf, percentToBp } from '../../src/domain/tax/schema.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'balancr-tax-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Writes a rules file — an object to serialise, or raw text — and returns its path. */
function rulesFile(body: unknown): string {
  const path = join(dir, 'belgian-tax.yaml')
  writeFileSync(path, typeof body === 'string' ? body : stringify(body))
  return path
}

const PROVENANCE = {
  citation: 'WDRT art. 1262, §1 — taks op de beursverrichtingen',
  last_verified: '2026-09-01',
  status: 'transcribed',
}

function tiers(): Record<string, unknown>[] {
  return [
    {
      id: 'fund_acc_registered',
      when: { kind: 'fund', distribution: 'accumulating', fsma_registered: true },
      rate_percent: 1.32,
      cap_eur: 4000,
      ...PROVENANCE,
    },
    {
      id: 'fund_acc_unregistered',
      when: { kind: 'fund', distribution: 'accumulating', fsma_registered: false },
      rate_percent: 0.12,
      cap_eur: 1300,
      ...PROVENANCE,
    },
    { id: 'fund_default', when: { kind: 'fund' }, rate_percent: 0.12, cap_eur: 1300, ...PROVENANCE },
    {
      id: 'share_default',
      when: { kind: 'share' },
      rate_percent: 0.35,
      cap_eur: 1600,
      ...PROVENANCE,
    },
    { id: 'bond_default', when: { kind: 'bond' }, rate_percent: 0.12, cap_eur: 1300, ...PROVENANCE },
  ]
}

function ruleset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    effective_from: '2026-01-01',
    beurstaks: { tiers: tiers() },
    roerende_voorheffing: { rate_percent: 30, ...PROVENANCE },
    reynders: { rate_percent: 30, debt_claims_threshold_percent: 10, ...PROVENANCE },
    meerwaarde: { rate_percent: 10, annual_exemption_eur: 10_000, ...PROVENANCE },
    ...overrides,
  }
}

function file(rulesets: Record<string, unknown>[] = [ruleset()]): Record<string, unknown> {
  return { version: 1, jurisdiction: 'BE', rulesets }
}

/** The message a broken file produces, for asserting on its wording. */
function refusalFor(body: unknown): string {
  const path = rulesFile(body)
  try {
    loadTaxRules(path)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the rules file to be refused')
}

describe('percentToBp', () => {
  it('converts the rates Belgian tax actually uses', () => {
    expect(percentToBp(0.12)).toBe(12)
    expect(percentToBp(0.35)).toBe(35)
    expect(percentToBp(1.32)).toBe(132)
    expect(percentToBp(30)).toBe(3_000)
    expect(percentToBp(0)).toBe(0)
  })

  it('survives the float that made a tolerance necessary', () => {
    // A percentage times a hundred is not always the integer it looks like, so an
    // equality check here would refuse a perfectly ordinary two-decimal rate.
    expect(0.29 * 100).not.toBe(29)
    expect(percentToBp(0.29)).toBe(29)
    expect(percentToBp(0.07)).toBe(7)
    expect(percentToBp(1.11)).toBe(111)
  })

  it('refuses a third decimal, which is a typo rather than a rate', () => {
    expect(percentToBp(0.125)).toBeNull()
    expect(percentToBp(1.3251)).toBeNull()
  })
})

describe('loading the rules file', () => {
  it('reads a valid file and sorts the rulesets newest first', () => {
    const path = rulesFile(
      file([ruleset({ effective_from: '2018-01-01' }), ruleset({ effective_from: '2026-01-01' })]),
    )
    const rules = loadTaxRules(path)
    expect(rules.path).toBe(path)
    expect(rules.jurisdiction).toBe('BE')
    expect(rules.rulesets.map((set) => set.effective_from)).toEqual(['2026-01-01', '2018-01-01'])
  })

  it('names the shipped file when there is none at the path', () => {
    // The one refusal that is about a path rather than a file, and the one where the
    // useful sentence says where the file Balancr ships actually is.
    const missing = join(dir, 'nowhere.yaml')
    expect(() => loadTaxRules(missing)).toThrow(TaxRulesError)
    expect(() => loadTaxRules(missing)).toThrow(
      /there is no tax rules file at .*nowhere\.yaml; Balancr ships one at config\/belgian-tax\.yaml/,
    )
  })

  it('reports the line and column of a YAML error', () => {
    const message = refusalFor('version: 1\njurisdiction: BE\n\trulesets: []\n')
    expect(message).toMatch(/is not valid YAML at line 3, column 1/)
  })

  it('names the path in every message', () => {
    const path = join(dir, 'belgian-tax.yaml')
    expect(refusalFor(file([ruleset({ effective_from: 'yesterday' })]))).toContain(path)
    expect(refusalFor('\t')).toContain(path)
  })

  it('refuses a version it does not understand', () => {
    expect(refusalFor({ ...file(), version: 2 })).toMatch(/version/)
  })

  it('refuses another jurisdiction rather than pretending the rates transfer', () => {
    expect(refusalFor({ ...file(), jurisdiction: 'NL' })).toMatch(/jurisdiction/)
  })

  it('refuses an unknown key, because a typo would silently keep the old rate', () => {
    const set = ruleset()
    expect(refusalFor(file([{ ...set, rate_percnet: 30 }]))).toMatch(/rate_percnet/)
  })

  it('refuses a rate with three decimals', () => {
    const set = ruleset({ roerende_voorheffing: { rate_percent: 30.125, ...PROVENANCE } })
    expect(refusalFor(file([set]))).toMatch(/two decimals/)
  })

  it('refuses a rate above 100%', () => {
    const set = ruleset({ roerende_voorheffing: { rate_percent: 130, ...PROVENANCE } })
    expect(refusalFor(file([set]))).toMatch(/100/)
  })

  it('refuses a citation too short to identify anything', () => {
    const set = ruleset({ roerende_voorheffing: { rate_percent: 30, ...PROVENANCE, citation: 'WIB' } })
    expect(refusalFor(file([set]))).toMatch(/citation/)
  })

  it('refuses a status outside confirmed and transcribed', () => {
    const set = ruleset({ roerende_voorheffing: { rate_percent: 30, ...PROVENANCE, status: 'ok' } })
    expect(refusalFor(file([set]))).toMatch(/status/)
  })

  it('refuses a verification date in the future, the obvious way around staleness', () => {
    const set = ruleset({
      roerende_voorheffing: { rate_percent: 30, ...PROVENANCE, last_verified: '2099-01-01' },
    })
    expect(refusalFor(file([set]))).toMatch(/nobody verified this on 2099-01-01 yet/)
  })

  it('refuses two rulesets starting on the same day', () => {
    expect(refusalFor(file([ruleset(), ruleset()]))).toMatch(
      /two rulesets effective from 2026-01-01/,
    )
  })

  it('refuses a cap of zero euros, which would tax nothing', () => {
    const [first, ...rest] = tiers()
    const set = ruleset({ beurstaks: { tiers: [{ ...first, cap_eur: 0 }, ...rest] } })
    expect(refusalFor(file([set]))).toMatch(/cap_eur/)
  })
})

describe('the beurstaks tier list', () => {
  it('refuses a kind with no unconditional tier, so no transaction lacks a rate', () => {
    const set = ruleset({
      beurstaks: { tiers: tiers().filter((tier) => tier['id'] !== 'bond_default') },
    })
    expect(refusalFor(file([set]))).toMatch(
      /has no unconditional tier for bond: add one whose `when` is only `kind: bond`/,
    )
  })

  it('names every kind that is missing one', () => {
    const set = ruleset({ beurstaks: { tiers: [tiers()[0] as Record<string, unknown>] } })
    const message = refusalFor(file([set]))
    expect(message).toMatch(/unconditional tier for share/)
    expect(message).toMatch(/unconditional tier for bond/)
    expect(message).toMatch(/unconditional tier for fund/)
  })

  it('refuses a general tier placed above the specific ones it would hide', () => {
    // The dangerous file: `fund_default` first means the 1.32% tier is never reached, and
    // nothing about reading the file says so — the estimate is simply eleven times low.
    const list = tiers()
    const reordered = [list[2], list[0], list[1], list[3], list[4]]
    const set = ruleset({ beurstaks: { tiers: reordered } })
    const message = refusalFor(file([set]))
    expect(message).toMatch(/tier "fund_default" applies to every fund and comes before/)
    expect(message).toMatch(/"fund_acc_registered", "fund_acc_unregistered"/)
    expect(message).toMatch(/can therefore never apply — move it below them/)
  })

  it('accepts a file where the specific tiers come first', () => {
    expect(() => loadTaxRules(rulesFile(file()))).not.toThrow()
  })

  it('reports which facts a tier depends on', () => {
    const rules = loadTaxRules(rulesFile(file()))
    const set = rules.rulesets[0]
    expect(set).toBeDefined()
    const list = set?.beurstaks.tiers ?? []
    expect(conditionsOf(list[0]!)).toEqual(['distribution', 'fsma_registered'])
    expect(conditionsOf(list[2]!)).toEqual([])
  })
})

describe('which rules were in force', () => {
  const twoSets = () =>
    file([ruleset({ effective_from: '2018-01-01' }), ruleset({ effective_from: '2026-01-01' })])

  it('picks the newest ruleset that has begun', () => {
    const rules = loadTaxRules(rulesFile(twoSets()))
    expect(rulesInForceOn(rules, '2026-09-03')?.effective_from).toBe('2026-01-01')
    expect(rulesInForceOn(rules, '2026-01-01')?.effective_from).toBe('2026-01-01')
    expect(rulesInForceOn(rules, '2025-12-31')?.effective_from).toBe('2018-01-01')
  })

  it('answers nothing for a day before the file starts, rather than guessing', () => {
    const rules = loadTaxRules(rulesFile(twoSets()))
    expect(rulesInForceOn(rules, '2017-12-31')).toBeNull()
    expect(() => assertRulesInForceOn(rules, '2017-12-31')).toThrow(TaxRulesError)
    expect(() => assertRulesInForceOn(rules, '2017-12-31')).toThrow(
      /has no rules for 2017-12-31; the oldest ruleset in it starts 2018-01-01/,
    )
  })

  it('defaults to today', () => {
    const rules = loadTaxRules(rulesFile(twoSets()))
    expect(rulesInForceOn(rules)).toEqual(rulesInForceOn(rules, isoDay()))
  })
})

describe('provenance across a ruleset', () => {
  it('names the rules, not the beurstaks tier that happened to be oldest', () => {
    // The bug this pins: a tier carries its own `id`, and spreading it into `{ id: 'tob' }`
    // replaced the rule's name with the tier's. Nothing failed — the estimate simply
    // reported using no unchecked rules while using four.
    const rules = loadTaxRules(rulesFile(file()))
    const set = rules.rulesets[0]
    expect(set).toBeDefined()
    if (set === undefined) return
    expect(rulesOf(set).map((rule) => rule.id)).toEqual([
      'tob',
      'roerendeVoorheffing',
      'reynders',
      'meerwaarde',
    ])
    expect(transcribedRules(set)).toEqual([
      'tob',
      'roerendeVoorheffing',
      'reynders',
      'meerwaarde',
    ])
  })

  it('leaves out the rules somebody has confirmed', () => {
    const set = ruleset({
      roerende_voorheffing: { rate_percent: 30, ...PROVENANCE, status: 'confirmed' },
    })
    const rules = loadTaxRules(rulesFile(file([set])))
    const only = rules.rulesets[0]
    expect(only).toBeDefined()
    if (only === undefined) return
    expect(transcribedRules(only)).not.toContain('roerendeVoorheffing')
  })

  it('takes the beurstaks block to be as fresh as its stalest tier', () => {
    const list = tiers()
    const set = ruleset({
      beurstaks: {
        tiers: [{ ...list[0], last_verified: '2024-03-01' }, ...list.slice(1)],
      },
    })
    const rules = loadTaxRules(rulesFile(file([set])))
    const only = rules.rulesets[0]
    expect(only).toBeDefined()
    if (only === undefined) return
    const oldest = oldestVerification(only, new Date('2026-09-03T00:00:00Z'))
    expect(oldest).toEqual({ rule: 'tob', date: '2024-03-01', ageDays: 916 })
  })
})

describe('taxRulesOrNull', () => {
  it('swallows a broken file so the pages it appears on still serve', () => {
    expect(taxRulesOrNull(rulesFile('\t'))).toBeNull()
    expect(taxRulesOrNull(join(dir, 'nothing-here.yaml'))).toBeNull()
  })

  it('returns the rules when the file is fine', () => {
    expect(taxRulesOrNull(rulesFile(file()))?.rulesets).toHaveLength(1)
  })
})

describe('the shipped rules file', () => {
  // Deliberately the real file, deliberately pinning its figures: it is what every
  // container computes tax with, and a rate edited without a thought belongs in a failing
  // test rather than in an estimate. When a rate genuinely changes, this test changes with
  // it — and that is the moment to set `last_verified` and `status` too.
  const rules = loadTaxRules('config/belgian-tax.yaml')

  it('parses, and covers both the 2018 and the 2026 rules', () => {
    expect(rules.jurisdiction).toBe('BE')
    expect(rules.rulesets.map((set) => set.effective_from)).toEqual(['2026-01-01', '2018-01-01'])
  })

  it('taxes gains from 2026 and not before', () => {
    expect(rulesInForceOn(rules, '2026-01-01')?.meerwaarde.rate_percent).toBe(10)
    expect(rulesInForceOn(rules, '2026-01-01')?.meerwaarde.annual_exemption_eur).toBe(10_000)
    expect(rulesInForceOn(rules, '2025-12-31')?.meerwaarde.rate_percent).toBe(0)
  })

  it('carries the beurstaks tiers that decide a Belgian fund choice', () => {
    const set = rulesInForceOn(rules, '2026-06-01')
    const byId = new Map((set?.beurstaks.tiers ?? []).map((tier) => [tier.id, tier]))
    expect(byId.get('fund_accumulating_registered')?.rate_percent).toBe(1.32)
    expect(byId.get('fund_accumulating_registered')?.cap_eur).toBe(4_000)
    expect(byId.get('fund_accumulating_unregistered')?.rate_percent).toBe(0.12)
    expect(byId.get('share_default')?.rate_percent).toBe(0.35)
    expect(byId.get('bond_default')?.rate_percent).toBe(0.12)
  })

  it('ships with nothing confirmed, which is what the caveat depends on', () => {
    const set = rulesInForceOn(rules, '2026-06-01')
    expect(set).not.toBeNull()
    if (set === null) return
    expect(transcribedRules(set)).toEqual([
      'tob',
      'roerendeVoorheffing',
      'reynders',
      'meerwaarde',
    ])
  })

  it('says nothing about a transaction before 2018 rather than guessing', () => {
    expect(rulesInForceOn(rules, '2017-06-01')).toBeNull()
  })
})
