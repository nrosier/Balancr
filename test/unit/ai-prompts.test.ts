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
import { readFileSync } from 'node:fs'
import { eq, sql } from 'drizzle-orm'
import { applyMigrations, migrationsFolder } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { prompts } from '../../src/db/schema.ts'
import { config } from '../../src/config.ts'
import { SHARED_LOCALE } from '../../src/domain/ai/prompt-locale.ts'
import {
  activatePrompt,
  composeSystemPrompt,
  createPromptVersion,
  deactivateOverride,
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
  type PromptKey,
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
  it('writes one shared version per key, not one per key per locale', () => {
    // The per-locale seed is what made the locale fallback unreachable: every
    // language had an active row of its own, so an edit made in one stopped
    // applying to the other with nothing reporting it.
    const written = seedPrompts(db)
    expect(written).toBe(PROMPT_KEYS.length)

    for (const key of PROMPT_KEYS) {
      const active = loadActivePrompt(db, key, SHARED_LOCALE)
      expect(active?.version).toBe(1)
      expect(active?.body).toBe(DEFAULT_PROMPTS[key])

      for (const locale of config.SUPPORTED_LOCALES) {
        expect(loadActivePrompt(db, key, locale)).toBeNull()
      }
    }
  })

  it('is what every language resolves to', () => {
    seedPrompts(db)

    for (const key of PROMPT_KEYS) {
      for (const locale of config.SUPPORTED_LOCALES) {
        const resolved = resolvePrompt(db, key, locale)
        expect(resolved.body).toBe(DEFAULT_PROMPTS[key])
        expect(resolved.locale).toBe(SHARED_LOCALE)
        expect(resolved.id).not.toBeNull()
      }
    }
  })

  it('is idempotent, so it can run at every startup', () => {
    seedPrompts(db)
    expect(seedPrompts(db)).toBe(0)
    expect(listPromptVersions(db, 'analysis.system', SHARED_LOCALE)).toHaveLength(1)
  })

  it('leaves an edited prompt alone', () => {
    seedPrompts(db)
    createPromptVersion(db, {
      key: 'analysis.system',
      locale: SHARED_LOCALE,
      body: 'Edited by hand.',
      activate: true,
    })

    expect(seedPrompts(db)).toBe(0)
    expect(loadActivePrompt(db, 'analysis.system', SHARED_LOCALE)?.body).toBe('Edited by hand.')
  })

  it('writes the shared row even when a language already has an override', () => {
    // The state a partly-diverged database is left in by the migration: the
    // override survives, and the shared text it will fall back to gets written.
    createPromptVersion(db, {
      key: 'analysis.system',
      locale: 'nl',
      body: 'een eigen versie',
      activate: true,
    })

    expect(seedPrompts(db)).toBe(PROMPT_KEYS.length)
    expect(resolvePrompt(db, 'analysis.system', 'nl').body).toBe('een eigen versie')
    expect(resolvePrompt(db, 'analysis.system', 'en').body).toBe(DEFAULT_PROMPTS['analysis.system'])
  })
})

describe('deactivateOverride', () => {
  it('sends a language back to the shared text without deleting its versions', () => {
    createPromptVersion(db, {
      key: 'analysis.system',
      locale: SHARED_LOCALE,
      body: 'the shared one',
      activate: true,
    })
    createPromptVersion(db, {
      key: 'analysis.system',
      locale: 'nl',
      body: 'de Nederlandse versie',
      activate: true,
    })

    expect(deactivateOverride(db, 'analysis.system', 'nl')).toBe(1)
    expect(resolvePrompt(db, 'analysis.system', 'nl').body).toBe('the shared one')
    // Still readable, and reactivating it is the ordinary rollback.
    expect(listPromptVersions(db, 'analysis.system', 'nl')).toHaveLength(1)
  })

  it('reports no change when the language had no override', () => {
    createPromptVersion(db, {
      key: 'analysis.system',
      locale: SHARED_LOCALE,
      body: 'the shared one',
      activate: true,
    })

    expect(deactivateOverride(db, 'analysis.system', 'nl')).toBe(0)
  })

  it('refuses the shared prompt itself', () => {
    // Deactivating it would leave every language on the built-in constant, with
    // nothing in the UI saying so.
    expect(() => deactivateOverride(db, 'analysis.system', SHARED_LOCALE)).toThrow(
      /cannot be deactivated/,
    )
  })
})

describe('the one-active-version index', () => {
  it('refuses a second active row for the same key and locale', () => {
    // The database enforces this, not the module remembering to clear the old flag —
    // and it has to keep enforcing it for the shared rows, which is the argument for
    // a sentinel over NULL: SQLite treats NULLs in a unique index as distinct.
    const first = createPromptVersion(db, {
      key: 'analysis.system',
      locale: SHARED_LOCALE,
      body: 'one',
      activate: true,
    })
    const second = createPromptVersion(db, {
      key: 'analysis.system',
      locale: SHARED_LOCALE,
      body: 'two',
      activate: false,
    })

    expect(() => db.update(prompts).set({ active: true }).where(eq(prompts.id, second.id)).run())
      .toThrow(/UNIQUE constraint failed/)
    expect(loadActivePrompt(db, 'analysis.system', SHARED_LOCALE)?.id).toBe(first.id)
  })
})

