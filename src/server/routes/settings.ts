/**
 * The settings screen: the one page in Balancr that writes.
 *
 * Everything reachable from here changes *judgement* rather than data — a
 * threshold, a prompt version, which of two accounts holding the same money is the
 * one that counts, what language the UI speaks. None of it can be recomputed from
 * Actual or Ghostfolio, which is why every write is audit-logged and why they are
 * all owner-only. A second person reading the dashboard should not be able to
 * change the numbers the first one sees.
 *
 * It sits outside `routes/api/` deliberately. That directory holds one rule — a
 * request never calls an upstream, every route is a GET — and a mutation in it
 * would be the first exception, after which the rule is a comment rather than a
 * property. The URLs are still `/api/settings/*`: the client sees one API, and the
 * split is about what the server guarantees per directory.
 *
 * The AI dry run is not here either, for a stricter reason: it can spend money. It
 * lives in `routes/ai.ts` behind its own rate limit.
 *
 * **Every write answers with the whole settings payload.** It costs one extra
 * SQLite read — none of this touches a network — and it removes the entire class of
 * bug where a screen patches its local copy of one field and drifts from the
 * server on the others. Activating a prompt changes which version is active *and*
 * what the editor should show; grouping two accounts changes both rows and the
 * dedupe warning. One shape back, replace the state, no reconciliation.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import {
  BAND_CLASSES,
  bandsOf,
  isPreset,
  loadProfile,
  PROFILE_IDS,
  PROFILE_KEY,
  PROFILE_PRESETS,
  saveProfile,
} from '../../domain/advice/profile.ts'
import {
  decidedFields,
  dedupeCandidates,
  dismissMirror,
  groupAccounts,
  loadAccountMap,
  setSourceOfTruth,
  ungroupAccount,
  updateAccountMap,
  type AccountMapRow,
} from '../../domain/aggregate/accounts.ts'
import { earliestStoredMonth, latestStoredMonth } from '../../domain/aggregate/month-store.ts'
import { loadLatestAccountBalances } from '../../domain/aggregate/networth-store.ts'
import {
  DEFAULT_PARAMS,
  loadParams,
  PARAMS_KEY,
  saveParams,
  unknownParamFields,
} from '../../domain/aggregate/params.ts'
import {
  HOUSEHOLD_KEY,
  loadHousehold,
  saveHousehold,
} from '../../domain/benchmark/household.ts'
import {
  loadUpcomingNote,
  saveUpcomingNote,
  UPCOMING_NOTE_KEY,
} from '../../domain/ai/upcoming-note.ts'
import { loadProperties, PROPERTY_KEY, saveProperties } from '../../domain/property/properties.ts'
import {
  COICOP_CHOICES,
  loadMapping,
  MappingError,
  saveCoicop,
  saveCustodyShared,
} from '../../domain/benchmark/mapping.ts'
import { benchmarkOrNull, transcribedBlocks } from '../../domain/benchmark/model.ts'
import { aiAvailability } from '../../domain/ai/availability.ts'
import { budgetState, loadSpendHistory } from '../../domain/ai/budget.ts'
import { SHARED_LOCALE } from '../../domain/ai/prompt-locale.ts'
import {
  activatePrompt,
  createPromptVersion,
  deactivateOverride,
  diffAgainstActive,
  listPromptVersions,
  loadActivePrompt,
  PROMPT_KEYS,
  loadPrompt,
  resolvePrompt,
  type PromptKey,
} from '../../domain/ai/prompts.ts'
import { recordAudit } from '../../domain/audit.ts'
import { MAX_LINES } from '../../util/diff.ts'
import { requireOwner, requireUser } from '../auth/guard.ts'
import { setUserLocale } from '../auth/users.ts'
import { badRequest, conflict, invalidBody, notFound } from '../errors.ts'
import { rememberLocale } from '../locale.ts'
import { fieldIssues, parseBody } from '../validate.ts'
import { APP_REVISION, APP_VERSION } from '../version.ts'
import {
  accountSettingSchema,
  promptBodySchema,
  promptDiffSchema,
  promptSchema,
  settingsSchema,
  type AccountSetting,
  type PromptBody,
  type PromptDiff,
  type PromptSetting,
  type Settings,
} from './api/schemas.ts'

// ---------------------------------------------------------------------------
//  What the requests may say
//
//  These schemas are here rather than in `api/schemas.ts`, which is the *response*
//  contract the browser bundle imports its types from. A request body is the
//  server's own gate and nothing outside this file should be built against it.
// ---------------------------------------------------------------------------

/**
 * A locale the deployment actually supports.
 *
 * Not merely a non-empty string: storing `fr` because someone sent it would leave a
 * user whose language resolves to nothing and a prompt version nothing will ever
 * read.
 */
const localeRequest = z.string().refine((value) => config.SUPPORTED_LOCALES.includes(value), {
  message: 'unsupported locale',
})

/**
 * The same, plus the sentinel that means "every language".
 *
 * Separate from `localeRequest` because a *user* can never have `*` as their
 * language, and one schema admitting both would make that storable.
 */
