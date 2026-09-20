import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  callOpenAiCompatibleWithConfig,
  normalizeFinishReason,
  OPENAI_BASE_URL,
  OpenAiCompatibleError,
  readOpenAiUsage,
  validateCustomBaseUrl,
  XAI_BASE_URL,
} from '../../src/adapters/openai-compatible/client.ts'

const realFetch = globalThis.fetch

const call = {
  model: 'gpt-5.4-mini',
  systemPrompt: 'Prioritise material findings.',
  instruction: 'Rank this month.',
  payload: { month: '2026-09', categories: [{ label: 'c1', spentCents: 42_000 }] },
}

function completion(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    model: 'gpt-5.4-mini-2026-09-01',
    choices: [{ message: { content: 'Useful answer.' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 30,
      prompt_tokens_details: { cached_tokens: 20 },
    },
    ...overrides,
  })
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => completion()) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.unstubAllEnvs()
})

describe.each([
  ['OpenAI', 'openai' as const, OPENAI_BASE_URL, 'openai-secret'],
  ['xAI', 'xai' as const, XAI_BASE_URL, 'xai-secret'],
])('%s preset', (_label, provider, baseUrl, apiKey) => {
  it('passes the provider-neutral free-text contract without exposing the payload in headers', async () => {
    const result = await callOpenAiCompatibleWithConfig({ provider, baseUrl, apiKey }, call)

    expect(result).toMatchObject({
      provider,
      text: 'Useful answer.',
      model: 'gpt-5.4-mini-2026-09-01',
      cached: true,
      finishReason: 'STOP',
      usage: { inputTokens: 100, cachedTokens: 20, cacheWriteTokens: 0, outputTokens: 30 },
    })
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!
    expect(url).toBe(`${baseUrl}/chat/completions`)
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${apiKey}`)
    expect(JSON.stringify(init?.headers)).not.toContain('2026-09')
  })
})

it('sends strict Chat Completions JSON Schema and keeps the financial data fenced', async () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { findings: { type: 'array', items: { type: 'string' } } },
    required: ['findings'],
  }
  globalThis.fetch = vi.fn(async () => completion({
    choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'length' }],
  })) as unknown as typeof fetch

  const result = await callOpenAiCompatibleWithConfig(
    { provider: 'openai', baseUrl: OPENAI_BASE_URL, apiKey: 'secret' },
    { ...call, responseJsonSchema: schema, maxOutputTokens: 123, temperature: 0 },
  )

  const init = vi.mocked(globalThis.fetch).mock.calls[0]![1]
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>
  expect(body['max_completion_tokens']).toBe(123)
  expect(body['response_format']).toEqual({
    type: 'json_schema',
    json_schema: { name: 'balancr_response', strict: true, schema },
  })
  expect(JSON.stringify(body['messages'])).toContain('<<<BALANCR_FINANCIAL_DATA')
  expect(result.finishReason).toBe('MAX_TOKENS')
})

it('keeps ordinary and cached input in non-overlapping usage bins', () => {
  expect(readOpenAiUsage({
    prompt_tokens: 40,
    completion_tokens: 4,
    prompt_tokens_details: { cached_tokens: 30 },
    cache_creation_input_tokens: 5,
  })).toEqual({ inputTokens: 5, outputTokens: 4, cachedTokens: 30, cacheWriteTokens: 5 })
  expect(readOpenAiUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 })
})

it('normalizes known and provider-specific finish reasons', () => {
  expect(normalizeFinishReason('length')).toBe('MAX_TOKENS')
  expect(normalizeFinishReason('content_filter')).toBe('SAFETY')
  expect(normalizeFinishReason('tool_calls')).toBe('TOOL_CALLS')
  expect(normalizeFinishReason(null)).toBeNull()
})

it('normalizes refusals, malformed responses, provider errors and redirects', async () => {
  const connection = { provider: 'openai' as const, baseUrl: OPENAI_BASE_URL, apiKey: 'never-log-this' }

  globalThis.fetch = vi.fn(async () => completion({
    choices: [{ message: { content: null, refusal: 'no' }, finish_reason: 'stop' }],
  })) as unknown as typeof fetch
  await expect(callOpenAiCompatibleWithConfig(connection, call)).rejects.toThrow('refused')

  globalThis.fetch = vi.fn(async () => Response.json({ nope: true })) as unknown as typeof fetch
  await expect(callOpenAiCompatibleWithConfig(connection, call)).rejects.toThrow('invalid Chat Completions')

  globalThis.fetch = vi.fn(async () => new Response('payload echoed by upstream', { status: 401 })) as unknown as typeof fetch
  const rejected = callOpenAiCompatibleWithConfig(connection, call)
  await expect(rejected).rejects.toThrow('authentication failed')
  await expect(rejected).rejects.not.toThrow('never-log-this')
  await expect(rejected).rejects.not.toThrow('payload echoed')

  globalThis.fetch = vi.fn(async () => new Response('', { status: 307, headers: { location: 'https://evil.test' } })) as unknown as typeof fetch
  await expect(callOpenAiCompatibleWithConfig(connection, call)).rejects.toThrow('redirect')
})

it('never reuses one tenant/provider credential for another call', async () => {
  await callOpenAiCompatibleWithConfig(
    { provider: 'openai', baseUrl: OPENAI_BASE_URL, apiKey: 'tenant-a' },
    call,
  )
  await callOpenAiCompatibleWithConfig(
    { provider: 'xai', baseUrl: XAI_BASE_URL, apiKey: 'tenant-b' },
    { ...call, model: 'grok-4.3' },
  )
  const calls = vi.mocked(globalThis.fetch).mock.calls
  expect(new Headers(calls[0]![1]?.headers).get('authorization')).toBe('Bearer tenant-a')
  expect(new Headers(calls[1]![1]?.headers).get('authorization')).toBe('Bearer tenant-b')
})

describe('custom base URL security', () => {
  const approved = ['proxy.internal', 'localhost']

  it('accepts an approved HTTPS path and explicit loopback HTTP', () => {
    expect(validateCustomBaseUrl('https://proxy.internal/openai/v1/', approved)).toBe(
      'https://proxy.internal/openai/v1',
    )
    expect(validateCustomBaseUrl('http://localhost:11434/v1', approved)).toBe('http://localhost:11434/v1')
  })

  it.each([
    ['https://other.internal/v1', 'not deployment-approved'],
    ['http://proxy.internal/v1', 'must use HTTPS'],
    ['https://user:password@proxy.internal/v1', 'must not contain credentials'],
    ['https://proxy.internal/v1?key=secret', 'must not contain a query'],
    ['https://proxy.internal/v1#fragment', 'must not contain a fragment'],
  ])('rejects %s', (url, message) => {
    expect(() => validateCustomBaseUrl(url, approved)).toThrow(message)
  })

  it('uses a provider-neutral error without embedding the URL', () => {
    try {
      validateCustomBaseUrl('not a url', approved)
      throw new Error('expected validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(OpenAiCompatibleError)
      expect((error as Error).message).not.toContain('not a url')
    }
  })

  it('calls an operator-approved compatible endpoint without code changes or a mandatory key', async () => {
    vi.stubEnv('EGRESS_EXTRA_HOSTS', 'custom-ai.test')
    vi.resetModules()
    const fresh = await import('../../src/adapters/openai-compatible/client.ts')
    globalThis.fetch = vi.fn(async () => completion()) as unknown as typeof fetch

    await fresh.callOpenAiCompatibleWithConfig(
      { provider: 'openai-compatible', baseUrl: 'https://custom-ai.test/gateway/v1', apiKey: null },
      { ...call, model: 'local-model' },
    )

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!
    expect(url).toBe('https://custom-ai.test/gateway/v1/chat/completions')
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
  })
})
