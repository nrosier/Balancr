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
  SUPERSEDED_PROMPTS,
  supersededBuiltIn,
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

  it('tells the narrative pass what a note is for, and what it is not (#298)', () => {
    // The rule has to do two opposite things — license the note as an explanation and
    // refuse it as a source — so both halves are asserted. A rule that only said "you may
    // use the note" is how a narrative ends up quoting "about €400" as a figure.
    // Collapsed, because the rules are hard-wrapped in the source and a phrase that
    // straddles a line break is still the same instruction to the model.
    const body = DEFAULT_PROMPTS['narrative.system'].replace(/\s+/g, ' ')
    expect(body).toMatch(/no figure in the narrative may come from the note/i)
    expect(body).toMatch(/context and never data/i)
    // And it is genuinely new text rather than a rule the prompt always had: the oldest
    // body in the chain predates it. This anchored on `.at(-1)` until #278 appended a body
    // that has this rule too — that every install running *any* chain entry reaches the
    // current default is `seedPrompts`' own chain walk, not this test's job.
    const oldest = SUPERSEDED_PROMPTS['narrative.system'].at(0)?.replace(/\s+/g, ' ')
    expect(oldest).toBeDefined()
    expect(oldest).not.toMatch(/come from the note/i)
  })

  it('tells both passes what an excluded envelope is, and what not to say about it (#278)', () => {
    // The `excluded` block is meaningless on its own: a payload whose envelopes fall short
    // of the month's totals invites exactly the sentence the exclusion was asked to
    // prevent, and rule 1 — report only what you were given — is what makes reporting the
    // residue look correct. So both passes are told, and the narrative is told twice as
    // much, because it is the one that writes prose.
    expect(DEFAULT_PROMPTS['narrative.system'].replace(/\s+/g, ' ')).toMatch(
      /withheld from you on purpose/i,
    )
    expect(DEFAULT_PROMPTS['analysis.system']).toContain('"excluded"')
    const oldest = SUPERSEDED_PROMPTS['narrative.system'].at(0)?.replace(/\s+/g, ' ')
    expect(oldest).not.toMatch(/withheld from you on purpose/i)
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

  it('upgrades a database still running a built-in that has since been improved', () => {
    // The failure this exists for: `seedPrompts` used to skip any key that already had a
    // version, so an improved default reached new installs and nowhere else. Every
    // instance that had ever started up kept the first text forever, and nothing on any
    // screen said so — a rule added to the narrative prompt would have been dead code on
    // the only database that matters (#183).
    for (const key of PROMPT_KEYS) {
      const previous = SUPERSEDED_PROMPTS[key][0]
      if (previous === undefined) continue
      createPromptVersion(db, { key, locale: SHARED_LOCALE, body: previous, activate: true })
    }

    const written = seedPrompts(db)
    expect(written).toBeGreaterThan(0)

    for (const key of PROMPT_KEYS) {
      if (SUPERSEDED_PROMPTS[key].length === 0) continue
      expect(loadActivePrompt(db, key, SHARED_LOCALE)?.body).toBe(DEFAULT_PROMPTS[key])
    }
  })

  it('adds a version rather than rewriting one, so the old text stays readable', () => {
    const previous = SUPERSEDED_PROMPTS['narrative.system'][0]
    if (previous === undefined) throw new Error('no superseded narrative prompt to test with')
    createPromptVersion(db, {
      key: 'narrative.system',
      locale: SHARED_LOCALE,
      body: previous,
      activate: true,
    })

    seedPrompts(db)
    const versions = listPromptVersions(db, 'narrative.system', SHARED_LOCALE)
    expect(versions).toHaveLength(2)
    // Rollback is flipping `active`, and it can only reach a row that still exists. An
    // upgrade that rewrote version 1 in place would take the previous text with it and
    // leave a `prompt_version_id` on every past `ai_run` pointing at text nobody sent.
    expect(versions.map((row) => row.body)).toContain(previous)
    // And the note says what happened, because the version list is the audit trail: an
    // upgrade nobody asked for is exactly the row somebody will need explained.
    const added = versions.find((row) => row.body === DEFAULT_PROMPTS['narrative.system'])
    expect(added?.note).toContain('replacing the built-in')
  })

  it('upgrades once and then stops', () => {
    const previous = SUPERSEDED_PROMPTS['narrative.system'][0]
    if (previous === undefined) throw new Error('no superseded narrative prompt to test with')
    createPromptVersion(db, {
      key: 'narrative.system',
      locale: SHARED_LOCALE,
      body: previous,
      activate: true,
    })

    expect(seedPrompts(db)).toBeGreaterThan(0)
    // Every startup calls this. A second version of the same text on every boot would
    // turn the version list into a log.
    expect(seedPrompts(db)).toBe(0)
  })

  it('leaves an edit alone even when it is an edit of a superseded built-in', () => {
    // The one case the byte comparison exists for: somebody took the old default, changed
    // a line, and activated it. That is theirs, and an upgrade would silently discard it.
    const previous = SUPERSEDED_PROMPTS['narrative.system'][0]
    if (previous === undefined) throw new Error('no superseded narrative prompt to test with')
    const edited = `${previous}\n9. Mention the weather.`
    createPromptVersion(db, {
      key: 'narrative.system',
      locale: SHARED_LOCALE,
      body: edited,
      activate: true,
    })

    expect(seedPrompts(db)).toBe(1) // the analysis prompt only
    expect(loadActivePrompt(db, 'narrative.system', SHARED_LOCALE)?.body).toBe(edited)
  })

  it('upgrades an install running the pre-PII-fix narrative default (v0.9.0-v0.11.1)', () => {
    // The gap this closes: the drift rule (#183) added a second built-in body
    // (`NARRATIVE_SYSTEM_V2`) without ever adding it to `SUPERSEDED_PROMPTS`, so
    // every real installation that booted since then — not just a fresh or a
    // pre-#183 database — sat on text `seedPrompts` could never recognise as
    // superseded. `DEFAULT_PROMPTS` no longer names a specific household's own
    // circumstances; this is the upgrade path that actually reaches an install
    // running that text today, not just a database nobody has ever started.
    const previous = SUPERSEDED_PROMPTS['narrative.system'][1]
    if (previous === undefined) throw new Error('expected a second superseded narrative body')
    createPromptVersion(db, {
      key: 'narrative.system',
      locale: SHARED_LOCALE,
      body: previous,
      activate: true,
    })

    expect(seedPrompts(db)).toBeGreaterThan(0)
    expect(loadActivePrompt(db, 'narrative.system', SHARED_LOCALE)?.body).toBe(
      DEFAULT_PROMPTS['narrative.system'],
    )
  })

  it('upgrades from every superseded body in the chain, not just the two it names', () => {
    // The two tests above pin index 0 and index 1 by hand, which is how the chain came to
    // have an entry nobody upgraded from: #183 added a body and no test noticed. This walks
    // the whole chain instead, so a version added later is covered on the day it is added
    // rather than on the day somebody remembers to write the test (#298).
    for (const key of PROMPT_KEYS) {
      for (const [index, previous] of SUPERSEDED_PROMPTS[key].entries()) {
        const fresh = createTestDb()
        applyMigrations(fresh.db as never)
        createPromptVersion(fresh.db, { key, locale: SHARED_LOCALE, body: previous, activate: true })

        expect(seedPrompts(fresh.db), `${key}[${index}]`).toBeGreaterThan(0)
        expect(loadActivePrompt(fresh.db, key, SHARED_LOCALE)?.body, `${key}[${index}]`).toBe(
          DEFAULT_PROMPTS[key],
        )
      }
    }
  })

  it('holds each superseded body once, and never the current default', () => {
    // Two ways the chain goes wrong that no upgrade test would catch: a body appended
    // twice, and a body that is *also* the current default — which would make `seedPrompts`
    // treat an install already on the newest text as one needing an upgrade, writing a new
    // version on every startup forever.
    for (const key of PROMPT_KEYS) {
      const chain = SUPERSEDED_PROMPTS[key]
      expect(new Set(chain).size, key).toBe(chain.length)
      expect(chain, key).not.toContain(DEFAULT_PROMPTS[key])
    }
  })

  it('leaves an edit of the newest superseded narrative built-in alone', () => {
    // The same guarantee as the [0] case above, at the end of the chain: somebody who
    // added their own last rule keeps it, and does not silently get ours instead.
    const list = SUPERSEDED_PROMPTS['narrative.system']
    const newest = list[list.length - 1]
    if (newest === undefined) throw new Error('no superseded narrative body')
    const edited = `${newest}\n9. Always mention the weather.`
    createPromptVersion(db, {
      key: 'narrative.system',
      locale: SHARED_LOCALE,
      body: edited,
      activate: true,
    })

    expect(seedPrompts(db)).toBe(1) // the analysis prompt only
    expect(loadActivePrompt(db, 'narrative.system', SHARED_LOCALE)?.body).toBe(edited)
  })

  it('does not touch a language override when it upgrades the shared row', () => {
    const previous = SUPERSEDED_PROMPTS['narrative.system'][0]
    if (previous === undefined) throw new Error('no superseded narrative prompt to test with')
    createPromptVersion(db, {
      key: 'narrative.system',
      locale: SHARED_LOCALE,
      body: previous,
      activate: true,
    })
    createPromptVersion(db, {
      key: 'narrative.system',
      locale: 'nl',
      body: 'een eigen versie',
      activate: true,
    })

    seedPrompts(db)
    expect(resolvePrompt(db, 'narrative.system', 'nl').body).toBe('een eigen versie')
    expect(resolvePrompt(db, 'narrative.system', 'en').body).toBe(
      DEFAULT_PROMPTS['narrative.system'],
    )
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

describe('the superseded list', () => {
  it('never contains the text that is current, so the upgrade terminates', () => {
    // If a body were on both lists, `seedPrompts` would find the active version
    // superseded, write the identical text as a new version, and find it superseded again
    // on the next boot — a version per startup, forever, and `diffAgainstActive` showing
    // no difference between any two of them.
    for (const key of PROMPT_KEYS) {
      expect(supersededBuiltIn(key, DEFAULT_PROMPTS[key])).toBe(false)
    }
  })

  it('holds every built-in that has ever been active, so no instance is left behind', () => {
    // Two keys, one entry each today. The list is append-only by nature: an instance that
    // last started on any past default has to be recognisable, and the moment an entry is
    // dropped that instance stops receiving improvements with nothing reporting it.
    for (const key of PROMPT_KEYS) {
      expect(SUPERSEDED_PROMPTS[key].length).toBeGreaterThan(0)
    }
  })

  it('recognises every past built-in, not only the first', () => {
    // One entry per shipped default, and each one is an install somewhere. A chain that
    // recognises its oldest link and not its newest leaves behind exactly the instances
    // that are most current — which is the wrong half to lose.
    for (const key of PROMPT_KEYS) {
      for (const previous of SUPERSEDED_PROMPTS[key]) {
        expect(supersededBuiltIn(key, previous), key).toBe(true)
      }
    }
  })

  it('holds every entry exactly once, so an upgrade cannot loop between two of them', () => {
    // A duplicate would not be caught by the "never contains the current text" check
    // above and is the shape a copy-paste mistake takes: the chain is written by hand,
    // one constant per shipped release, and two identical links in it would make the
    // version list on somebody's install unreadable rather than wrong.
    for (const key of PROMPT_KEYS) {
      const bodies = SUPERSEDED_PROMPTS[key]
      expect(new Set(bodies).size, key).toBe(bodies.length)
    }
  })

  it('compares the whole body, not a prefix of it', () => {
    // A prefix or a "starts with" test would treat a prompt somebody extended as an
    // untouched built-in and overwrite the addition.
    const previous = SUPERSEDED_PROMPTS['narrative.system'][0]
    if (previous === undefined) throw new Error('no superseded narrative prompt to test with')
    expect(supersededBuiltIn('narrative.system', previous)).toBe(true)
    expect(supersededBuiltIn('narrative.system', `${previous} and one more thing`)).toBe(false)
    expect(supersededBuiltIn('narrative.system', previous.slice(0, -20))).toBe(false)
  })

  it('ignores surrounding whitespace, which no editor preserves reliably', () => {
    const previous = SUPERSEDED_PROMPTS['analysis.system'][0]
    if (previous === undefined) throw new Error('no superseded analysis prompt to test with')
    expect(supersededBuiltIn('analysis.system', `\n  ${previous}\n\n`)).toBe(true)
  })

  it('does not match the built-in of one key against another key', () => {
    const narrative = SUPERSEDED_PROMPTS['narrative.system'][0]
    if (narrative === undefined) throw new Error('no superseded narrative prompt to test with')
    expect(supersededBuiltIn('analysis.system', narrative)).toBe(false)
  })

  it('no longer names a specific household in the narrative default', () => {
    // Regression guard for the PII fix: the opening sentence used to describe
    // this app's one real deployment by its actual family circumstances rather
    // than a household in general, the way every other prompt in this file does.
    expect(DEFAULT_PROMPTS['narrative.system']).not.toContain('single parent')
    expect(DEFAULT_PROMPTS['narrative.system']).not.toContain('custody')
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
