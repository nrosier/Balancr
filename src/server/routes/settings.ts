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
import { GoogleGenAI, type GoogleGenAIOptions } from '@google/genai'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { testActualConnection } from '../../adapters/actual/test-connection.ts'
import { authSchema } from '../../adapters/ghostfolio/types.ts'
import { eurToMicroEur } from '../../adapters/gemini/pricing.ts'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { decryptField, encryptField } from '../../db/field-crypto.ts'
import { tenantIntegrations } from '../../db/schema.ts'
import { integrationsRow } from '../../db/tenant-integrations.ts'
import { withTestHost } from '../../egress.ts'
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
  unlinkGroup,
  updateAccountMap,
  type AccountMapRow,
} from '../../domain/aggregate/accounts.ts'
import { earliestStoredMonth, latestStoredMonth } from '../../domain/aggregate/month-store.ts'
import { resolveInclusion, type ExclusionReason } from '../../domain/aggregate/networth.ts'
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
import { loadProperties, PROPERTY_KEY, saveProperties } from '../../domain/property/properties.ts'
import {
  AI_VISIBILITY_CHOICES,
  COICOP_CHOICES,
  loadMapping,
  MappingError,
  SAVINGS_NATURE_CHOICES,
  saveAiVisibility,
  saveCoicop,
  saveCustodyShared,
  saveNature,
} from '../../domain/benchmark/mapping.ts'
import { benchmarkOrNull, transcribedBlocks } from '../../domain/benchmark/model.ts'
import { BENCHMARK_COUNTRIES, SHARED_COST_DIRECTIONS } from '../../domain/benchmark/vocabulary.ts'
import {
  applyReferenceOverride,
  clearReferenceOverride,
  loadReferenceOverride,
  REFERENCE_OVERRIDE_KEY,
  saveReferenceOverride,
} from '../../domain/benchmark/reference.ts'
import { tenantAiAvailability } from '../../domain/ai/availability.ts'
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
import { createInvite, listInvites, revokeInvite, type TenantInvite } from '../../domain/tenant/invites.ts'
import { jobsInFlight } from '../../jobs/runner.ts'
import { MAX_LINES } from '../../util/diff.ts'
import { requireOwner, requireUser } from '../auth/guard.ts'
import { setUserLocale } from '../auth/users.ts'
import { badRequest, conflict, invalidBody, notFound } from '../errors.ts'
import { rememberLocale } from '../locale.ts'
import { integrationsTestRateLimit } from '../rate-limit.ts'
import { fieldIssues, parseBody } from '../validate.ts'
import { APP_REVISION, APP_VERSION } from '../version.ts'
import {
  accountSettingSchema,
  integrationsSettingSchema,
  integrationTestSchema,
  inviteCreatedSchema,
  promptBodySchema,
  promptDiffSchema,
  promptSchema,
  settingsSchema,
  type AccountSetting,
  type IntegrationsSetting,
  type IntegrationTest,
  type InviteCreated,
  type InviteSetting,
  type PromptBody,
  type PromptDiff,
  type PromptSetting,
  type Settings,
} from './api/schemas.ts'
import { busyError } from './refresh.ts'

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
  /**
   * Which country's benchmark file this household compares against (#244). Optional so a
   * form that predates the field is not rejected — and, like every other field on this
   * patch, omitting it *replaces* rather than preserves, landing the schema's own `BE`
   * default. That default is what every household configured before this field existed
   * was, in effect, already comparing against.
   */
  country: z.enum(BENCHMARK_COUNTRIES).optional(),
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
  /**
   * Which way that share reads (#289). Optional for the same reason and with the same
   * consequence as the two fields above: omitting it *replaces* rather than preserves, so
   * a form that predates the field lands the schema's own default. That default is
   * `whole_invoice`, which is what the feature modelled before the field existed and
   * therefore what anybody who configured a share back then meant — so the one patch that
   * can silently set this is the one that cannot be changing anybody's mind.
   */
  sharedCostDirection: z.enum(SHARED_COST_DIRECTIONS).optional(),
})

/**
 * A correction to the average household the level comparison scales (#290).
 *
 * One nullable object rather than three fields, because the domain rule is "both numbers or
 * neither" and null is how the form says "go back to the file's figure". A partial patch
 * would be a third state nobody asked for: half an override, scaling a national average by
 * a number from one source against a total from another.
 *
 * `savedOn` is deliberately absent. The server stamps it, because a client that could
 * choose the date could make a typed figure look permanently fresh — the same thing
 * `verifiedDateSchema` refuses a future date in order to prevent.
 */
