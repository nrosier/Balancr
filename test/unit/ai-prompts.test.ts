/**
 * Prompt versioning.
 *
 * The prompt is the one tunable piece of text that decides whether the model
 * writes numbers, so the properties worth pinning are the ones that make an edit
 * safe to make: no edit destroys the text that produced last month's output,
 * exactly one version is active, an older version can be made active again, and
 * a run can always resolve *some* prompt even on a database whose prompt rows
 * were deleted.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { prompts } from '../../src/db/schema.ts'
import { config } from '../../src/config.ts'
import {
  activatePrompt,
  composeSystemPrompt,
  createPromptVersion,
  DEFAULT_PROMPTS,
  diffAgainstActive,
  languageDirective,
  listPromptVersions,
  loadActivePrompt,
  loadPrompt,
  nextVersion,
  PROMPT_KEYS,
  resolvePrompt,
  seedPrompts,
} from '../../src/domain/ai/prompts.ts'

let ctx: ReturnType<typeof createTestDb>
let db: ReturnType<typeof createTestDb>['db']

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  db = ctx.db
})

describe('built-in prompts', () => {
  it('exists for every key', () => {
    for (const key of PROMPT_KEYS) {
      expect(DEFAULT_PROMPTS[key].length).toBeGreaterThan(200)
    }
  })

  it('tells the analysis pass never to produce a number', () => {
    // The single most load-bearing sentence in the whole prompt: everything
    // downstream assumes the model returns codes and the renderer owns figures.
    expect(DEFAULT_PROMPTS['analysis.system']).toMatch(/[Nn]ever state, derive/)
  })

  it('tells the narrative pass not to do arithmetic on the figures it quotes', () => {
    expect(DEFAULT_PROMPTS['narrative.system']).toMatch(/Never add,\s*\n?\s*subtract/)
  })
})

describe('languageDirective', () => {
  it('names the language rather than passing a bare code', () => {
    // "reply in nl" is a weaker instruction than "reply in Dutch".
    expect(languageDirective('nl')).toContain('Dutch')
    expect(languageDirective('en')).toContain('English')
  })

  it('falls back to the code for a locale it has no name for', () => {
    expect(languageDirective('fr')).toContain('fr')
  })
})

describe('composeSystemPrompt', () => {
  it('appends the directive, so a stored body cannot omit it', () => {
    const composed = composeSystemPrompt('Be brief.', 'nl')
    expect(composed.startsWith('Be brief.')).toBe(true)
    expect(composed).toContain('Dutch')
  })
})

describe('seedPrompts', () => {
  it('writes one active version per key and locale', () => {
    const written = seedPrompts(db)
    expect(written).toBe(PROMPT_KEYS.length * config.SUPPORTED_LOCALES.length)

    for (const key of PROMPT_KEYS) {
      for (const locale of config.SUPPORTED_LOCALES) {
        const active = loadActivePrompt(db, key, locale)
        expect(active?.version).toBe(1)
        expect(active?.body).toBe(DEFAULT_PROMPTS[key])
      }
    }
  })

  it('is idempotent, so it can run at every startup', () => {
    seedPrompts(db)
    expect(seedPrompts(db)).toBe(0)
    expect(listPromptVersions(db, 'analysis.system', 'en')).toHaveLength(1)
  })

  it('leaves an edited prompt alone', () => {
    seedPrompts(db)
    createPromptVersion(db, {
      key: 'analysis.system',
      locale: 'en',
      body: 'Edited by hand.',
      activate: true,
    })

    expect(seedPrompts(db)).toBe(0)
    expect(loadActivePrompt(db, 'analysis.system', 'en')?.body).toBe('Edited by hand.')
  })
})

describe('createPromptVersion', () => {
  it('numbers versions from one and never reuses a number', () => {
    expect(nextVersion(db, 'analysis.system', 'en')).toBe(1)
    const first = createPromptVersion(db, { key: 'analysis.system', locale: 'en', body: 'one' })
    const second = createPromptVersion(db, { key: 'analysis.system', locale: 'en', body: 'two' })

    expect([first.version, second.version]).toEqual([1, 2])
    expect(nextVersion(db, 'analysis.system', 'en')).toBe(3)
  })

  it('counts versions per key and locale, not globally', () => {
    createPromptVersion(db, { key: 'analysis.system', locale: 'en', body: 'one' })
    const nl = createPromptVersion(db, { key: 'analysis.system', locale: 'nl', body: 'een' })
    const narrative = createPromptVersion(db, {
      key: 'narrative.system',
      locale: 'en',
      body: 'other',
    })

    expect(nl.version).toBe(1)
    expect(narrative.version).toBe(1)
  })

  it('stores a version without activating it, because editing is not shipping', () => {
    const row = createPromptVersion(db, { key: 'analysis.system', locale: 'en', body: 'draft' })
    expect(row.active).toBe(false)
    expect(loadActivePrompt(db, 'analysis.system', 'en')).toBeNull()
  })

  it('clears the previous active row when activating in the same step', () => {
    const first = createPromptVersion(db, {
      key: 'analysis.system',
      locale: 'en',
      body: 'one',
      activate: true,
    })
    const second = createPromptVersion(db, {
      key: 'analysis.system',
      locale: 'en',
      body: 'two',
      activate: true,
    })

    expect(loadPrompt(db, first.id)?.active).toBe(false)
    expect(loadActivePrompt(db, 'analysis.system', 'en')?.id).toBe(second.id)
  })

  it('keeps the text of every earlier version', () => {
    // The reason for versioning at all: last month's output must remain
    // explainable by the prompt that produced it.
    createPromptVersion(db, { key: 'analysis.system', locale: 'en', body: 'one', activate: true })
    createPromptVersion(db, { key: 'analysis.system', locale: 'en', body: 'two', activate: true })

    expect(listPromptVersions(db, 'analysis.system', 'en').map((row) => row.body)).toEqual([
      'two',
      'one',
    ])
  })

  it('trims the body, so trailing whitespace is not a version', () => {
    const row = createPromptVersion(db, { key: 'analysis.system', locale: 'en', body: '  one\n\n' })
    expect(row.body).toBe('one')
  })

  it('refuses an empty body', () => {
    expect(() =>
      createPromptVersion(db, { key: 'analysis.system', locale: 'en', body: '   \n ' }),
    ).toThrow(/cannot be empty/)
  })

  it('records the note and author for the audit trail', () => {
    const row = createPromptVersion(db, {
      key: 'analysis.system',
      locale: 'en',
      body: 'one',
      note: 'less hedging',
    })
    expect(row.note).toBe('less hedging')
    expect(row.createdBy).toBeNull()
  })
})

describe('activatePrompt', () => {
  it('rolls back to an older version with its text untouched', () => {
    const first = createPromptVersion(db, {
      key: 'analysis.system',
      locale: 'en',
      body: 'the good one',
      activate: true,
    })
    const second = createPromptVersion(db, {
      key: 'analysis.system',
      locale: 'en',
      body: 'the regression',
      activate: true,
    })

    const rolled = activatePrompt(db, first.id)

    expect(rolled.body).toBe('the good one')
    expect(rolled.active).toBe(true)
    expect(loadPrompt(db, second.id)?.active).toBe(false)
    expect(loadActivePrompt(db, 'analysis.system', 'en')?.id).toBe(first.id)
  })

  it('leaves exactly one active row, which the database also enforces', () => {
    const rows = [1, 2, 3].map((n) =>
      createPromptVersion(db, {
        key: 'analysis.system',
        locale: 'en',
        body: `body ${n}`,
        activate: true,
      }),
    )
    activatePrompt(db, (rows[1] as { id: string }).id)

    const active = db
      .select()
      .from(prompts)
      .where(eq(prompts.active, true))
      .all()
      .filter((row) => row.key === 'analysis.system' && row.locale === 'en')
    expect(active).toHaveLength(1)
  })

  it('does not touch another locale sharing the key', () => {
    const en = createPromptVersion(db, {
      key: 'analysis.system',
      locale: 'en',
      body: 'english',
      activate: true,
    })
    const nl = createPromptVersion(db, {
      key: 'analysis.system',
      locale: 'nl',
      body: 'nederlands',
      activate: true,
    })

    activatePrompt(db, en.id)
    expect(loadPrompt(db, nl.id)?.active).toBe(true)
  })

  it('errors on an id that does not exist', () => {
    expect(() => activatePrompt(db, 'nope')).toThrow(/does not exist/)
  })
})

describe('resolvePrompt', () => {
  it('uses the locale, when the locale has an active version', () => {
    seedPrompts(db)
    createPromptVersion(db, {
      key: 'analysis.system',
      locale: 'nl',
      body: 'nederlandse versie',
      activate: true,
    })

    const resolved = resolvePrompt(db, 'analysis.system', 'nl')
    expect(resolved.body).toBe('nederlandse versie')
    expect(resolved.locale).toBe('nl')
    expect(resolved.id).not.toBeNull()
  })

  it('falls back to the default locale rather than to nothing', () => {
    // A Dutch prompt nobody has written yet is better served by the English one.
    createPromptVersion(db, {
      key: 'analysis.system',
      locale: config.DEFAULT_LOCALE,
      body: 'the english one',
      activate: true,
    })

    const resolved = resolvePrompt(db, 'analysis.system', 'nl')
    expect(resolved.body).toBe('the english one')
    expect(resolved.locale).toBe(config.DEFAULT_LOCALE)
  })

  it('falls back to the built-in text when no row is active anywhere', () => {
    // A database whose prompt rows were deleted must still be able to run.
    const resolved = resolvePrompt(db, 'narrative.system', 'nl')
    expect(resolved.body).toBe(DEFAULT_PROMPTS['narrative.system'])
    expect(resolved.id).toBeNull()
    expect(resolved.version).toBe(0)
  })

  it('ignores an inactive version, however recent', () => {
    createPromptVersion(db, { key: 'analysis.system', locale: 'en', body: 'a draft' })
    expect(resolvePrompt(db, 'analysis.system', 'en').body).toBe(
      DEFAULT_PROMPTS['analysis.system'],
    )
  })
})

describe('diffAgainstActive', () => {
  it('diffs against the active version', () => {
    createPromptVersion(db, {
      key: 'analysis.system',
      locale: 'en',
      body: 'line one\nline two',
      activate: true,
    })

    const { active, diff } = diffAgainstActive(
      db,
      'analysis.system',
      'en',
      'line one\nline two changed',
    )
    expect(active.version).toBe(1)
    expect(diff.stat).toEqual({ added: 1, removed: 1, identical: false })
  })

  it('shows a real diff on a fresh database, against the built-in text', () => {
    const { active, diff } = diffAgainstActive(db, 'analysis.system', 'en', 'Be brief.')
    expect(active.version).toBe(0)
    expect(diff.stat.identical).toBe(false)
    expect(diff.stat.removed).toBeGreaterThan(0)
  })

  it('reports an unchanged body as identical, so activating is visibly a no-op', () => {
    seedPrompts(db)
    const { diff } = diffAgainstActive(
      db,
      'analysis.system',
      'en',
      `\n${DEFAULT_PROMPTS['analysis.system']}\n`,
    )
    expect(diff.stat.identical).toBe(true)
  })
})