describe('the 0010 collapse', () => {
  /**
   * Replays the shipped statements rather than a paraphrase of them. By the time a
   * test database exists the migration has already run over an empty table, so the
   * only way to exercise it is to write the pre-migration rows and run the file's own
   * SQL — worth the awkwardness, because this runs once, unattended, over the rows
   * that carry the instructions the model is given.
   */
  const collapse = (): void => {
    const source = readFileSync(`${migrationsFolder}/0010_shared_prompt_locale.sql`, 'utf8')
    const statements = source
      .split('--> statement-breakpoint')
      .map((part) => part.trim())
      .filter((part) => part !== '')
    // Two statements, in order: the DELETE that drops the duplicates, then the
    // UPDATE that renames what is left. Reversing them would rename before there is
    // one row to rename.
    expect(statements).toHaveLength(2)
    for (const statement of statements) ctx.db.run(sql.raw(statement))
  }

  /** What the old seed wrote: the same text under every supported locale. */
  const seededPerLocale = (key: PromptKey, body: string): void => {
    for (const locale of config.SUPPORTED_LOCALES) {
      createPromptVersion(db, { key, locale, body, note: 'built-in default', activate: true })
    }
  }

  const localesOf = (key: PromptKey): string[] =>
    db
      .select()
      .from(prompts)
      .all()
      .filter((row) => row.key === key)
      .map((row) => row.locale)
      .sort()

  it('collapses the per-locale copies to one shared row', () => {
    seededPerLocale('analysis.system', 'the seeded text')

    collapse()

    expect(localesOf('analysis.system')).toEqual([SHARED_LOCALE])
    const active = loadActivePrompt(db, 'analysis.system', SHARED_LOCALE)
    expect(active?.body).toBe('the seeded text')
    expect(active?.version).toBe(1)
    // Which is the whole point: the shared row is what a Dutch run now reads.
    expect(resolvePrompt(db, 'analysis.system', 'nl').locale).toBe(SHARED_LOCALE)
  })

  it('keeps the row that was active', () => {
    seededPerLocale('analysis.system', 'the seeded text')

    collapse()

    expect(loadActivePrompt(db, 'analysis.system', SHARED_LOCALE)).not.toBeNull()
  })

  it('leaves a key alone once someone has edited one language', () => {
    // Two distinct texts means a deliberate divergence, and no edit may be destroyed
    // to tidy it up — nor may one language's version be promoted to shared, because
    // nothing says which language should win.
    seededPerLocale('analysis.system', 'the seeded text')
    createPromptVersion(db, {
      key: 'analysis.system',
      locale: 'en',
      body: 'improved by hand',
      activate: true,
    })

    collapse()

    expect(localesOf('analysis.system')).toEqual(['en', 'en', 'nl'])
    expect(loadActivePrompt(db, 'analysis.system', 'en')?.body).toBe('improved by hand')
    expect(loadActivePrompt(db, 'analysis.system', 'nl')?.body).toBe('the seeded text')
  })

  it('collapses one key while leaving a diverged one intact', () => {
    seededPerLocale('analysis.system', 'the seeded text')
    seededPerLocale('narrative.system', 'the other seeded text')
    createPromptVersion(db, {
      key: 'narrative.system',
      locale: 'nl',
      body: 'met de hand aangepast',
      activate: true,
    })

    collapse()

    expect(localesOf('analysis.system')).toEqual([SHARED_LOCALE])
    expect(localesOf('narrative.system')).toEqual(['en', 'nl', 'nl'])
  })

  it('changes nothing on a second run', () => {
    seededPerLocale('analysis.system', 'the seeded text')
    collapse()
    const before = db.select().from(prompts).all()

    collapse()

    expect(db.select().from(prompts).all()).toEqual(before)
  })

  it('does nothing to an empty table', () => {
    collapse()
    expect(db.select().from(prompts).all()).toEqual([])
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

  it('falls back to the shared text rather than to nothing', () => {
    // The ordinary case: one canonical prompt, and no language owns a copy of it.
    createPromptVersion(db, {
      key: 'analysis.system',
      locale: SHARED_LOCALE,
      body: 'the shared one',
      activate: true,
    })

    const resolved = resolvePrompt(db, 'analysis.system', 'nl')
    expect(resolved.body).toBe('the shared one')
    expect(resolved.locale).toBe(SHARED_LOCALE)
  })

  it('prefers a language override over the shared text, for that language only', () => {
    createPromptVersion(db, {
      key: 'analysis.system',
      locale: SHARED_LOCALE,
      body: 'the shared one',
      activate: true,
    })
    createPromptVersion(db, {
      key: 'analysis.system',
      locale: 'nl',
      body: 'de Nederlandse versie',
      activate: true,
    })

    expect(resolvePrompt(db, 'analysis.system', 'nl').body).toBe('de Nederlandse versie')
    expect(resolvePrompt(db, 'analysis.system', 'en').body).toBe('the shared one')
  })

  it('does not let an override leak into the shared prompt', () => {
    // Asking for the shared text must never answer with one language's version,
    // or the editor's default view would show whichever language was edited last.
    createPromptVersion(db, {
      key: 'analysis.system',
      locale: 'nl',
      body: 'de Nederlandse versie',
      activate: true,
    })

    const resolved = resolvePrompt(db, 'analysis.system', SHARED_LOCALE)
    expect(resolved.body).toBe(DEFAULT_PROMPTS['analysis.system'])
    expect(resolved.id).toBeNull()
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