const promptLocaleRequest = z
  .string()
  .refine((value) => value === SHARED_LOCALE || config.SUPPORTED_LOCALES.includes(value), {
    message: 'unsupported locale',
  })

/**
 * One group of aggregation parameters, as numbers and nothing else.
 *
 * Every field in every group is a number, so this is the honest shape — and the
 * field *names* are checked against the schema's own defaults by
 * `unknownParamFields` rather than repeated here. Repeating them would mean the
 * ranges lived in two places, and the copy that fell behind would be the one
 * rejecting a valid request.
 */
const paramGroupPatch = z.record(z.string(), z.number())

const paramsPatchRequest = z.strictObject({
  baseline: paramGroupPatch.optional(),
  overspend: paramGroupPatch.optional(),
  burnRate: paramGroupPatch.optional(),
  hygiene: paramGroupPatch.optional(),
  household: paramGroupPatch.optional(),
})

/**
 * A risk-profile patch, checked for shape and nothing more.
 *
 * The bounds and the cross-field rules — targets adding up to exactly 100%, minimum ≤
 * target ≤ maximum, a custom profile stating its own bands — live in `riskProfileSchema`
 * and are enforced by `saveProfile`, which is the only thing that sees the merged result.
 * Same division as `paramsPatchRequest`: a second copy of every bound here would mean the
 * copy that fell behind is the one refusing a request that was fine.
 *
 * `bands` is exhaustive by construction — `z.record` over the class enum requires all
 * four — because bands are replaced wholesale. A patch carrying one band would leave
 * three from the previous profile, which is precisely how four targets come to add up to
 * something other than 100%.
 */
const advicePatchRequest = z.strictObject({
  profile: z.enum(PROFILE_IDS).optional(),
  bands: z
    .record(
      z.enum(BAND_CLASSES),
      z.strictObject({
        minBp: z.number().int(),
        targetBp: z.number().int(),
        maxBp: z.number().int(),
      }),
    )
    .optional(),
  toleranceBp: z.number().int().optional(),
  minTradeCents: z.number().int().optional(),
})

/**
 * The profile fields a user may change about themselves: the language, and nothing
 * else. `role` is absent on purpose — promoting a viewer to owner from a page any
 * viewer can open would make the distinction decorative.
 */
const profilePatchRequest = z.strictObject({ locale: localeRequest })

/**
 * The household the benchmark is scaled to.
 *
 * The whole roster, always: `members` is a list, and the two gestures a form makes on a
 * list are "here is the new one" and "drop a row". A merge cannot express the second. The
 * bounds — the member cap, the custody range, the year range — live in `householdSchema`
 * and are enforced by `saveHousehold`, the same division `advicePatchRequest` explains.
 *
 * You are not a member and cannot be: there is exactly one first person on the scale, and
 * an editable self would allow a household of nobody.
 */
const householdPatchRequest = z.strictObject({
  members: z.array(
    z.strictObject({
      birthYear: z.number().int(),
      custodyBp: z.number().int().optional(),
      label: z.string().optional(),
    }),
  ),
  /**
   * A name for the first person on the scale (#215). Optional, and — like `sharedCostBp`
   * below — omitting it clears it: the household is one row written wholesale, so there is
   * no partial-preserve gesture for any field in it, this one included.
   */
  selfLabel: z.string().optional(),
  /**
   * The share of a shared cost that is yours, or null to derive it from the roster (#44).
   *
   * Nullable because going back to a derived share is a correction somebody has to be able
   * to make, and a field that only accepts numbers makes "stop guessing for me" the one
   * gesture the form cannot express.
   *
   * Optional so a form that predates the field is not rejected — and, like `members`,
   * omitting it *replaces* rather than preserves: the household is one row written
   * wholesale, so a patch without this field leaves a derived share behind. That is the
   * safe direction of the two, because a stated share silently surviving a roster edit is
   * how somebody ends up reading a split they thought they had removed.
   */
  sharedCostBp: z.number().int().nullable().optional(),
})

/**
 * The running "what's coming up" note (#217).
 *
 * The whole text, always: like the household roster, there is no partial-preserve
 * gesture on a single free-text field. The length bound lives in `upcomingNoteSchema`
 * and is enforced by `saveUpcomingNote`, the same division `householdPatchRequest`
 * explains.
 */
const upcomingNotePatchRequest = z.strictObject({
  text: z.string(),
})

/**
 * The owned properties and their mortgages, if any (#227).
 *
 * The whole list, always — same reason as the household roster: a list's only two
 * gestures are "here is a new one" and "drop a row", and a merge can't express the
 * second. The bounds (rate, term, non-negative cents, the twenty-property cap) live in
 * `propertiesSchema` and are enforced by `saveProperties`, the same division every other
 * patch on this page explains. There is no rate-history endpoint: a rate change on one
 * property is a fresh PATCH of the whole list with today's actual balance as its new
 * anchor.
 */
