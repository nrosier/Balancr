import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  ANTHROPIC_BASE_URL,
  AnthropicError,
  callAnthropic,
  callAnthropicWithConfig,
  normalizeAnthropicStopReason,
  readAnthropicUsage,
} from '../../src/adapters/anthropic/client.ts'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { encryptField } from '../../src/db/field-crypto.ts'
import { createTestDb } from '../../src/db/index.ts'
import { tenantIntegrations } from '../../src/db/schema.ts'
import { importEnvIntegrationsOnce } from '../../src/db/tenant-integrations.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import {
  analysisJsonSchema,
  guessJsonSchema,
  nudgeJsonSchema,
  parseAnalysisResponse,
  parseGuessResponse,
  parseNudgeResponse,
} from '../../src/domain/ai/schemas.ts'
import { createSecondTenant } from '../helpers/second-tenant.ts'

const realFetch = globalThis.fetch
const call = {
  model: 'claude-sonnet-5',
  systemPrompt: 'Prioritise material findings.',
  instruction: 'Rank this month.',
  payload: { month: '2026-09', categories: [{ label: 'c1', spentCents: 42_000 }] },
}

function message(text = 'Useful narrative.', overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    model: 'claude-sonnet-5-20260901',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 50,
      output_tokens: 20,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 200,
    },
    ...overrides,
  })
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => message()) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

it('uses the native Messages API for a free-text narrative', async () => {
  const result = await callAnthropicWithConfig({ apiKey: 'claude-secret' }, call)

  expect(result).toMatchObject({
    provider: 'anthropic',
    text: 'Useful narrative.',
    model: 'claude-sonnet-5-20260901',
    cached: true,
    finishReason: 'STOP',
    usage: { inputTokens: 50, outputTokens: 20, cachedTokens: 200, cacheWriteTokens: 100 },
  })
  const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!
  expect(url).toBe(`${ANTHROPIC_BASE_URL}/messages`)
  const headers = new Headers(init?.headers)
  expect(headers.get('x-api-key')).toBe('claude-secret')
  expect(headers.get('anthropic-version')).toBe('2023-06-01')

  const body = JSON.parse(String(init?.body)) as Record<string, unknown>
  expect(body['max_tokens']).toBe(4_096)
  expect(body['system']).toEqual([
    expect.objectContaining({ type: 'text', cache_control: { type: 'ephemeral' } }),
  ])
  expect(JSON.stringify(body['system'])).not.toContain('2026-09')
  expect(JSON.stringify(body['messages'])).toContain('<<<BALANCR_FINANCIAL_DATA')
  expect(JSON.stringify(body['messages'])).toContain('2026-09')
})

describe.each([
  ['analysis', analysisJsonSchema, '{"findings":[],"clarifications":[]}', parseAnalysisResponse],
  ['category guess', guessJsonSchema, '{"guesses":[]}', parseGuessResponse],
  ['budget nudge', nudgeJsonSchema, '{"adjustments":[]}', parseNudgeResponse],
])('%s structured response', (_name, schemaOf, text, parse) => {
  it('sends native output_config.format and passes local domain validation', async () => {
    globalThis.fetch = vi.fn(async () => message(text)) as unknown as typeof fetch
    const schema = schemaOf()
    const result = await callAnthropicWithConfig(
      { apiKey: 'secret' },
      { ...call, responseJsonSchema: schema, maxOutputTokens: 321 },
    )

    const body = JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0]![1]?.body)) as Record<string, unknown>
    expect(body['max_tokens']).toBe(321)
    expect(body['output_config']).toEqual({ format: { type: 'json_schema', schema } })
    expect(() => parse(result.text)).not.toThrow()
  })
})

it('still rejects a structured response locally if an upstream ever violates the schema', async () => {
  globalThis.fetch = vi.fn(async () => message('{"findings":"not-an-array"}')) as unknown as typeof fetch
  const result = await callAnthropicWithConfig(
    { apiKey: 'secret' },
    { ...call, responseJsonSchema: analysisJsonSchema() },
  )
  expect(() => parseAnalysisResponse(result.text)).toThrow('did not match the analysis schema')
})

it('records ordinary input, cache creation, cache reads and output without overlap', () => {
  expect(readAnthropicUsage({
    input_tokens: 11,
    output_tokens: 22,
    cache_creation_input_tokens: 33,
    cache_read_input_tokens: 44,
  })).toEqual({ inputTokens: 11, outputTokens: 22, cacheWriteTokens: 33, cachedTokens: 44 })
  expect(readAnthropicUsage(undefined)).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cachedTokens: 0,
  })
})

