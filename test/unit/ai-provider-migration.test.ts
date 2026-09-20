/** Regression coverage for the provider-neutral persistence migration (#422). */
import { afterEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { seedPreMigrationDb } from '../helpers/pre-migration-db.ts'

const TENANT_ID = 'd020a702-3d59-456c-a944-99c04894a42c'

let contexts: ReturnType<typeof createTestDb>[] = []

afterEach(() => {
  for (const context of contexts) context.sqlite.close()
  contexts = []
})

function legacyDatabase(provider: 'aistudio' | 'vertex') {
  const context = createTestDb()
  contexts.push(context)
  seedPreMigrationDb(context.sqlite, '0030_smart_karnak')

  context.sqlite
    .prepare(
      `insert into tenant_integrations (
        tenant_id, actual_server_url, actual_password_enc, actual_sync_id,
        ghostfolio_url, ghostfolio_security_token_enc, gemini_provider,
        gemini_api_key_enc, google_cloud_project, gemini_model_fast,
        gemini_model_deep, gemini_monthly_budget_eur_micro, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      TENANT_ID,
      'https://actual.example.test',
      'actual-ciphertext',
      'sync-id',
      'https://ghostfolio.example.test',
      'ghostfolio-ciphertext',
      provider,
      provider === 'aistudio' ? 'gemini-key-ciphertext' : null,
      provider === 'vertex' ? 'vertex-project' : null,
      'legacy-fast-model',
      'legacy-deep-model',
      42_000_000,
      1,
    )
  context.sqlite
    .prepare(
      `insert into ai_runs (
        id, tenant_id, kind, model, locale, payload_json, input_tokens,
        output_tokens, cached_tokens, cost_micro_eur, status, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `legacy-${provider}-run`,
      TENANT_ID,
      'findings',
      'legacy-fast-model',
      'en',
      '{}',
      100,
      20,
      10,
      123,
      'ok',
      Date.parse('2026-09-15T00:00:00Z'),
    )

  applyMigrations(context.db as never)
  return context.sqlite
}

describe('provider-neutral AI migration', () => {
  it.each([
    ['aistudio', 'gemini-aistudio', 'gemini-key-ciphertext', null],
    ['vertex', 'gemini-vertex', null, 'vertex-project'],
  ] as const)(
    'preserves a legacy %s installation and attributes its run to %s',
    (legacyProvider, expectedProvider, expectedKey, expectedProject) => {
      const sqlite = legacyDatabase(legacyProvider)
      const integration = sqlite
        .prepare(
          `select ai_provider, ai_api_key_enc, google_cloud_project,
                  ai_model_fast, ai_model_deep, ai_monthly_budget_eur_micro
           from tenant_integrations where tenant_id = ?`,
        )
        .get(TENANT_ID) as Record<string, unknown>

      expect(integration).toEqual({
        ai_provider: expectedProvider,
        ai_api_key_enc: expectedKey,
        google_cloud_project: expectedProject,
        ai_model_fast: 'legacy-fast-model',
        ai_model_deep: 'legacy-deep-model',
        ai_monthly_budget_eur_micro: 42_000_000,
      })
      expect(
        sqlite
          .prepare('select provider, cache_write_tokens from ai_runs where id = ?')
          .get(`legacy-${legacyProvider}-run`),
      ).toEqual({ provider: expectedProvider, cache_write_tokens: 0 })
      expect(
        sqlite
          .prepare(
            `select run_count, input_tokens, output_tokens, cached_tokens,
                    cache_write_tokens, cost_micro_eur
             from ai_spend_monthly where tenant_id = ? and month = '2026-09'`,
          )
          .get(TENANT_ID),
      ).toEqual({
        run_count: 1,
        input_tokens: 90,
        output_tokens: 20,
        cached_tokens: 10,
        cache_write_tokens: 0,
        cost_micro_eur: 123,
      })
    },
  )
})
