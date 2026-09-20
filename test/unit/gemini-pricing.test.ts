/**
 * The price table is what the cost guard believes, so its failure modes are the
 * ones worth pinning: a model id it does not recognise must be expensive rather
 * than free, a lite model must not be priced as its full sibling, and cached
 * input must be cheaper than fresh input or context caching is pointless.
 */
import { describe, expect, it } from 'vitest'
import {
  costMicroEur,
  estimateCostMicroEur,
  eurToMicroEur,
  FALLBACK_PRICE,
  MODEL_PRICES,
  microEurToEur,
  priceFor,
} from '../../src/adapters/ai/pricing.ts'

const PROVIDER = 'gemini-aistudio' as const

describe('priceFor', () => {
  it('matches a known model exactly', () => {
    const { price, known } = priceFor(PROVIDER, 'gemini-3.7-flash')
    expect(known).toBe(true)
    expect(price).toBe(MODEL_PRICES['gemini-3.7-flash'])
  })

  it('matches a dated or preview suffix to its family', () => {
    const { price, known } = priceFor(PROVIDER, 'gemini-3.1-pro-preview-04-01')
    expect(known).toBe(true)
    expect(price).toBe(MODEL_PRICES['gemini-3.1-pro'])
  })

  it('prefers the longest prefix, so lite is not priced as full flash', () => {
    const lite = priceFor(PROVIDER, 'gemini-3.7-flash-lite-preview')
    expect(lite.price).toBe(MODEL_PRICES['gemini-3.7-flash-lite'])
    expect(lite.price.input).toBeLessThan(
      (MODEL_PRICES['gemini-3.7-flash'] as { input: number }).input,
    )
  })

  it('is case- and whitespace-insensitive', () => {
    expect(priceFor(PROVIDER, '  Gemini-3.7-Flash  ').known).toBe(true)
  })

  it('falls back to the most expensive tier for an unknown model', () => {
    const { price, known } = priceFor(PROVIDER, 'some-new-model-nobody-priced')
    expect(known).toBe(false)
    expect(price).toBe(FALLBACK_PRICE)
    // The whole point: a model we cannot price must make the guard cautious.
    for (const entry of Object.values(MODEL_PRICES)) {
      expect(FALLBACK_PRICE.input).toBeGreaterThanOrEqual(entry.input)
      expect(FALLBACK_PRICE.output).toBeGreaterThanOrEqual(entry.output)
    }
  })

  it('prices cached input below fresh input for every model', () => {
    for (const entry of [...Object.values(MODEL_PRICES), FALLBACK_PRICE]) {
      expect(entry.cachedInput).toBeLessThan(entry.input)
    }
  })

  it('dates every entry', () => {
    for (const entry of [...Object.values(MODEL_PRICES), FALLBACK_PRICE]) {
      expect(entry.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

describe('costMicroEur', () => {
  it('bills a million input tokens at the table rate', () => {
    const price = MODEL_PRICES['gemini-3.7-flash'] as { input: number }
    expect(
      costMicroEur(PROVIDER, 'gemini-3.7-flash', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(price.input)
  })

  it('bills the cached share of the input at the cached rate', () => {
    const price = MODEL_PRICES['gemini-3.7-flash'] as { input: number; cachedInput: number }
    // 200k ordinary input plus 800k served from cache.
    const cost = costMicroEur(PROVIDER, 'gemini-3.7-flash', {
      inputTokens: 200_000,
      outputTokens: 0,
      cachedTokens: 800_000,
      cacheWriteTokens: 0,
    })
    expect(cost).toBe(Math.ceil(0.2 * price.input + 0.8 * price.cachedInput))
    expect(cost).toBeLessThan(price.input)
  })

  it('prices cache writes separately without billing them again as ordinary input', () => {
    const price = MODEL_PRICES['gemini-3.7-flash'] as { input: number; cacheWriteInput: number }
    const cost = costMicroEur(PROVIDER, 'gemini-3.7-flash', {
      inputTokens: 200_000,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 800_000,
    })

    expect(cost).toBe(Math.ceil(0.2 * price.input + 0.8 * price.cacheWriteInput))
  })

  it('never returns a negative cost when a provider reports a bad counter', () => {
    expect(
      costMicroEur(PROVIDER, 'gemini-3.7-flash', {
        inputTokens: -100,
        outputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeGreaterThanOrEqual(0)
  })

  it('rounds up, so the ledger never reads below what was charged', () => {
    const cost = costMicroEur(PROVIDER, 'gemini-3.7-flash', {
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(cost).toBe(3)
  })

  it('charges an unknown model at the fallback rate', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 }
    expect(costMicroEur(PROVIDER, 'mystery-model', usage)).toBe(FALLBACK_PRICE.input)
  })
})

describe('estimateCostMicroEur', () => {
  it('is generous enough to exceed the same call measured', () => {
    const chars = 12_000
    const estimate = estimateCostMicroEur(PROVIDER, 'gemini-3.7-flash', chars)
    const measured = costMicroEur(PROVIDER, 'gemini-3.7-flash', {
      inputTokens: chars / 4,
      outputTokens: 400,
      cachedTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(estimate).toBeGreaterThan(measured)
  })

  it('grows with the payload', () => {
    expect(estimateCostMicroEur(PROVIDER, 'gemini-3.7-flash', 40_000)).toBeGreaterThan(
      estimateCostMicroEur(PROVIDER, 'gemini-3.7-flash', 4_000),
    )
  })
})

describe('euro conversion', () => {
  it('round-trips a budget', () => {
    expect(microEurToEur(eurToMicroEur(15))).toBe(15)
  })

  it('keeps a cent exactly', () => {
    expect(eurToMicroEur(0.01)).toBe(10_000)
  })
})