it('normalizes native stop reasons', () => {
  expect(normalizeAnthropicStopReason('max_tokens')).toBe('MAX_TOKENS')
  expect(normalizeAnthropicStopReason('end_turn')).toBe('STOP')
  expect(normalizeAnthropicStopReason('stop_sequence')).toBe('STOP')
  expect(normalizeAnthropicStopReason('pause_turn')).toBe('PAUSE_TURN')
  expect(normalizeAnthropicStopReason(null)).toBeNull()
})

it('reports truncation through the provider-neutral finish reason', async () => {
  globalThis.fetch = vi.fn(async () => message('Partial', { stop_reason: 'max_tokens' })) as unknown as typeof fetch
  expect((await callAnthropicWithConfig({ apiKey: 'secret' }, call)).finishReason).toBe('MAX_TOKENS')
})

it('normalizes authentication, refusal, malformed response and timeout errors without secrets or payloads', async () => {
  globalThis.fetch = vi.fn(async () => new Response('echoed financial payload', { status: 401 })) as unknown as typeof fetch
  const auth = await callAnthropicWithConfig({ apiKey: 'never-log-this' }, call).catch((error: unknown) => error)
  expect(auth).toBeInstanceOf(AnthropicError)
  expect((auth as Error).message).toContain('authentication failed')
  expect((auth as Error).message).not.toContain('never-log-this')
  expect((auth as Error).message).not.toContain('financial payload')

  globalThis.fetch = vi.fn(async () => message('No', { stop_reason: 'refusal' })) as unknown as typeof fetch
  await expect(callAnthropicWithConfig({ apiKey: 'secret' }, call)).rejects.toThrow('refused')

  globalThis.fetch = vi.fn(async () => Response.json({ type: 'message' })) as unknown as typeof fetch
  await expect(callAnthropicWithConfig({ apiKey: 'secret' }, call)).rejects.toThrow('invalid Messages API')

  globalThis.fetch = vi.fn(async () => {
    throw new DOMException('aborted', 'TimeoutError')
  }) as unknown as typeof fetch
  await expect(callAnthropicWithConfig({ apiKey: 'secret' }, call)).rejects.toThrow('timed out')
})

it('refuses redirects and never sends a key to a second origin', async () => {
  const fetch = vi.fn(async () => new Response('', {
    status: 307,
    headers: { location: 'https://evil.example/messages' },
  }))
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  await expect(callAnthropicWithConfig({ apiKey: 'secret' }, call)).rejects.toThrow('redirect')
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('keeps credentials scoped to each call', async () => {
  await callAnthropicWithConfig({ apiKey: 'tenant-a' }, call)
  await callAnthropicWithConfig({ apiKey: 'tenant-b' }, { ...call, model: 'claude-opus-5' })
  const calls = vi.mocked(globalThis.fetch).mock.calls
  expect(new Headers(calls[0]![1]?.headers).get('x-api-key')).toBe('tenant-a')
  expect(new Headers(calls[1]![1]?.headers).get('x-api-key')).toBe('tenant-b')
})

it('resolves the selected key from the requested tenant only', async () => {
  const ctx = createTestDb()
  applyMigrations(ctx.db as never)
  importEnvIntegrationsOnce(ctx.db)
  const tenantA = getSoleTenantId(ctx.db)
  const tenantB = createSecondTenant(ctx.db)
  for (const [tenantId, apiKey] of [[tenantA, 'tenant-a-key'], [tenantB, 'tenant-b-key']] as const) {
    ctx.db.update(tenantIntegrations)
      .set({ aiProvider: 'anthropic', aiApiKeyEnc: encryptField(apiKey) })
      .where(eq(tenantIntegrations.tenantId, tenantId))
      .run()
  }

  await callAnthropic(ctx.db, tenantA, call)
  await callAnthropic(ctx.db, tenantB, call)

  const calls = vi.mocked(globalThis.fetch).mock.calls
  expect(new Headers(calls[0]![1]?.headers).get('x-api-key')).toBe('tenant-a-key')
  expect(new Headers(calls[1]![1]?.headers).get('x-api-key')).toBe('tenant-b-key')
  ctx.sqlite.close()
})