const propertyPatchRequest = z.strictObject({
  properties: z.array(
    z.strictObject({
      id: z.string(),
      kind: z.enum(['primary', 'rental']).optional(),
      label: z.string().optional(),
      propertyValueCents: z.number().int().nullable().optional(),
      rentCents: z.number().int().nullable().optional(),
      mortgage: z
        .strictObject({
          principalCents: z.number().int(),
          anchorDate: z.string(),
          rateBp: z.number().int(),
          monthlyPaymentCents: z.number().int(),
          remainingTermMonths: z.number().int(),
        })
        .nullable()
        .optional(),
    }),
  ),
})

/**
 * One category's COICOP division, or `null` to unmap it.
 *
 * Nullable rather than optional, which is the difference between this and every other
 * patch on this page: absent would mean "leave it alone", and taking a wrong mapping back
 * is the correction people most need to make. A division and not a full code — see
 * `mapping.ts` for why the picker stops at two digits.
 */
const coicopPatchRequest = z.strictObject({ coicop: z.enum(COICOP_CHOICES).nullable() })

/**
 * Whether one category's cost is split with a co-parent (#44).
 *
 * A required boolean, not an optional one: a checkbox always knows which way it was just
 * moved, and an absent field would make "no longer shared" impossible to send — the same
 * argument the nullable division above makes, arriving at a plainer type because there
 * are only two states to express.
 */
const custodySharedPatchRequest = z.strictObject({ custodyShared: z.boolean() })

const accountPatchRequest = z.strictObject({
  kind: z.enum(['checking', 'savings', 'credit', 'investment', 'cash', 'other']).optional(),
  includeInNetWorth: z.boolean().optional(),
})

const accountGroupRequest = z
  .strictObject({
    /** Two or more: a group of one is what `ungroup` is for. */
    accountMapIds: z.array(z.string().min(1)).min(2),
    sourceOfTruthId: z.string().min(1),
  })
  .refine((body) => body.accountMapIds.includes(body.sourceOfTruthId), {
    message: 'sourceOfTruthId must be one of accountMapIds',
    path: ['sourceOfTruthId'],
  })

/**
 * A prompt body: not empty once trimmed, and not so long the diff refuses it.
 *
 * Both limits exist because the alternative is a 500. `createPromptVersion` throws
 * on an empty body and `diffLines` throws above `MAX_LINES`, and a form that
 * pasted the wrong thing deserves to be told which.
 */
const promptBodyRequest = z
  .string()
  .refine((body) => body.trim().length > 0, { message: 'the prompt cannot be empty' })
  .refine((body) => body.split('\n').length <= MAX_LINES, {
    message: `a prompt of more than ${String(MAX_LINES)} lines cannot be diffed`,
  })

const promptCreateRequest = z.strictObject({
  key: z.enum(PROMPT_KEYS),
  locale: promptLocaleRequest,
  body: promptBodyRequest,
  /** Why this version exists, for the list. Not the text — that is the row. */
  note: z.string().max(500).optional(),
  activate: z.boolean().optional(),
})

const promptDiffRequest = z.strictObject({
  key: z.enum(PROMPT_KEYS),
  locale: promptLocaleRequest,
  body: promptBodyRequest,
})

// ---------------------------------------------------------------------------
//  Reading
// ---------------------------------------------------------------------------

const toAccountSetting = (row: AccountMapRow): AccountSetting =>
  accountSettingSchema.parse({
    id: row.id,
    source: row.source,
    name: row.name,
    kind: row.kind,
    includeInNetWorth: row.includeInNetWorth,
    dedupeGroup: row.dedupeGroup,
    isSourceOfTruth: row.isSourceOfTruth,
    decidedFields: [...decidedFields(row)].sort(),
  })

/**
 * One prompt's active text and its history.
 *
 * `active` comes from `resolvePrompt` rather than from the active row, because the
 * two are not the same thing: with no Dutch version stored, the Dutch prompt in use
 * is the English one, and with no rows at all it is the built-in constant. An editor
 * that showed an empty box in either case is how someone saves a prompt over
 * nothing and wonders why the output changed.
 */
function promptSetting(db: Db, key: PromptKey, locale: string): PromptSetting {
  const active = resolvePrompt(db, key, locale)
  return promptSchema.parse({
    key,
    locale,
    active: { id: active.id, version: active.version, locale: active.locale, body: active.body },
    versions: listPromptVersions(db, key, locale).map((row) => ({
      id: row.id,
      version: row.version,
      active: row.active,
      note: row.note,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      chars: row.body.length,
    })),
  })
}

/**
 * The risk profile, with the presets' numbers alongside it.
 *
 * `bandsOf` rather than the stored `bands` field, which is absent for a named preset: the
 * screen draws band editors and there is always a set of bands in force, so sending null
 * would make every consumer repeat the preset lookup — and the browser cannot do that
 * lookup, because `PROFILE_PRESETS` lives on this side.
 */
function riskProfileSetting(db: Db): Settings['advice'] {
  const profile = loadProfile(db)
  return {
    profile: profile.profile,
    isPreset: isPreset(profile),
    bands: bandsOf(profile),
    toleranceBp: profile.toleranceBp,
    minTradeCents: profile.minTradeCents,
    presets: PROFILE_PRESETS,
  }
}

/**
 * The benchmark file, the household, and the mapping between them.
 *
 * The file is read per request rather than cached: it is a small YAML on local disk, this
 * page is opened by one person, and a cached copy would keep the panel showing a
 * transcription warning somebody had already answered by editing the file.
 */
