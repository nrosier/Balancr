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
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import {
  dedupeCandidates,
  groupAccounts,
  loadAccountMap,
  setSourceOfTruth,
  ungroupAccount,
  updateAccountMap,
  type AccountMapRow,
} from '../../domain/aggregate/accounts.ts'
import {
  DEFAULT_PARAMS,
  loadParams,
  PARAMS_KEY,
  saveParams,
  unknownParamFields,
} from '../../domain/aggregate/params.ts'
import { budgetState, loadSpendHistory } from '../../domain/ai/budget.ts'
import {
  activatePrompt,
  createPromptVersion,
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
import { badRequest, invalidBody, notFound } from '../errors.ts'
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
  locale: localeRequest,
  body: promptBodyRequest,
  /** Why this version exists, for the list. Not the text — that is the row. */
  note: z.string().max(500).optional(),
  activate: z.boolean().optional(),
})

const promptDiffRequest = z.strictObject({
  key: z.enum(PROMPT_KEYS),
  locale: localeRequest,
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
    prompts: PROMPT_KEYS.flatMap((key) =>
      config.SUPPORTED_LOCALES.map((locale) => promptSetting(db, key, locale)),
    ),
    accounts: accounts.map(toAccountSetting),
    dedupe: dedupeCandidates(accounts).map((candidate) => ({
      ghostfolioId: candidate.ghostfolio.id,
      possibleMirrorIds: candidate.possibleMirrors.map((row) => row.id),
    })),
    ai: {
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
   * The signed-in user's own language.
   *
   * The one write a viewer may make, because it changes what *they* see and nothing
   * anyone else does — so `requireUser`, not `requireOwner`. `request.user` is
   * replaced before the response is built: it was loaded before the change, and a
   * payload still quoting the old locale would leave the page showing the language
   * it just left.
   */
  app.patch('/api/settings/profile', (request: FastifyRequest) => {
    const user = requireUser(request)
    const { locale } = parseBody(profilePatchRequest, request.body)

    const updated = setUserLocale(db, user.id, locale)
    request.user = updated

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
}
