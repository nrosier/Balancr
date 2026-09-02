/**
 * What the browser bundle assumes about the server, checked from the side that can
 * actually read the schemas.
 *
 * A `web/` test cannot import a Zod *value*. `schemas.ts` reaches `params.ts` →
 * `logger.ts` → `config.ts`, which throws on a process with no `ACTUAL_PASSWORD` — and
 * the web project has none, deliberately, because a browser bundle importing the
 * server's configuration would be a bug worth failing loudly on. So every assertion
 * about "the client's copy still matches the server's definition" has to live here, in
 * a Node-project test, and the client's copies are kept in JSX-free modules
 * (`web/src/settings/kinds.ts`) precisely so this file can import them.
 *
 * Two kinds of drift are policed:
 *
 *  - **A literal the client re-states.** `ACCOUNT_KINDS` is the account-kind select's
 *    option list. Deriving it from the accounts on screen would look tidier and would
 *    quietly break the deployment that has no credit card yet: `credit` is the kind
 *    that stops a card payment being counted as spend, so a list that only contains
 *    the kinds already in use can never be used to fix the mapping.
 *  - **A catalogue key the client builds from a name.** The settings page addresses
 *    `settings:thresholds.field.<group>.<field>`, `settings:prompt.key.<key>`,
 *    `common:accountKind.<kind>`, `settings:ai.reason.<reason>`, `common:status.<s>`
 *    and `common:severity.<s>` — none of which any grep for a literal will find. A
 *    threshold added to `aggregate/params.ts` appears on the page with no edit, which
 *    is the design; without this file it would appear untranslated, which is not.
 *
 * The status and reason lists are typed as exhaustive `Record`s rather than written as
 * arrays, so widening `AnalysisReason` fails `tsc` here instead of shipping a page that
 * prints a raw code.
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { initI18n, t } from '../../src/i18n/index.ts'
import { accountSettingSchema, aiDryRunSchema } from '../../src/server/routes/api/schemas.ts'
import { DEFAULT_PARAMS } from '../../src/domain/aggregate/params.ts'
import { PROMPT_KEYS } from '../../src/domain/ai/prompts.ts'
import type { AnalysisReason, AnalysisStatus } from '../../src/domain/ai/analysis.ts'
import { ACCOUNT_KINDS } from '../../web/src/settings/kinds.ts'

const LANGUAGES = ['en', 'nl'] as const

/** Every value of the union, enforced by the compiler rather than by a comment. */
const REASONS: Record<AnalysisReason, true> = {
  ok: true,
  no_facts: true,
  month_budget_exceeded: true,
  estimate_exceeds_remaining: true,
  call_failed: true,
  bad_response: true,
}

const STATUSES: Record<AnalysisStatus, true> = {
  ok: true,
  capped: true,
  error: true,
  skipped: true,
}

/** Both enums live inline in `aiDryRunSchema`, so they are read out of it. */
const SEVERITIES = aiDryRunSchema.shape.findings.element.shape.severity.options
const DROPPED_REASONS = aiDryRunSchema.shape.dropped.element.shape.reason.options

/** Asserts the key resolves in both languages to something a person can read. */
function translated(key: string): void {
  for (const lang of LANGUAGES) {
    const text = t(lang, key)
    expect(text, `${lang} ${key}`).not.toBe('')
    // A catalogue that answers with the key itself is the failure this guards against.
    expect(text, `${lang} ${key}`).not.toContain(key.split(':')[1] ?? key)
  }
}

beforeAll(async () => {
  await initI18n()
})

describe('the account-kind list the client re-states', () => {
  it('is exactly the set the server will accept', () => {
    expect([...ACCOUNT_KINDS]).toEqual([...accountSettingSchema.shape.kind.options])
  })

  it('names every kind in both languages', () => {
    for (const kind of ACCOUNT_KINDS) translated(`common:accountKind.${kind}`)
  })
})

describe('the settings keys built from a name', () => {
  it('labels every threshold group and field', () => {
    const groups = Object.entries(DEFAULT_PARAMS)
    // A guard on the guard: an empty schema would make every loop below vacuous.
    expect(groups.length).toBeGreaterThan(0)

    for (const [group, fields] of groups) {
      translated(`settings:thresholds.group.${group}`)
      const names = Object.keys(fields as Record<string, number>)
      expect(names.length, group).toBeGreaterThan(0)
      for (const field of names) translated(`settings:thresholds.field.${group}.${field}`)
    }
  })

  it('names every prompt the editor can select', () => {
    for (const key of PROMPT_KEYS) translated(`settings:prompt.key.${key}`)
  })

  it('explains every reason a run can be refused or cut short', () => {
    for (const reason of Object.keys(REASONS)) translated(`settings:ai.reason.${reason}`)
  })

  it('words every run status and finding severity', () => {
    for (const status of Object.keys(STATUSES)) translated(`common:status.${status}`)
    for (const severity of SEVERITIES) translated(`common:severity.${severity}`)
  })

  it('explains every reason grounding throws a finding away', () => {
    expect(DROPPED_REASONS.length).toBeGreaterThan(0)
    for (const reason of DROPPED_REASONS) {
      translated(`settings:prompt.dryRun.droppedReason.${reason}`)
    }
  })
})