const referencePatchRequest = z.strictObject({
  reference: z
    .strictObject({
      meanMonthlyCents: z.number().int(),
      equivalentAdultsBp: z.number().int(),
      citation: z.string(),
    })
    .nullable(),
})

/**
 * The owned properties and their mortgages, if any (#227, #393).
 *
 * The whole list, always — same reason as the household roster: a list's only two
 * gestures are "here is a new one" and "drop a row", and a merge can't express the
 * second. Same for the mortgages nested inside each property. The bounds (rate, term,
 * non-negative cents, the twenty-property and three-mortgage caps) live in
 * `propertiesSchema` and are enforced by `saveProperties`, the same division every other
 * patch on this page explains. There is no rate-history endpoint: a rate change on one
 * mortgage is a fresh PATCH of the whole list with today's actual balance as its new
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
      mortgages: z
        .array(
          z.strictObject({
            principalCents: z.number().int(),
            anchorDate: z.string(),
            rateBp: z.number().int(),
            monthlyPaymentCents: z.number().int(),
            remainingTermMonths: z.number().int(),
            originalPrincipalCents: z.number().int().nullable().optional(),
          }),
        )
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

/**
 * How much of one category the AI layer may see (#278).
 *
 * An enum rather than the two booleans it writes, so the wire carries the decision and
 * not its storage: a request that could set `ai_excluded` without `sensitive` would be a
 * request for the one pair of values `saveAiVisibility` exists to make impossible.
 */
const aiVisibilityPatchRequest = z.strictObject({
  aiVisibility: z.enum(AI_VISIBILITY_CHOICES),
})

/**
 * One category's savings/investments tag, or `null` to clear it (#252).
 *
 * Restricted to the two values this form may set — never the AI-proposal values
 * `category_meta.nature` also carries — so a typo'd request can't smuggle a value
 * only `category_meta.set` should ever write. Nullable for the same reason the
 * COICOP division is: taking a wrong tag back is a correction, not a proposal.
 */
const naturePatchRequest = z.strictObject({ nature: z.enum(SAVINGS_NATURE_CHOICES).nullable() })

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

/** #373: what an owner fills in to hand out an invite. The label is theirs alone
 * — free text for "for Jo" — never shown to whoever redeems the code. */