function benchmarkSetting(db: Db): Settings['benchmark'] {
  const benchmark = benchmarkOrNull()
  const household = loadHousehold(db)

  return {
    file:
      benchmark === null
        ? null
        : {
            source: {
              survey: benchmark.source.survey,
              year: benchmark.source.year,
              citation: benchmark.source.citation,
              sourceUrl: benchmark.source.source_url ?? null,
              lastVerified: benchmark.source.last_verified,
              status: benchmark.source.status,
            },
            equivalence: {
              scale: benchmark.equivalence.scale,
              firstPersonBp: benchmark.equivalence.first_person_bp,
              additionalPersonBp: benchmark.equivalence.additional_person_bp,
              childBp: benchmark.equivalence.child_bp,
              childAgeBelow: benchmark.equivalence.child_age_below,
              citation: benchmark.equivalence.citation,
              sourceUrl: benchmark.equivalence.source_url ?? null,
              lastVerified: benchmark.equivalence.last_verified,
              status: benchmark.equivalence.status,
            },
            groups: benchmark.groups.map((group) => ({
              id: group.id,
              shareBp: group.share_bp,
              coicop: group.coicop,
            })),
            hasReferenceHousehold: benchmark.referenceHousehold !== null,
            transcribed: [...transcribedBlocks(benchmark)],
          },
    household: {
      members: household.members.map((member) => ({
        birthYear: member.birthYear,
        custodyBp: member.custodyBp,
        ...(member.label === undefined ? {} : { label: member.label }),
      })),
      ...(household.selfLabel === undefined ? {} : { selfLabel: household.selfLabel }),
      sharedCostBp: household.sharedCostBp,
    },
    outsideCode: '00',
    categories: loadMapping(db, latestStoredMonth(db)),
  }
}

/** Everything the settings screen shows. See `settingsSchema` for the shape. */
export function buildSettings(db: Db, request: FastifyRequest): Settings {
  const user = requireUser(request)
  const accounts = loadAccountMap(db)
  const budget = budgetState(db)

  return settingsSchema.parse({
    build: { version: APP_VERSION, revision: APP_REVISION },
    history: {
      months: config.JOBS_HISTORY_MONTHS,
      earliest: earliestStoredMonth(db),
      latest: latestStoredMonth(db),
    },
    profile: {
      email: user.email,
      displayName: user.displayName,
      locale: user.locale,
      role: user.role,
    },
    locales: { supported: config.SUPPORTED_LOCALES, default: config.DEFAULT_LOCALE },
    params: loadParams(db),
    paramDefaults: DEFAULT_PARAMS,
    advice: riskProfileSetting(db),
    benchmark: benchmarkSetting(db),
    property: loadProperties(db),
    // The shared text first, then only those languages someone has actually written
    // an override for. Listing every supported locale unconditionally is what made
    // the divergence look mandatory: four entries carrying two texts, and no way to
    // tell an override from a copy of the seed.
    //
    // A switched-off override keeps its entry, because its versions still exist and
    // reactivating one is the rollback gesture. `active.locale` is what distinguishes
    // the two states, and it is already on the wire.
    prompts: PROMPT_KEYS.flatMap((key) => [
      promptSetting(db, key, SHARED_LOCALE),
      ...config.SUPPORTED_LOCALES.map((locale) => promptSetting(db, key, locale)).filter(
        (entry) => entry.versions.length > 0,
      ),
    ]),
    accounts: accounts.map(toAccountSetting),
    dedupe: dedupeCandidates(accounts, loadLatestAccountBalances(db)).map((candidate) => ({
      ghostfolioId: candidate.ghostfolio.id,
      actualId: candidate.actual.id,
      signals: candidate.signals,
    })),
    ai: {
      availability: aiAvailability(),
      models: { fast: config.GEMINI_MODEL_FAST, deep: config.GEMINI_MODEL_DEEP },
      month: budget.month,
      spentMicroEur: budget.spentMicroEur,
      budgetMicroEur: budget.budgetMicroEur,
      remainingMicroEur: budget.remainingMicroEur,
      usedBp: budget.usedBp,
      exceeded: budget.exceeded,
      history: loadSpendHistory(db),
      upcomingNote: loadUpcomingNote(db).text,
    },
  })
}

// ---------------------------------------------------------------------------
//  Writing
// ---------------------------------------------------------------------------

/**
 * Just the groups a patch mentioned, for the audit entry.
 *
 * The whole parameter set in `before` and `after` would make every entry look like
 * a rewrite of all twenty fields, and the question an audit trail is opened to
 * answer is "what changed, and was it always 3 000?".
 */
function touchedGroups(params: unknown, patch: object): Record<string, unknown> {
  const all = params as Record<string, unknown>
  return Object.fromEntries(Object.keys(patch).map((group) => [group, all[group]]))
}

/**
 * A stored prompt key, narrowed to the closed set.
 *
 * `prompts.key` is text in the schema, so a row cannot prove it holds one of the two
 * keys — and a row that somehow holds something else must not be silently treated as
 * an analysis prompt.
 */
