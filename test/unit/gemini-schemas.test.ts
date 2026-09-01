/**
 * What the model is allowed to say back.
 *
 * The tests that matter are the refusals. A closed vocabulary stops an invented
 * *code*; it does nothing about a real code attached to a category nothing was
 * computed for, which is the shape a plausible hallucination actually takes. That
 * is `groundResponse`'s job, and it is the reason a finding on the page can be
 * trusted to have a number behind it.
 */
import { describe, expect, it } from 'vitest'
import {
  analysisJsonSchema,
  groundResponse,
  GeminiResponseError,
  GUESS_MAX_CHARS,
  HOUSEHOLD_LABEL,
  parseAnalysisResponse,
  type AnalysisResponse,
} from '../../src/adapters/gemini/schemas.ts'
import { FINDING_CODES } from '../../src/domain/ai/codes.ts'
import type { RedactedPayload, RedactedSignal } from '../../src/domain/ai/redact.ts'

function signal(
  code: RedactedSignal['code'],
  label: string | null,
  severity: RedactedSignal['severity'] = 'warn',
): RedactedSignal {
  return { code, label, severity, metrics: { overspendCents: 8_000 } }
}

function payload(overrides: Partial<RedactedPayload> = {}): RedactedPayload {
  return {
    month: '2026-03',
    locale: 'en',
    currency: 'EUR',
    totals: {
      month: '2026-03',
      incomeCents: 380_000,
      spentCents: 310_000,
      budgetedCents: 320_000,
      savingsRateBp: 1_842,
    },
    history: [],
    netWorth: null,
    hygiene: {
      scoreBp: 10_000,
      uncategorisedCount: 0,
      uncategorisedCents: 0,
      mismatchCount: 0,
    },
    categories: [
      {
        label: 'c1',
        name: 'Groceries',
        income: false,
        spentCents: 42_000,
        budgetedCents: 38_000,
        availableCents: -4_000,
        txnCount: 31,
      },
      {
        label: 'c2',
        name: 'Transport',
        income: false,
        spentCents: 9_000,
        budgetedCents: 12_000,
        availableCents: 3_000,
        txnCount: 4,
      },
    ],
    accounts: [{ label: 'a1', source: 'actual', kind: 'checking', inNetWorth: true }],
    portfolio: null,
    signals: [signal('over_available', 'c1'), signal('savings_rate_low', null, 'warn')],
    ...overrides,
  }
}

const response = (over: Partial<AnalysisResponse> = {}): AnalysisResponse => ({
  findings: [],
  clarifications: [],
  ...over,
})

describe('analysisJsonSchema', () => {
  it('restricts code to the finding vocabulary', () => {
    const json = JSON.stringify(analysisJsonSchema())
    for (const code of FINDING_CODES) expect(json).toContain(`"${code}"`)
    // No union types anywhere: the narrowest schema is the one most likely to
    // survive a provider change, which is why `label` is a sentinel not a null.
    expect(json).not.toContain('"null"')
  })

  it('forbids extra properties, so a stray field is a parse failure', () => {
    expect(JSON.stringify(analysisJsonSchema())).toContain('"additionalProperties":false')
  })
})

describe('parseAnalysisResponse', () => {
  it('parses a well-formed response', () => {
    const parsed = parseAnalysisResponse(
      JSON.stringify({
        findings: [{ code: 'over_available', label: 'c1', severity: 'alert', confidence: 90 }],
        clarifications: [],
      }),
    )
    expect(parsed.findings).toHaveLength(1)
  })

  it('tolerates a fenced code block, because that is formatting not content', () => {
    const parsed = parseAnalysisResponse(
      '```json\n{"findings":[],"clarifications":[]}\n```',
    )
    expect(parsed).toEqual({ findings: [], clarifications: [] })
  })

  it('errors on text that is not JSON, rather than rendering a guess', () => {
    expect(() => parseAnalysisResponse('I looked at your budget and')).toThrow(GeminiResponseError)
  })

  it('errors on an unknown finding code', () => {
    expect(() =>
      parseAnalysisResponse(
        JSON.stringify({
          findings: [{ code: 'you_spend_too_much', label: 'c1', severity: 'alert', confidence: 90 }],
          clarifications: [],
        }),
      ),
    ).toThrow(GeminiResponseError)
  })

  it('errors on an out-of-range confidence', () => {
    expect(() =>
      parseAnalysisResponse(
        JSON.stringify({
          findings: [{ code: 'over_available', label: 'c1', severity: 'warn', confidence: 200 }],
          clarifications: [],
        }),
      ),
    ).toThrow(GeminiResponseError)
  })

  it('errors on a missing array rather than defaulting it', () => {
    expect(() => parseAnalysisResponse(JSON.stringify({ findings: [] }))).toThrow(
      GeminiResponseError,
    )
  })

  it('keeps the raw text on the error, so a failure can be inspected', () => {
    try {
      parseAnalysisResponse('not json at all')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(GeminiResponseError)
      expect((error as GeminiResponseError).raw).toBe('not json at all')
    }
  })
})