const inviteCreateRequest = z.strictObject({
  label: z.string().min(1).max(120).optional(),
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

/**
 * The Actual connection (#369). `password`/`e2ePassword` are secrets and never sent
 * back to the client, so omitting either key means "leave the stored value
 * unchanged" — there is nothing on the wire for a save that only touched `serverUrl`
 * to echo back. An empty string is never valid: a blank password is not a state this
 * form can express, the same rule a required `.env` var follows.
 */
const actualIntegrationPatchRequest = z.strictObject({
  serverUrl: z.string().min(1),
  syncId: z.string().min(1),
  password: z.string().min(1).optional(),
  e2ePassword: z.string().min(1).optional(),
})

/** The Ghostfolio connection (#369). See `actualIntegrationPatchRequest` for why `securityToken` is optional. */
const ghostfolioIntegrationPatchRequest = z.strictObject({
  url: z.string().min(1),
  securityToken: z.string().min(1).optional(),
})

/**
 * The Gemini connection (#369). `googleCloudProject` is not a secret, so unlike
 * `apiKey` it is not optional — it is replaced wholesale like every other plain field
 * on this page, and `null` is how a switch to `aistudio` clears it.
 *
 * `modelFast`/`modelDeep`/`budgetEur` moved from `.env` to here (#371): a model
 * choice and a monthly cap are exactly as per-tenant as the credential they run
 * against, and unlike the credential neither is a secret — they round-trip as
 * plain fields, the same as `googleCloudProject`.
 */
const geminiIntegrationPatchRequest = z.strictObject({
  provider: z.enum(['aistudio', 'vertex']),
  apiKey: z.string().min(1).optional(),
  googleCloudProject: z.string().min(1).nullable(),
  modelFast: z.string().min(1),
  modelDeep: z.string().min(1),
  budgetEur: z.coerce.number().nonnegative(),
})

/**
 * A "test connection" body carries the *full* candidate credential, never a partial
 * patch — nothing is saved by a test, so there is no stored value to merge against.
 *
 * A secret key is optional here for the same reason it's optional on the PATCH
 * request: a secret field is always blank on load, so a test of an
 * already-configured integration can only omit it. The handler below falls back
 * to the tenant's own stored secret when it's omitted and one exists (#382) —
 * never the other way around, so a test never sends a stored secret for a
 * candidate it did not ask to test.
 */
const actualIntegrationTestRequest = z.strictObject({
  serverUrl: z.string().min(1),
  syncId: z.string().min(1),
  password: z.string().min(1).optional(),
  e2ePassword: z.string().min(1).optional(),
})

/** See `actualIntegrationTestRequest`. */
const ghostfolioIntegrationTestRequest = z.strictObject({
  url: z.string().min(1),
  securityToken: z.string().min(1).optional(),
})

/** See `actualIntegrationTestRequest`. `googleCloudLocation` defaults to the deployment's own when omitted. */
const geminiIntegrationTestRequest = z.strictObject({
  provider: z.enum(['aistudio', 'vertex']),
  apiKey: z.string().min(1).optional(),
  googleCloudProject: z.string().min(1).optional(),
  googleCloudLocation: z.string().min(1).optional(),
})

// ---------------------------------------------------------------------------
//  Reading
// ---------------------------------------------------------------------------

const toAccountSetting = (row: AccountMapRow, netWorthExclusionReason: ExclusionReason | null): AccountSetting =>
  accountSettingSchema.parse({
    id: row.id,
    source: row.source,
    name: row.name,
    kind: row.kind,
    includeInNetWorth: row.includeInNetWorth,
    dedupeGroup: row.dedupeGroup,
    isSourceOfTruth: row.isSourceOfTruth,
    decidedFields: [...decidedFields(row)].sort(),
    netWorthExclusionReason,
  })

/**
 * Why each account isn't counted in net worth, from the mapping alone (#245).
 *
 * `resolveInclusion` needs only `includeInNetWorth`/`dedupeGroup`/`isSourceOfTruth`
 * — no balance, so no live Actual/Ghostfolio fetch — which is what lets this run on
 * every settings read rather than only during the nightly job that logs the same
 * reasons and nothing else sees.
 */
const netWorthExclusionReasons = (rows: readonly AccountMapRow[]): Map<string, ExclusionReason> =>
  resolveInclusion(
    rows.map((row) => ({
      accountMapId: row.id,
      includeInNetWorth: row.includeInNetWorth,
      dedupeGroup: row.dedupeGroup,
      isSourceOfTruth: row.isSourceOfTruth,
    })),
  ).excluded

/**
 * One prompt's active text and its history.
 *
 * `active` comes from `resolvePrompt` rather than from the active row, because the
 * two are not the same thing: with no Dutch version stored, the Dutch prompt in use
 * is the English one, and with no rows at all it is the built-in constant. An editor
 * that showed an empty box in either case is how someone saves a prompt over
 * nothing and wonders why the output changed.
 */
function promptSetting(db: Db, tenantId: string, key: PromptKey, locale: string): PromptSetting {
  const active = resolvePrompt(db, tenantId, key, locale)
  return promptSchema.parse({
    key,
    locale,
    active: { id: active.id, version: active.version, locale: active.locale, body: active.body },
    versions: listPromptVersions(db, tenantId, key, locale).map((row) => ({
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
function riskProfileSetting(db: Db, tenantId: string): Settings['advice'] {
  const profile = loadProfile(db, tenantId)
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
function benchmarkSetting(db: Db, tenantId: string): Settings['benchmark'] {
  // The household is loaded first because its `country` decides which file to read (#244)
  // — the same ordering `benchmarkContext` uses, and for the same reason.
  const household = loadHousehold(db, tenantId)
  // The *file's* benchmark, not the overridden one: the panel shows what an override is
  // replacing beside the override itself, so a mistyped correction can be spotted against
  // the figure it corrected (#290). Everything that draws a comparison reads
  // `benchmarkContext`, which applies the override.
  const benchmark = benchmarkOrNull(household.country)
  const override = loadReferenceOverride(db, tenantId)

  return {
    file:
      benchmark === null
        ? null
        : {
            jurisdiction: benchmark.jurisdiction,
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
            referenceHousehold:
              benchmark.referenceHousehold === null
                ? null
                : {
                    meanMonthlyCents: benchmark.referenceHousehold.mean_monthly_cents,
                    equivalentAdultsBp: benchmark.referenceHousehold.equivalent_adults_bp,
                    citation: benchmark.referenceHousehold.citation,
                    sourceUrl: benchmark.referenceHousehold.source_url ?? null,
                    lastVerified: benchmark.referenceHousehold.last_verified,
                    status: benchmark.referenceHousehold.status,
                  },
            // Which blocks carry a caveat *as read*, so the panel and the budget card agree:
            // an override is never confirmed, so overriding a confirmed figure adds
            // `reference_household` to this list.
            transcribed: [...transcribedBlocks(applyReferenceOverride(benchmark, override))],
          },
    household: {
      country: household.country,
      members: household.members.map((member) => ({
        birthYear: member.birthYear,
        custodyBp: member.custodyBp,
        ...(member.label === undefined ? {} : { label: member.label }),
      })),
      ...(household.selfLabel === undefined ? {} : { selfLabel: household.selfLabel }),
      sharedCostBp: household.sharedCostBp,
      sharedCostDirection: household.sharedCostDirection,
    },
    referenceOverride:
      override === null
        ? null
        : {
            meanMonthlyCents: override.meanMonthlyCents,
            equivalentAdultsBp: override.equivalentAdultsBp,
            citation: override.citation,
            savedOn: override.savedOn,
          },
    outsideCode: '00',
    categories: loadMapping(db, tenantId, latestStoredMonth(db, tenantId)),
  }
}

/**
 * The connection, with every secret replaced by whether it is set (#369).
 *
 * Never the ciphertext and never the plaintext: a secret that round-tripped through
 * this screen even once would make the settings response the second place it could
 * leak from, on top of the database column.
 */
function loadIntegrations(db: Db, tenantId: string): IntegrationsSetting {
  const row = integrationsRow(db, tenantId)
  return integrationsSettingSchema.parse({
    actual: {
      serverUrl: row.actualServerUrl,
      syncId: row.actualSyncId,
      passwordConfigured: row.actualPasswordEnc.length > 0,
      e2ePasswordConfigured: row.actualE2ePasswordEnc !== null,
    },
    ghostfolio: {
      url: row.ghostfolioUrl,
      tokenConfigured: row.ghostfolioSecurityTokenEnc.length > 0,
    },
    gemini: {
      provider: row.geminiProvider,
      apiKeyConfigured: row.geminiApiKeyEnc !== null,
      googleCloudProject: row.googleCloudProject,
      modelFast: row.geminiModelFast,
      modelDeep: row.geminiModelDeep,
      budgetEurMicro: row.geminiMonthlyBudgetEurMicro,
    },
  })
}

/** Everything the settings screen shows. See `settingsSchema` for the shape. */
export function buildSettings(db: Db, request: FastifyRequest): Settings {
  const user = requireUser(request)
  const accounts = loadAccountMap(db, user.tenantId)
  const exclusionReasons = netWorthExclusionReasons(accounts)
  const budget = budgetState(db, user.tenantId)

  return settingsSchema.parse({
    build: { version: APP_VERSION, revision: APP_REVISION },
    history: {
      months: config.JOBS_HISTORY_MONTHS,
      earliest: earliestStoredMonth(db, user.tenantId),
      latest: latestStoredMonth(db, user.tenantId),
    },
    profile: {
      email: user.email,
      displayName: user.displayName,
      locale: user.locale,
      role: user.role,
    },
    locales: { supported: config.SUPPORTED_LOCALES, default: config.DEFAULT_LOCALE },
    params: loadParams(db, user.tenantId),
    paramDefaults: DEFAULT_PARAMS,
    advice: riskProfileSetting(db, user.tenantId),
    benchmark: benchmarkSetting(db, user.tenantId),
    property: loadProperties(db, user.tenantId),
    integrations: loadIntegrations(db, user.tenantId),
    invites: listInvites(db, user.tenantId).map(toInviteSetting),
    // The shared text first, then only those languages someone has actually written
    // an override for. Listing every supported locale unconditionally is what made
    // the divergence look mandatory: four entries carrying two texts, and no way to
    // tell an override from a copy of the seed.
    //
    // A switched-off override keeps its entry, because its versions still exist and
    // reactivating one is the rollback gesture. `active.locale` is what distinguishes
    // the two states, and it is already on the wire.
    prompts: PROMPT_KEYS.flatMap((key) => [
      promptSetting(db, user.tenantId, key, SHARED_LOCALE),
      ...config.SUPPORTED_LOCALES.map((locale) =>
        promptSetting(db, user.tenantId, key, locale),
      ).filter((entry) => entry.versions.length > 0),
    ]),
    accounts: accounts.map((row) => toAccountSetting(row, exclusionReasons.get(row.id) ?? null)),
    dedupe: dedupeCandidates(accounts, loadLatestAccountBalances(db, user.tenantId)).map((candidate) => ({
      ghostfolioId: candidate.ghostfolio.id,
      actualId: candidate.actual.id,
      signals: candidate.signals,
    })),
    ai: {
      availability: tenantAiAvailability(db, user.tenantId),
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

/** `TenantInvite` as the wire shape — never the code, only ever `codeHash`'s absence. */
const toInviteSetting = (invite: TenantInvite): InviteSetting => ({
  id: invite.id,
  label: invite.label,
  createdAt: invite.createdAt.toISOString(),
  expiresAt: invite.expiresAt.toISOString(),
  redeemedAt: invite.redeemedAt === null ? null : invite.redeemedAt.toISOString(),
  revokedAt: invite.revokedAt === null ? null : invite.revokedAt.toISOString(),
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

    const before = loadParams(db, user.tenantId)
    let after
    try {
      after = saveParams(db, user.tenantId, patch)
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

    const before = loadProfile(db, user.tenantId)
    let after
    try {
      after = saveProfile(db, user.tenantId, patch)
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

    const before = loadHousehold(db, user.tenantId)
    let after
    try {
      after = saveHousehold(db, user.tenantId, patch)
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
   * A correction to the average household the level comparison scales (#290).
   *
   * Takes effect immediately, like the roster and for the same reason: the comparison is
   * computed per request, so the budget card scales against the new figure on its next
   * load. Stored signals are not rewritten — a signal is a judgement made at a time — and
   * the next nightly pass restates them against the corrected reference.
   *
   * Sending `reference: null` clears the override rather than storing an empty one, so the
   * file's figure applies again. That is the only way back, and it is why the field is
   * nullable rather than three optional numbers.
   */
  app.patch('/api/settings/benchmark-reference', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const { reference } = parseBody(referencePatchRequest, request.body)

    const before = loadReferenceOverride(db, user.tenantId)
    let after: typeof before = null
    if (reference !== null) {
      try {
        after = saveReferenceOverride(db, user.tenantId, reference)
      } catch (error) {
        // The bounds — a positive total, a household of at least one on the scale, a
        // citation long enough to name something — are checked against the parsed object
        // rather than in `parseBody`, the same division as the roster and the bands.
        if (error instanceof z.ZodError) {
          throw invalidBody('The request body was not valid.', fieldIssues(error))
        }
        throw error
      }
    } else {
      clearReferenceOverride(db, user.tenantId)
    }

    recordAudit(db, {
      action: 'settings.benchmarkReference',
      entity: 'settings',
      entityRef: REFERENCE_OVERRIDE_KEY,
      actorId: user.id,
      // Both figures both ways, and null for "the file's figure applies". The question the
      // trail answers is "what average household was that comparison drawn against".
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

    const before = loadProperties(db, user.tenantId)
    let after
    try {
      after = saveProperties(db, user.tenantId, patch)
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
   * The Actual connection this tenant syncs from (#369).
   *
   * `password`/`e2ePassword` are the "omit means unchanged" case — see
   * `actualIntegrationPatchRequest`. `updatedAt` is set explicitly because the
   * column's default only fires on insert, never on update.
   */
  app.patch('/api/settings/integrations/actual', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const patch = parseBody(actualIntegrationPatchRequest, request.body)
    const tenantId = user.tenantId
    const before = loadIntegrations(db, tenantId)

    db.update(tenantIntegrations)
      .set({
        actualServerUrl: patch.serverUrl,
        actualSyncId: patch.syncId,
        ...(patch.password === undefined ? {} : { actualPasswordEnc: encryptField(patch.password) }),
        ...(patch.e2ePassword === undefined
          ? {}
          : { actualE2ePasswordEnc: encryptField(patch.e2ePassword) }),
        updatedAt: new Date(),
      })
      .where(eq(tenantIntegrations.tenantId, tenantId))
      .run()

    const after = loadIntegrations(db, tenantId)
    recordAudit(db, {
      action: 'settings.integrations',
      entity: 'tenant_integrations',
      entityRef: tenantId,
      actorId: user.id,
      before: before.actual,
      after: after.actual,
    })

    return buildSettings(db, request)
  })

  /** The Ghostfolio connection this tenant reads from (#369). See the Actual route above. */
  app.patch('/api/settings/integrations/ghostfolio', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const patch = parseBody(ghostfolioIntegrationPatchRequest, request.body)
    const tenantId = user.tenantId
    const before = loadIntegrations(db, tenantId)

    db.update(tenantIntegrations)
      .set({
        ghostfolioUrl: patch.url,
        ...(patch.securityToken === undefined
          ? {}
          : { ghostfolioSecurityTokenEnc: encryptField(patch.securityToken) }),
        updatedAt: new Date(),
      })
      .where(eq(tenantIntegrations.tenantId, tenantId))
      .run()

    const after = loadIntegrations(db, tenantId)
    recordAudit(db, {
      action: 'settings.integrations',
      entity: 'tenant_integrations',
      entityRef: tenantId,
      actorId: user.id,
      before: before.ghostfolio,
      after: after.ghostfolio,
    })

    return buildSettings(db, request)
  })

  /** The Gemini connection this tenant's AI pass uses (#369). See the Actual route above. */
  app.patch('/api/settings/integrations/gemini', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const patch = parseBody(geminiIntegrationPatchRequest, request.body)
    const tenantId = user.tenantId
    const before = loadIntegrations(db, tenantId)

    db.update(tenantIntegrations)
      .set({
        geminiProvider: patch.provider,
        googleCloudProject: patch.googleCloudProject,
        ...(patch.apiKey === undefined ? {} : { geminiApiKeyEnc: encryptField(patch.apiKey) }),
        geminiModelFast: patch.modelFast,
        geminiModelDeep: patch.modelDeep,
        geminiMonthlyBudgetEurMicro: eurToMicroEur(patch.budgetEur),
        updatedAt: new Date(),
      })
      .where(eq(tenantIntegrations.tenantId, tenantId))
      .run()

    const after = loadIntegrations(db, tenantId)
    recordAudit(db, {
      action: 'settings.integrations',
      entity: 'tenant_integrations',
      entityRef: tenantId,
      actorId: user.id,
      before: before.gemini,
      after: after.gemini,
    })

    return buildSettings(db, request)
  })

  /**
   * Whether a candidate Ghostfolio URL/token actually work (#369).
   *
   * Nothing is persisted here, so there is no `before`/`after` to audit and no
   * partial-update merge to do — the URL is always the candidate typed into the
   * form, and a blank token falls back to the tenant's own stored one so testing
   * an already-configured connection doesn't require retyping it (#382).
   * Ghostfolio's client module keeps its own cached token, but that state belongs
   * to the *saved* connection; this call never touches it, which is what makes a
   * standalone fetch
   * here safe to run alongside a real request in flight.
   */
  app.post(
    '/api/settings/integrations/ghostfolio/test',
    { ...integrationsTestRateLimit() },
    async (request: FastifyRequest): Promise<IntegrationTest> => {
      const user = requireOwner(request)
      const candidate = parseBody(ghostfolioIntegrationTestRequest, request.body)
      const base = candidate.url.replace(/\/+$/, '')

      const stored = integrationsRow(db, user.tenantId).ghostfolioSecurityTokenEnc
      const securityToken = candidate.securityToken ?? (stored.length > 0 ? decryptField(stored) : undefined)
      if (securityToken === undefined) {
        throw badRequest('A security token is required to test this connection.')
      }

      const result = await withTestHost(candidate.url, async (): Promise<IntegrationTest> => {
        try {
          const health = await fetch(`${base}/api/v1/health`, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(20_000),
          })
          if (!health.ok) {
            return { ok: false, message: `${base} returned HTTP ${health.status} for /api/v1/health.` }
          }

          const auth = await fetch(`${base}/api/v1/auth/anonymous`, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ accessToken: securityToken }),
            signal: AbortSignal.timeout(20_000),
          })
          if (!auth.ok) {
            return { ok: false, message: `Authentication failed: HTTP ${auth.status}.` }
          }

          const parsed = authSchema.safeParse(await auth.json())
          if (!parsed.success) {
            return { ok: false, message: 'Ghostfolio did not return an auth token.' }
          }
          return { ok: true, message: null }
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      })

      return integrationTestSchema.parse(result)
    },
  )

  /**
   * Whether a candidate Gemini key/project actually work (#369).
   *
   * `models.list()` is the cheapest call that proves the credential is live —
   * never `generateContent`, so testing a key spends no part of the tenant's own
   * budget. The client built here is a throwaway instance, never
   * `setGeminiClient`'s shared one, so a test in flight cannot affect a real call
   * running at the same time.
   */
  app.post(
    '/api/settings/integrations/gemini/test',
    { ...integrationsTestRateLimit() },
    async (request: FastifyRequest): Promise<IntegrationTest> => {
      const user = requireOwner(request)
      const candidate = parseBody(geminiIntegrationTestRequest, request.body)
      const location = candidate.googleCloudLocation ?? config.GOOGLE_CLOUD_LOCATION

      let options: GoogleGenAIOptions
      let testUrl: string
      if (candidate.provider === 'vertex') {
        const project = candidate.googleCloudProject
        if (project === undefined) {
          throw badRequest('A Google Cloud project is required to test a Vertex connection.')
        }
        options = { vertexai: true, project, location }
        testUrl = `https://${location}-aiplatform.googleapis.com`
      } else {
        const stored = integrationsRow(db, user.tenantId).geminiApiKeyEnc
        const apiKey = candidate.apiKey ?? (stored === null ? undefined : decryptField(stored))
        if (apiKey === undefined) {
          throw badRequest('An API key is required to test an AI Studio connection.')
        }
        options = { apiKey }
        testUrl = ''
      }

      const result = await withTestHost(testUrl, async (): Promise<IntegrationTest> => {
        try {
          const client = new GoogleGenAI(options)
          await client.models.list({ config: { pageSize: 1 } })
          return { ok: true, message: null }
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      })

      return integrationTestSchema.parse(result)
    },
  )

  /**
   * Whether a candidate Actual server/budget/password actually work (#369).
   *
   * `@actual-app/api` is a process-wide singleton (see `client.ts`'s header), so
   * this cannot call `api.init`/`api.downloadBudget` in this process without risking
   * the real, already-open client — `testActualConnection` runs the attempt in a
   * forked child process instead, which gets its own copy of that module and so can
   * never collide with it. `jobsInFlight` is still checked here, but as a courtesy
   * rather than a safety property: the fork already makes this test safe to run
   * during a live sync, but starting one anyway would open a second connection to
   * someone else's Actual server while the real one is mid-sync, which is worth
   * refusing even though nothing would actually break.
   */
  app.post(
    '/api/settings/integrations/actual/test',
    { ...integrationsTestRateLimit() },
    async (request: FastifyRequest): Promise<IntegrationTest> => {
      const user = requireOwner(request)
      const candidate = parseBody(actualIntegrationTestRequest, request.body)

      const busy = jobsInFlight(user.tenantId)
      if (busy.length > 0) throw busyError(busy)

      const row = integrationsRow(db, user.tenantId)
      const password = candidate.password ?? (row.actualPasswordEnc.length > 0 ? decryptField(row.actualPasswordEnc) : undefined)
      if (password === undefined) throw badRequest('A password is required to test this connection.')
      const e2ePassword =
        candidate.e2ePassword ?? (row.actualE2ePasswordEnc === null ? undefined : decryptField(row.actualE2ePasswordEnc))

      const result = await withTestHost(candidate.serverUrl, () =>
        testActualConnection({ serverUrl: candidate.serverUrl, syncId: candidate.syncId, password, e2ePassword }),
      )

      return integrationTestSchema.parse(result)
    },
  )

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

    const before = loadMapping(db, user.tenantId, null).find(
      (row) => row.categoryId === categoryId,
    )
    if (before === undefined) throw notFound('No such category.')

    try {
      saveCoicop(db, user.tenantId, categoryId, coicop)
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

    const before = loadMapping(db, user.tenantId, null).find(
      (row) => row.categoryId === categoryId,
    )
    if (before === undefined) throw notFound('No such category.')

    try {
      saveCustodyShared(db, user.tenantId, categoryId, custodyShared)
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
   * Sets how much of one envelope the AI layer may see (#278).
   *
   * The one settings route whose effect is on what leaves the machine, which is why the
   * body is the three-state answer and not the two columns behind it: see
   * `saveAiVisibility` for why the pair is always written together.
   *
   * Allowed on an income or hidden category, unlike the two routes above, and for a
   * reason that is not consistency: those two flags feed features that ignore both
   * kinds, so storing one there would do nothing — but a hidden envelope with money in
   * it *is* sent (`bundle.ts`'s `worthSending`), and an income envelope always is. So
   * the answer means something for every row in the table, and the control is never
   * closed.
   */
  app.patch('/api/settings/categories/:id/ai-visibility', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const categoryId = (request.params as { id: string }).id
    const { aiVisibility } = parseBody(aiVisibilityPatchRequest, request.body)

    const before = loadMapping(db, user.tenantId, null).find(
      (row) => row.categoryId === categoryId,
    )
    if (before === undefined) throw notFound('No such category.')

    try {
      saveAiVisibility(db, user.tenantId, categoryId, aiVisibility)
    } catch (error) {
      if (error instanceof MappingError) throw notFound('No such category.')
      throw error
    }

    recordAudit(db, {
      action: 'settings.aiVisibility',
      entity: 'category_meta',
      entityRef: categoryId,
      actorId: user.id,
      before: { aiVisibility: before.aiVisibility },
      after: { aiVisibility },
    })

    return buildSettings(db, request)
  })

  /**
   * Tags a category as a savings or investments envelope, or takes the tag back (#252).
   *
   * Manual only, on purpose: the advisory nudge this feeds (`budget_toward_savings`,
   * `budget_toward_investments`, `savings_drawn_down`) reads which categories carry this
   * tag, and neither an AI proposal nor a clarification may ever set it — see the comment
   * on `category_meta.nature` in `db/schema.ts`. Same shape as the two writers above it.
   */
  app.patch('/api/settings/categories/:id/nature', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const categoryId = (request.params as { id: string }).id
    const { nature } = parseBody(naturePatchRequest, request.body)

    const before = loadMapping(db, user.tenantId, null).find(
      (row) => row.categoryId === categoryId,
    )
    if (before === undefined) throw notFound('No such category.')

    try {
      saveNature(db, user.tenantId, categoryId, nature)
    } catch (error) {
      if (error instanceof MappingError) throw notFound('No such category.')
      throw error
    }

    recordAudit(db, {
      action: 'settings.nature',
      entity: 'category_meta',
      entityRef: categoryId,
      actorId: user.id,
      before: { nature: before.nature },
      after: { nature },
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

    const before = loadAccountMap(db, user.tenantId).find((row) => row.id === id)
    if (before === undefined) throw notFound('No such account.')

    // Spread rather than passed through: with `exactOptionalPropertyTypes`, a
    // parsed body's absent field is `undefined` and the domain patch's is absent.
    const after = updateAccountMap(db, user.tenantId, id, {
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

    const before = loadAccountMap(db, user.tenantId).find((row) => row.id === id)
    if (before === undefined) throw notFound('No such account.')

    const after = setSourceOfTruth(db, user.tenantId, id)
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

    const rows = loadAccountMap(db, user.tenantId)
    const known = new Set(rows.map((row) => row.id))
    const missing = accountMapIds.filter((id) => !known.has(id))
    if (missing.length > 0) throw notFound('No such account.')

    const group = groupAccounts(db, user.tenantId, accountMapIds, sourceOfTruthId)

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
   * Takes an account's whole group apart, and back to every member counting for
   * itself.
   *
   * The reverse of grouping, over the whole group, not just the row named: the
   * settings panel shows a group of two as one linked block with one "Unlink"
   * button, so an id named here stands in for its pair. `unlinkGroup` is what makes
   * that atomic — freeing one side and leaving the other as the sole member of a
   * group with no source of truth would drop its money out of net worth with
   * nothing on screen to explain why.
   */
  app.post('/api/settings/accounts/:id/ungroup', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const id = (request.params as { id: string }).id

    const rows = loadAccountMap(db, user.tenantId)
    const before = rows.find((row) => row.id === id)
    if (before === undefined) throw notFound('No such account.')

    const after = unlinkGroup(db, user.tenantId, id)
    if (after.length === 0) throw notFound('No such account.')

    for (const row of after) {
      recordAudit(db, {
        action: 'account.map',
        entity: 'account_map',
        entityRef: row.id,
        actorId: user.id,
        before: accountJudgement(rows.find((candidate) => candidate.id === row.id) ?? row),
        after: accountJudgement(row),
      })
    }

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

    const before = loadAccountMap(db, user.tenantId).find((row) => row.id === id)
    if (before === undefined) throw notFound('No such account.')
    if (before.dedupeGroup !== null) {
      throw conflict('That account is in a group. Ungroup it instead.')
    }

    const after = dismissMirror(db, user.tenantId, id)
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
    const user = requireUser(request)
    const row = loadPrompt(db, user.tenantId, (request.params as { id: string }).id)
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
    const user = requireUser(request)
    const { key, locale, body } = parseBody(promptDiffRequest, request.body)
    const { active, diff } = diffAgainstActive(db, user.tenantId, key, locale, body)

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

    const previous =
      input.activate === true
        ? loadActivePrompt(db, user.tenantId, input.key, input.locale)
        : null
    const row = createPromptVersion(db, user.tenantId, {
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

    const row = loadPrompt(db, user.tenantId, id)
    if (row === null) throw notFound('No such prompt version.')

    const previous = loadActivePrompt(db, user.tenantId, promptKeyOf(row.key), row.locale)
    const activated = activatePrompt(db, user.tenantId, id)

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

    const previous = loadActivePrompt(db, user.tenantId, key, params.locale)
    if (previous === null) throw conflict('That language has no override to switch off.')
    deactivateOverride(db, user.tenantId, key, params.locale)

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

  /**
   * Mints an invite (#373). The one response that carries the plaintext code —
   * `buildSettings`/the invite list never do, since only `codeHash` is stored.
   */
  app.post('/api/settings/invites', (request: FastifyRequest): InviteCreated => {
    const user = requireOwner(request)
    const { label } = parseBody(inviteCreateRequest, request.body)

    const { invite, code } = createInvite(db, {
      tenantId: user.tenantId,
      createdBy: user.id,
      label: label ?? null,
    })

    return inviteCreatedSchema.parse({ invite: toInviteSetting(invite), code })
  })

  /** Closes an invite early. Idempotent, like the domain function it calls. */
  app.post('/api/settings/invites/:id/revoke', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const id = (request.params as { id: string }).id

    const existing = listInvites(db, user.tenantId).find((invite) => invite.id === id)
    if (existing === undefined) throw notFound('No such invite.')

    revokeInvite(db, { tenantId: user.tenantId, inviteId: id, actorId: user.id })

    return buildSettings(db, request)
  })
}
