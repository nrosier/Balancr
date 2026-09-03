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
import { loadLatestAccountBalances } from '../../domain/aggregate/networth-store.ts'
import {
  DEFAULT_PARAMS,
  loadParams,
  PARAMS_KEY,
  saveParams,
  unknownParamFields,
} from '../../domain/aggregate/params.ts'
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

/** Everything the settings screen shows. See `settingsSchema` for the shape. */
export function buildSettings(db: Db, request: FastifyRequest): Settings {
  const user = requireUser(request)
  const accounts = loadAccountMap(db)
  const budget = budgetState(db)

  return settingsSchema.parse({
    build: { version: APP_VERSION, revision: APP_REVISION },
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