describe('groundResponse', () => {
  it('keeps a finding that matches a computed signal, with its numbers', () => {
    const grounded = groundResponse(
      response({
        findings: [{ code: 'over_available', label: 'c1', severity: 'alert', confidence: 88 }],
      }),
      payload(),
    )
    expect(grounded.findings).toHaveLength(1)
    expect(grounded.findings[0]?.signal.metrics).toEqual({ overspendCents: 8_000 })
    expect(grounded.dropped).toEqual([])
  })

  it('drops a real code about a category with no computed signal', () => {
    const grounded = groundResponse(
      response({
        findings: [{ code: 'over_available', label: 'c2', severity: 'alert', confidence: 95 }],
      }),
      payload(),
    )
    expect(grounded.findings).toEqual([])
    expect(grounded.dropped).toEqual([{ code: 'over_available', label: 'c2', reason: 'no_signal' }])
  })

  it('drops a code the payload never carried for any label', () => {
    const grounded = groundResponse(
      response({
        findings: [{ code: 'stale_prices', label: HOUSEHOLD_LABEL, severity: 'warn', confidence: 50 }],
      }),
      payload(),
    )
    expect(grounded.findings).toEqual([])
    expect(grounded.dropped[0]?.reason).toBe('no_signal')
  })

  it('maps the household sentinel back to a null label', () => {
    const grounded = groundResponse(
      response({
        findings: [
          { code: 'savings_rate_low', label: HOUSEHOLD_LABEL, severity: 'warn', confidence: 70 },
        ],
      }),
      payload(),
    )
    expect(grounded.findings[0]?.label).toBeNull()
  })

  it('preserves the model ranking, which is the answer being paid for', () => {
    const grounded = groundResponse(
      response({
        findings: [
          { code: 'savings_rate_low', label: HOUSEHOLD_LABEL, severity: 'warn', confidence: 60 },
          { code: 'over_available', label: 'c1', severity: 'alert', confidence: 99 },
        ],
      }),
      payload(),
    )
    expect(grounded.findings.map((finding) => finding.code)).toEqual([
      'savings_rate_low',
      'over_available',
    ])
  })

  it('drops a repeat of the same finding, keeping the first', () => {
    const grounded = groundResponse(
      response({
        findings: [
          { code: 'over_available', label: 'c1', severity: 'alert', confidence: 90 },
          { code: 'over_available', label: 'c1', severity: 'info', confidence: 10 },
        ],
      }),
      payload(),
    )
    expect(grounded.findings).toHaveLength(1)
    expect(grounded.findings[0]?.confidence).toBe(90)
    expect(grounded.dropped[0]?.reason).toBe('duplicate')
  })

  it('lets the model lower a severity', () => {
    const grounded = groundResponse(
      response({
        findings: [{ code: 'over_available', label: 'c1', severity: 'info', confidence: 40 }],
      }),
      payload(),
    )
    expect(grounded.findings[0]?.severity).toBe('info')
  })

  it('clamps a severity the code may not carry', () => {
    // `savings_rate_low` tops out at warn: the threshold that would justify an
    // alert lives in settings, not in a sentence.
    const grounded = groundResponse(
      response({
        findings: [
          { code: 'savings_rate_low', label: HOUSEHOLD_LABEL, severity: 'alert', confidence: 99 },
        ],
      }),
      payload(),
    )
    expect(grounded.findings[0]?.severity).toBe('warn')
  })

  it('keeps a clarification about a category in the payload', () => {
    const grounded = groundResponse(
      response({
        clarifications: [{ code: 'purpose_unknown', label: 'c2', guess: 'Public transport pass' }],
      }),
      payload(),
    )
    expect(grounded.clarifications).toEqual([
      { code: 'purpose_unknown', label: 'c2', guess: 'Public transport pass' },
    ])
  })

  it('drops a clarification about an account or the household', () => {
    const grounded = groundResponse(
      response({
        clarifications: [
          { code: 'purpose_unknown', label: 'a1', guess: 'the current account' },
          { code: 'purpose_unknown', label: HOUSEHOLD_LABEL, guess: 'everything' },
        ],
      }),
      payload(),
    )
    expect(grounded.clarifications).toEqual([])
    expect(grounded.dropped.map((item) => item.reason)).toEqual(['unknown_label', 'unknown_label'])
  })

  it('drops a guess outside the answer vocabulary', () => {
    const grounded = groundResponse(
      response({
        clarifications: [{ code: 'nature_unknown', label: 'c1', guess: 'sort of fixed' }],
      }),
      payload(),
    )
    expect(grounded.clarifications).toEqual([])
    expect(grounded.dropped[0]?.reason).toBe('bad_guess')
  })

  it('keeps a guess that is a valid category_meta value', () => {
    const grounded = groundResponse(
      response({
        clarifications: [{ code: 'nature_unknown', label: 'c1', guess: 'variable' }],
      }),
      payload(),
    )
    expect(grounded.clarifications[0]?.guess).toBe('variable')
  })

  it('collapses whitespace in a free-text guess and truncates it', () => {
    const long = `Groceries  and\n household   ${'x'.repeat(GUESS_MAX_CHARS)}`
    const grounded = groundResponse(
      response({ clarifications: [{ code: 'purpose_unknown', label: 'c1', guess: long }] }),
      payload(),
    )
    const guess = grounded.clarifications[0]?.guess as string
    expect(guess.length).toBe(GUESS_MAX_CHARS)
    expect(guess).not.toContain('\n')
    expect(guess.startsWith('Groceries and household ')).toBe(true)
  })

  it('drops everything when the payload carried no signals at all', () => {
    const grounded = groundResponse(
      response({
        findings: [{ code: 'over_available', label: 'c1', severity: 'alert', confidence: 90 }],
      }),
      payload({ signals: [] }),
    )
    expect(grounded.findings).toEqual([])
  })
})