function promptKeyOf(key: string): PromptKey {
  const found = PROMPT_KEYS.find((candidate) => candidate === key)
  if (found === undefined) throw badRequest(`Unknown prompt key: ${key}`)
  return found
}

/** The two editable fields of an account row, for the audit entry. */
const accountJudgement = (row: AccountMapRow): Record<string, unknown> => ({
  kind: row.kind,
  includeInNetWorth: row.includeInNetWorth,
  dedupeGroup: row.dedupeGroup,
  isSourceOfTruth: row.isSourceOfTruth,
  // Provenance belongs in the entry because it is sometimes the only thing that moved.
  // Dismissing a duplicate suggestion changes no value at all — the group stays null
  // and the account keeps counting — it only records that the null is now an answer.
  // Without this field that audit entry would read as before === after, which is to
  // say it would record a decision as a no-op.
  decidedFields: [...decidedFields(row)].sort(),
})

export function registerSettingsRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/settings', (request: FastifyRequest) => buildSettings(db, request))

  /**
   * The aggregation thresholds.
   *
   * Saving them changes nothing on screen until the next aggregation pass — the
   * facts they produce are stored, not computed per request. That is the honest
   * behaviour and the screen says so; recomputing twelve months of baselines
   * because someone dragged a slider would turn a settings form into a job queue.
   */
  app.patch('/api/settings/params', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const patch = parseBody(paramsPatchRequest, request.body)

    const unknown = unknownParamFields(patch)
    if (unknown.length > 0) {
      throw invalidBody(
        'The request body was not valid.',
        unknown.map((path) => ({ path, message: 'Unknown field.' })),
      )
    }

    const before = loadParams(db)
    let after
    try {
      after = saveParams(db, patch)
    } catch (error) {
      // The cross-field rules — `winsorLowerPct < winsorUpperPct`,
      // `baselineWarnBp <= baselineAlertBp` — can only be checked against the
      // merged result, so they fail here rather than in `parseBody`. A 500 for a
      // form that submitted two numbers in the wrong order would be a lie about
      // whose mistake it was.
      if (error instanceof z.ZodError) {
        throw invalidBody('The request body was not valid.', fieldIssues(error))
      }
      throw error
    }

    recordAudit(db, {
      action: 'settings.params',
      entity: 'settings',
      entityRef: PARAMS_KEY,
      actorId: user.id,
      before: touchedGroups(before, patch),
      after: touchedGroups(after, patch),
    })

    return buildSettings(db, request)
  })

  /**
   * The risk profile every drift figure and every suggestion is measured against (#41).
   *
   * Unlike the aggregation parameters, this takes effect immediately: drift is computed
   * per request from the stored allocation, so the portfolio page shows the new bands on
   * its next load. That is the whole reason it is a setting rather than a job input — the
   * gesture is "widen the equity band and see what that does to the advice".
   *
   * A contradictory set of bands fails here rather than in `parseBody`, for the same
   * reason the parameters do: only the merged result can be checked, and a 500 for a form
   * that submitted twelve numbers adding up to 97% would be a lie about whose mistake it
   * was.
   */
  app.patch('/api/settings/advice', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const patch = parseBody(advicePatchRequest, request.body)

    const before = loadProfile(db)
    let after
    try {
      after = saveProfile(db, patch)
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw invalidBody('The request body was not valid.', fieldIssues(error))
      }
      throw error
    }

    recordAudit(db, {
      action: 'settings.advice',
      entity: 'settings',
      entityRef: PROFILE_KEY,
      actorId: user.id,
      // The whole profile, not the touched fields: it is fifteen numbers, and the
      // question an audit entry answers here is "what were the bands when that advice
      // was given", which needs all of them.
      before,
      after,
    })

    return buildSettings(db, request)
  })

  /**
   * Who lives here, which is what makes a national average comparable at all (#43).
   *
   * Takes effect immediately, like the risk profile and unlike the aggregation
   * parameters: the comparison is computed per request, so the budget page shows the new
   * scale on its next load. The findings it produced are not rewritten — a signal is a
   * judgement made at a time — and the next nightly pass restates them.
   */
  app.patch('/api/settings/household', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const patch = parseBody(householdPatchRequest, request.body)

    const before = loadHousehold(db)
    let after
    try {
      after = saveHousehold(db, patch)
    } catch (error) {
      // The member cap and the custody range can only be checked against the parsed
      // roster, so they fail here rather than in `parseBody` — same division as the
      // parameters and the bands.
      if (error instanceof z.ZodError) {
        throw invalidBody('The request body was not valid.', fieldIssues(error))
      }
      throw error
    }

    recordAudit(db, {
      action: 'settings.household',
      entity: 'settings',
      entityRef: HOUSEHOLD_KEY,
      actorId: user.id,
      // The whole roster both ways. It is a handful of small rows, and the question the
      // trail answers is "who was the household when that comparison was drawn".
      before,
      after,
    })

    return buildSettings(db, request)
  })

  /**
   * The running "what's coming up" note the budget-amount proposal can read (#217).
   *
   * Takes effect immediately, for the next AI nudge run — it changes nothing about
   * `suggestBudgetAmounts` itself, which never reads this row.
   */
  app.patch('/api/settings/upcoming-note', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const patch = parseBody(upcomingNotePatchRequest, request.body)

    const before = loadUpcomingNote(db)
    let after
    try {
      after = saveUpcomingNote(db, patch)
    } catch (error) {
      // The length bound can only be checked once trimmed, so it fails here rather than
      // in `parseBody` — same division as the household roster.
      if (error instanceof z.ZodError) {
        throw invalidBody('The request body was not valid.', fieldIssues(error))
      }
      throw error
    }

    recordAudit(db, {
      action: 'settings.upcomingNote',
      entity: 'settings',
      entityRef: UPCOMING_NOTE_KEY,
      actorId: user.id,
      before,
      after,
    })

    return buildSettings(db, request)
  })

  /**
   * The owned properties and their mortgages, if any (#227).
   *
   * Takes effect immediately: `outstandingBalanceCents` is computed from this row on
   * every read, so a rate or balance correction is reflected the next time the
   * overview or portfolio page loads, with no separate recompute step.
   */
  app.patch('/api/settings/property', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const patch = parseBody(propertyPatchRequest, request.body)

    const before = loadProperties(db)
    let after
    try {
      after = saveProperties(db, patch)
    } catch (error) {
      // The rate/term bounds can only be checked once parsed, so they fail here rather
      // than in `parseBody` — same division as the household roster.
      if (error instanceof z.ZodError) {
        throw invalidBody('The request body was not valid.', fieldIssues(error))
      }
      throw error
    }

    recordAudit(db, {
      action: 'settings.property',
      entity: 'settings',
      entityRef: PROPERTY_KEY,
      actorId: user.id,
      before,
      after,
    })

    return buildSettings(db, request)
  })

  /**
   * Which reference line a category feeds (#43).
   *
   * The second writer of `category_meta.coicop_code`, and the only one a person can reach
   * without a Gemini key — the first is an approved `category_meta.set` proposal. It is
   * also the only path that may write `null`: a proposal exists to add knowledge, and
   * taking a wrong mapping back is a correction rather than a proposal.
   *
   * Audited against `category_meta` rather than `settings`, because that is the table the
   * row lands in and the AI path already writes its own entries there — one entity, so a
   * category's history reads as one list whoever made the change.
   */
  app.patch('/api/settings/categories/:id/coicop', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const categoryId = (request.params as { id: string }).id
    const { coicop } = parseBody(coicopPatchRequest, request.body)

    const before = loadMapping(db, null).find((row) => row.categoryId === categoryId)
    if (before === undefined) throw notFound('No such category.')

    try {
      saveCoicop(db, categoryId, coicop)
    } catch (error) {
      // Only reachable if the row disappeared between the two statements, which means a
      // sync dropped the category — a 404 rather than a 500, because nothing is broken.
      if (error instanceof MappingError) throw notFound('No such category.')
      throw error
    }

    recordAudit(db, {
      action: 'settings.coicop',
      entity: 'category_meta',
      entityRef: categoryId,
      actorId: user.id,
      before: { coicopCode: before.coicop },
      after: { coicopCode: coicop },
    })

    return buildSettings(db, request)
  })

  /**
   * Whether a category's cost is shared with a co-parent (#44).
   *
   * The third writer of `category_meta` a person can reach without a Gemini key, and the
   * only one for this column: before it, `custody_shared` could be set by approving a
   * `category_meta.set` proposal or answering a `custody_shared_unknown` clarification,
   * and nothing else — which made the shared-cost split the one feature on the budget page
   * that an installation with no AI configured could never switch on. "Make AI optional"
   * is a requirement, so a flag only the model can set is a bug in the requirement's terms.
   *
   * Deliberately not refused for an income or hidden category, though the split ignores
   * both: a category can be hidden after it was flagged, and a route that rejected the
   * flag would then also refuse to let it be *removed*. The form disables the box instead,
   * which says the same thing where somebody can read it.
   */
  app.patch('/api/settings/categories/:id/custody-shared', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const categoryId = (request.params as { id: string }).id
    const { custodyShared } = parseBody(custodySharedPatchRequest, request.body)

    const before = loadMapping(db, null).find((row) => row.categoryId === categoryId)
    if (before === undefined) throw notFound('No such category.')

    try {
      saveCustodyShared(db, categoryId, custodyShared)
    } catch (error) {
      // As above: only reachable if a sync dropped the category between the two
      // statements, which is a 404 rather than a 500 because nothing is broken.
      if (error instanceof MappingError) throw notFound('No such category.')
      throw error
    }

    recordAudit(db, {
      action: 'settings.custodyShared',
      entity: 'category_meta',
      entityRef: categoryId,
      actorId: user.id,
      before: { custodyShared: before.custodyShared },
      after: { custodyShared },
    })

    return buildSettings(db, request)
  })

  /**
   * The signed-in user's own language.
   *
   * The one write a viewer may make, because it changes what *they* see and nothing
   * anyone else does — so `requireUser`, not `requireOwner`. `request.user` is
   * replaced before the response is built: it was loaded before the change, and a
   * payload still quoting the old locale would leave the page showing the language
   * it just left. The locale cookie moves with it for the same reason, one load later.
   */
  app.patch('/api/settings/profile', (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request)
    const { locale } = parseBody(profilePatchRequest, request.body)

    const updated = setUserLocale(db, user.id, locale)
    request.user = updated
    // The cookie is what the shell reads on the next full load, so it moves with the
    // column. Without this the `<html lang>` after a reload would still be the old
    // language while every string on the page was already the new one.
    rememberLocale(reply, updated.locale)

    recordAudit(db, {
      action: 'settings.locale',
      entity: 'users',
      entityRef: user.id,
      actorId: user.id,
      before: { locale: user.locale },
      after: { locale: updated.locale },
    })

    return buildSettings(db, request)
  })

  /** What an account contributes: its kind, and whether it is part of net worth. */
  app.patch('/api/settings/accounts/:id', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const id = (request.params as { id: string }).id
    const patch = parseBody(accountPatchRequest, request.body)

    const before = loadAccountMap(db).find((row) => row.id === id)
    if (before === undefined) throw notFound('No such account.')

    // Spread rather than passed through: with `exactOptionalPropertyTypes`, a
    // parsed body's absent field is `undefined` and the domain patch's is absent.
    const after = updateAccountMap(db, id, {
      ...(patch.kind === undefined ? {} : { kind: patch.kind }),
      ...(patch.includeInNetWorth === undefined
        ? {}
        : { includeInNetWorth: patch.includeInNetWorth }),
    })
    if (after === null) throw notFound('No such account.')

    recordAudit(db, {
      action: 'account.map',
      entity: 'account_map',
      entityRef: id,
      actorId: user.id,
      before: accountJudgement(before),
      after: accountJudgement(after),
    })

    return buildSettings(db, request)
  })

  /**
   * Which account in a group is the one that counts.
   *
   * A POST rather than a PATCH on the row, because it changes other rows too: the
   * flag is exclusive within the group, and two accounts marked as the truth for one
   * pot of money would double count it — in the flattering direction, with nothing
   * on screen to say so.
   */
  app.post('/api/settings/accounts/:id/source-of-truth', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const id = (request.params as { id: string }).id

    const before = loadAccountMap(db).find((row) => row.id === id)
    if (before === undefined) throw notFound('No such account.')

    const after = setSourceOfTruth(db, id)
    if (after === null) throw notFound('No such account.')

    recordAudit(db, {
      action: 'account.map',
      entity: 'account_map',
      entityRef: id,
      actorId: user.id,
      before: accountJudgement(before),
      after: accountJudgement(after),
    })

    return buildSettings(db, request)
  })

  /** Marks two or more accounts as the same money, with one of them the truth. */
  app.post('/api/settings/accounts/group', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const { accountMapIds, sourceOfTruthId } = parseBody(accountGroupRequest, request.body)

    const rows = loadAccountMap(db)
    const known = new Set(rows.map((row) => row.id))
    const missing = accountMapIds.filter((id) => !known.has(id))
    if (missing.length > 0) throw notFound('No such account.')

    const group = groupAccounts(db, accountMapIds, sourceOfTruthId)

    for (const id of accountMapIds) {
      const before = rows.find((row) => row.id === id)
      recordAudit(db, {
        action: 'account.map',
        entity: 'account_map',
        entityRef: id,
        actorId: user.id,
        before: before === undefined ? null : accountJudgement(before),
        after: { dedupeGroup: group, isSourceOfTruth: id === sourceOfTruthId },
      })
    }

    return buildSettings(db, request)
  })

  /**
   * Takes an account back out of its group, and back to counting for itself.
   *
   * Not the reverse of grouping: the other members keep the group. An account that
   * belonged to no group and counted for nothing would be invisible money.
   */
  app.post('/api/settings/accounts/:id/ungroup', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const id = (request.params as { id: string }).id

    const before = loadAccountMap(db).find((row) => row.id === id)
    if (before === undefined) throw notFound('No such account.')

    const after = ungroupAccount(db, id)
    if (after === null) throw notFound('No such account.')

    recordAudit(db, {
      action: 'account.map',
      entity: 'account_map',
      entityRef: id,
      actorId: user.id,
      before: accountJudgement(before),
      after: accountJudgement(after),
    })

    return buildSettings(db, request)
  })

  /**
   * Records that a Ghostfolio account is not a copy of anything, so the suggestion goes.
   *
   * The missing half of the old panel: it offered two buttons and both created a
   * group, so an incorrect suggestion could only be silenced by grouping two
   * unrelated accounts — which drops one of them out of net worth entirely. That is
   * an understatement with no symptom, and the panel exists to prevent exactly that
   * class of error. "Not the same money" has to be as storable as its opposite.
   *
   * Refused on an account that *is* grouped: there the operation wanted is `ungroup`,
   * which both breaks the group and records the same decision. Answering 404 for that
   * would be a lie about which account exists.
   */
  app.post('/api/settings/accounts/:id/not-mirrored', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const id = (request.params as { id: string }).id

    const before = loadAccountMap(db).find((row) => row.id === id)
    if (before === undefined) throw notFound('No such account.')
    if (before.dedupeGroup !== null) {
      throw conflict('That account is in a group. Ungroup it instead.')
    }

    const after = dismissMirror(db, id)
    if (after === null) throw notFound('No such account.')

    recordAudit(db, {
      action: 'account.map',
      entity: 'account_map',
      entityRef: id,
      actorId: user.id,
      before: accountJudgement(before),
      after: accountJudgement(after),
    })

    return buildSettings(db, request)
  })

  /** One stored version, text included. The list in `/api/settings` omits it. */
  app.get('/api/settings/prompts/:id', (request: FastifyRequest): PromptBody => {
    requireUser(request)
    const row = loadPrompt(db, (request.params as { id: string }).id)
    if (row === null) throw notFound('No such prompt version.')

    return promptBodySchema.parse({
      id: row.id,
      key: row.key,
      locale: row.locale,
      version: row.version,
      active: row.active,
      note: row.note,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      chars: row.body.length,
      body: row.body,
    })
  })

  /**
   * A candidate body against the active one.
   *
   * A POST that writes nothing, because the thing being sent is a multi-kilobyte
   * prompt and a query string is not where that goes. `requireUser`: reading a diff
   * of one's own deployment's prompt is not a change.
   */
  app.post('/api/settings/prompts/diff', (request: FastifyRequest): PromptDiff => {
    requireUser(request)
    const { key, locale, body } = parseBody(promptDiffRequest, request.body)
    const { active, diff } = diffAgainstActive(db, key, locale, body)

    return promptDiffSchema.parse({
      active: { id: active.id, version: active.version, locale: active.locale },
      stat: diff.stat,
      lines: diff.lines,
    })
  })

  /**
   * A new prompt version.
   *
   * Storing and activating are separate gestures — `activate: true` does both for
   * the case where someone is sure — because the point of versioning a prompt is
   * that the text which produced last month's output still exists. Nothing here
   * overwrites anything.
   */
  app.post('/api/settings/prompts', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const input = parseBody(promptCreateRequest, request.body)

    const previous = input.activate === true ? loadActivePrompt(db, input.key, input.locale) : null
    const row = createPromptVersion(db, {
      key: input.key,
      locale: input.locale,
      body: input.body,
      createdBy: user.id,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.activate === undefined ? {} : { activate: input.activate }),
    })

    recordAudit(db, {
      action: 'prompt.create',
      entity: 'prompts',
      entityRef: row.id,
      actorId: user.id,
      // The text is the row; the entry says what became of it and who did it. A
      // kilobyte of prompt in every audit line would make the trail unreadable.
      after: {
        key: row.key,
        locale: row.locale,
        version: row.version,
        chars: row.body.length,
        active: row.active,
      },
    })

    if (row.active && previous?.id !== row.id) {
      recordAudit(db, {
        action: 'prompt.activate',
        entity: 'prompts',
        entityRef: row.id,
        actorId: user.id,
        before: previous === null ? null : { id: previous.id, version: previous.version },
        after: { id: row.id, version: row.version },
      })
    }

    return buildSettings(db, request)
  })

  /**
   * Makes a stored version the active one. This is also the rollback gesture: the
   * id of an older version, and its text is in use again untouched.
   */
  app.post('/api/settings/prompts/:id/activate', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const id = (request.params as { id: string }).id

    const row = loadPrompt(db, id)
    if (row === null) throw notFound('No such prompt version.')

    const previous = loadActivePrompt(db, promptKeyOf(row.key), row.locale)
    const activated = activatePrompt(db, id)

    recordAudit(db, {
      action: 'prompt.activate',
      entity: 'prompts',
      entityRef: activated.id,
      actorId: user.id,
      before: previous === null ? null : { id: previous.id, version: previous.version },
      after: { id: activated.id, version: activated.version },
    })

    return buildSettings(db, request)
  })

  /**
   * Stop using one language's override, so the shared prompt applies to it again.
   *
   * The text is not deleted — the override's versions stay in the list, and
   * reactivating one is the ordinary rollback. `404` would be a lie when there is
   * nothing to switch off: the language exists, the request simply changed nothing,
   * which is what `409` says.
   */
  app.post('/api/settings/prompts/:key/:locale/shared', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const params = request.params as { key: string; locale: string }
    const key = promptKeyOf(params.key)
    if (params.locale === SHARED_LOCALE) {
      throw badRequest('The shared prompt is what the others fall back to.')
    }
    if (!config.SUPPORTED_LOCALES.includes(params.locale)) {
      throw badRequest(`Unsupported locale: ${params.locale}`)
    }

    const previous = loadActivePrompt(db, key, params.locale)
    if (previous === null) throw conflict('That language has no override to switch off.')
    deactivateOverride(db, key, params.locale)

    recordAudit(db, {
      action: 'prompt.activate',
      entity: 'prompts',
      entityRef: previous.id,
      actorId: user.id,
      before: { id: previous.id, version: previous.version, locale: previous.locale },
      // Null rather than the shared row's id: what was recorded is that this
      // language stopped having an answer of its own, not that it gained one.
      after: null,
    })

    return buildSettings(db, request)
  })
}
