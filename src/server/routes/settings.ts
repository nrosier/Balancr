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
import { resetAiClients } from '../../adapters/ai/client.ts'
import { resetGhostfolioToken } from '../../adapters/ghostfolio/client.ts'
import { authSchema } from '../../adapters/ghostfolio/types.ts'
import { eurToMicroEur, priceFor, type ModelPrice, type ModelPrices } from '../../adapters/ai/pricing.ts'
import { DATA_CLOSE, DATA_OPEN } from '../../adapters/ai/prompt.ts'
import { AI_PROVIDERS, type AiProvider } from '../../adapters/ai/types.ts'
import {
  ANTHROPIC_BASE_URL,
  callAnthropicWithConfig,
} from '../../adapters/anthropic/client.ts'
import {
  baseUrlFor,
  callOpenAiCompatibleWithConfig,
  OPENAI_BASE_URL,
  validateCustomBaseUrl,
  XAI_BASE_URL,
} from '../../adapters/openai-compatible/client.ts'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { decryptField, encryptField } from '../../db/field-crypto.ts'
import { tenantIntegrations } from '../../db/schema.ts'
import { integrationsRow } from '../../db/tenant-integrations.ts'
import { withScopedHost } from '../../egress.ts'
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
import {
  DIGEST_KEY,
  loadDigestPreference,
  MAX_DIGEST_RECIPIENTS,
  saveDigestPreference,
} from '../../domain/digest/preference.ts'
import { deleteDigestPdf, loadDigestPdf } from '../../domain/digest/storage.ts'
import {
  createDebt,
  debtKinds,
  deleteDebt,
  listDebts,
  loadDebt,
  MAX_DEBTS,
  TooManyDebtsError,
  updateDebt,
} from '../../domain/debt/debts.ts'
import {
  createGoal,
  deleteGoal,
  goalKinds,
  goalPriorities,
  listGoals,
  loadGoal,
  markGoalDone,
  MAX_GOALS,
  reactivateGoal,
  TooManyGoalsError,
  UnknownCategoryError,
  updateGoal,
} from '../../domain/goal/goals.ts'
import {
  createLoan,
  deleteLoan,
  listLoans,
  loadLoan,
  loanKinds,
  MAX_LOANS,
  TooManyLoansError,
  updateLoan,
} from '../../domain/loan/loans.ts'
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
import {
  clearTranslationsForLocale,
  loadCategoryTranslationRows,
  saveCategoryTranslation,
  SourceLocaleError,
  TranslationError,
} from '../../domain/i18n/category-translations.ts'
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
  asPromptKey,
  createPromptVersion,
  DEFAULT_PROMPTS,
  deactivateOverride,
  deletePromptVersion,
  diffAgainstActive,
  listPromptVersions,
  loadActivePrompt,
  PROMPT_KEYS,
  loadPrompt,
  promptGateState,
  PromptGateError,
  resolvePrompt,
  type PromptKey,
} from '../../domain/ai/prompts.ts'
import { estimatePromptValidation } from '../../domain/ai/prompt-validate.ts'
import { loadRunCursor, recentRuns } from '../../domain/ai/runs.ts'
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
  aiRunListSchema,
  integrationsSettingSchema,
  integrationTestSchema,
  inviteCreatedSchema,
  microEur,
  promptBodySchema,
  promptDiffSchema,
  promptSchema,
  settingsSchema,
  type AccountSetting,
  type AiRunList,
  type IntegrationsSetting,
  type IntegrationTest,
  type InviteCreated,
  type InviteSetting,
  type PromptBody,
  type PromptDiff,
  type PromptSetting,
  type Settings,
} from './api/schemas.ts'
import { wireRun } from './api/insights.ts'
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
 * The monthly digest's delivery preference (#52): whether it is generated at all,
 * and if so, downloaded as a PDF or mailed.
 *
 * Written wholesale, like the household roster above: omitting `recipientEmails`
 * or `locale` *replaces* rather than preserves, landing `digestPreferenceSchema`'s
 * own defaults (`[]`, "follow my account language"). The cross-field rule —
 * `recipientEmails` required when `mode` is `"email"` — lives in that schema and
 * is enforced by `saveDigestPreference`, the same division `advicePatchRequest`
 * explains.
 */
const digestPatchRequest = z.strictObject({
  // Required, unlike the two below: omitting `recipientEmails` or `locale` lands a
  // sensible default (empty, "follow my account language"), but a client that
  // omitted `mode` by accident would silently switch the digest off rather than
  // leave it alone — the one outcome nobody sending a locale or recipient edit
  // could have meant.
  mode: z.enum(['off', 'pdf', 'email']),
  recipientEmails: z.array(z.email()).max(MAX_DIGEST_RECIPIENTS).optional(),
  locale: localeRequest.optional(),
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
 * One fixed-schedule non-mortgage loan — a car loan, a personal loan (#441).
 *
 * The whole loan, every time, on both the create and the edit: every field is on the form
 * at once, so "leave this one alone" is not a gesture the screen can make, and a merge
 * would leave an omitted `extraMonthlyPaymentCents` ambiguous between "unchanged" and
 * "no longer paying extra". Loose on bounds on purpose, like `propertyPatchRequest` above
 * — the rate ceiling, the term ceiling and the non-negative cents live in
 * `loanInputSchema` and are enforced by `createLoan`/`updateLoan`, which is the same
 * division every other patch on this page explains.
 *
 * Unlike the property list there is no whole-list route: a loan is a table row with an id
 * of its own, so create, edit and delete are three requests naming one loan rather than
 * one request replacing all of them. See `db/schema.ts` above the `loans` table for why
 * it is a table at all.
 */
const loanRequest = z.strictObject({
  kind: z.enum(loanKinds).optional(),
  label: z.string().optional(),
  openingDate: z.string(),
  principalCents: z.number().int(),
  anchorDate: z.string(),
  rateBp: z.number().int(),
  monthlyPaymentCents: z.number().int(),
  remainingTermMonths: z.number().int(),
  originalPrincipalCents: z.number().int().nullable().optional(),
  extraMonthlyPaymentCents: z.number().int().nullable().optional(),
})

/**
 * One revolving debt — a credit card, a store card (#442).
 *
 * Loose on bounds on purpose, same division `loanRequest` explains: the balance
 * ceiling, the APR ceiling and the non-negative cents live in `debtInputSchema` and are
 * enforced by `createDebt`/`updateDebt`. The whole debt, every time, for the same
 * "leave this one alone is not a gesture the form can make" reason `loanRequest` gives —
 * an omitted `aprBp` would be ambiguous between "unchanged" and "no longer known".
 *
 * Three routes rather than a whole-list PATCH, same reasoning as loans: a revolving debt
 * is a table row with an id of its own.
 */
const debtRequest = z.strictObject({
  kind: z.enum(debtKinds).optional(),
  label: z.string().optional(),
  balanceCents: z.number().int(),
  minimumPaymentCents: z.number().int(),
  aprBp: z.number().int().nullable().optional(),
})

/**
 * One savings goal (#407): the whole goal, every time, on both the create and the
 * edit — same reasoning `loanRequest`/`debtRequest` give: a form has no gesture for
 * "leave this one alone", and an omitted `targetDate` would be ambiguous between
 * "unchanged" and "no longer tracking an ETA". The cap and non-negative bounds live
 * in `goalInputSchema` and are enforced by `createGoal`/`updateGoal`, the same
 * division every other patch on this page explains.
 */
const goalRequest = z.strictObject({
  label: z.string().max(80).optional(),
  kind: z.enum(goalKinds).optional(),
  categoryId: z.string().min(1).nullable().optional(),
  priority: z.enum(goalPriorities).optional(),
  targetCents: z.number().int(),
  targetDate: z.string().nullable().optional(),
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
 * One category's name in one locale (#479). `name: null` (or blank) clears the override
 * back to the source-language snapshot — the same "absent means unchanged, null means
 * take it back" shape `coicopPatchRequest` uses, except here even blank counts, since a
 * translation table has no other way to express "type nothing".
 */
const categoryTranslationPatchRequest = z.strictObject({ name: z.string().nullable() })

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
 * How long a prompt body may be (#453, part of #452).
 *
 * Exported because a later PR (#454, the judge call) imports it — the same ceiling
 * that keeps a save request small enough to answer quickly is also the size a
 * candidate body is fenced as data for that call. Not chosen to be generous or
 * strict on its own merits: 20,000 characters is comfortably above every built-in
 * prompt in `prompts.ts` (a few thousand characters each) and comfortably below
 * what would turn a single save into a meaningful fraction of a model's context.
 */
export const PROMPT_BODY_MAX_CHARS = 20_000

/**
 * A prompt body: not empty once trimmed, not so long the diff refuses it, not so
 * long the model call after it does, and never carrying the adapter's own data-fence
 * markers.
 *
 * The line-count and emptiness checks exist because the alternative is a 500:
 * `createPromptVersion` throws on an empty body and `diffLines` throws above
 * `MAX_LINES`, and a form that pasted the wrong thing deserves to be told which.
 *
 * The two added here are about what leaves the machine rather than what breaks the
 * diff. `PROMPT_BODY_MAX_CHARS` bounds the one editable free-text field this
 * application sends to a model in full, unredacted, on every narrative run — every
 * other free-text field crossing the AI boundary (`purpose`, a category name, the
 * month note) is capped in `redact.ts`, and this was the one left uncapped. The fence
 * check is the more pointed of the two: `DATA_OPEN`/`DATA_CLOSE` are what `fenceData`
 * (`src/adapters/ai/prompt.ts`) wraps around the untrusted payload so the model can
 * tell data from instructions, and a prompt body that already contains one of those
 * markers could close that fence early and have the rest of the payload read as
 * instructions — the exact failure `fenceData` itself refuses to send. Refusing it
 * at save time means an owner is told immediately, in the editor, rather than having
 * every subsequent run of that prompt quietly refuse at call time instead.
 */
const promptBodyRequest = z
  .string()
  .refine((body) => body.trim().length > 0, { message: 'the prompt cannot be empty' })
  .refine((body) => body.length <= PROMPT_BODY_MAX_CHARS, {
    message: `a prompt cannot be longer than ${String(PROMPT_BODY_MAX_CHARS)} characters`,
  })
  .refine((body) => body.split('\n').length <= MAX_LINES, {
    message: `a prompt of more than ${String(MAX_LINES)} lines cannot be diffed`,
  })
  .refine((body) => !body.includes(DATA_OPEN) && !body.includes(DATA_CLOSE), {
    message: "a prompt cannot contain Balancr's own data-fence markers",
  })

const promptCreateRequest = z.strictObject({
  key: z.enum(PROMPT_KEYS),
  locale: promptLocaleRequest,
  body: promptBodyRequest,
  /** A short label for the version, distinct from `note`'s longer "why". */
  name: z.string().max(80).optional(),
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
 * An Actual/Ghostfolio host, on both the PATCH and the "test connection" requests.
 *
 * Self-hosted Actual/Ghostfolio routinely sit behind plain `http:` on a LAN or a
 * Docker network, which is exactly what `ACTUAL_SERVER_URL`/`GHOSTFOLIO_URL`
 * already assume, so this does not add a scheme check — `http:` is accepted on
 * both requests alike. What it does add, on both: the body has to parse as an
 * absolute URL — `withScopedHost` and `sameHost` below both call `new URL` on it,
 * and a string that fails that is not a host either of them can reason about — and
 * it must not carry embedded credentials, which `serverUrl`/`url` has never been a
 * place to put them. A malformed value failing here, rather than reaching
 * `sameHost`, matters for the PATCH request specifically: `sameHost` returns
 * `false` on a parse failure, and a PATCH whose "host changed" check fires on a
 * value that was never a host at all would erase the tenant's stored secret over
 * a typo, not a host change (#535).
 */
const integrationUrl = z
  .string()
  .min(1)
  .transform((raw, ctx) => {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a valid URL' })
      return z.NEVER
    }
    if (url.username !== '' || url.password !== '') {
      ctx.addIssue({ code: 'custom', message: 'must not contain credentials' })
      return z.NEVER
    }
    return url.href.replace(/\/+$/, '')
  })

/**
 * The Actual connection (#369). `password`/`e2ePassword` are secrets and never sent
 * back to the client, so omitting either key means "leave the stored value
 * unchanged" — there is nothing on the wire for a save that only touched `serverUrl`
 * to echo back. An empty string is never valid: a blank password is not a state this
 * form can express, the same rule a required `.env` var follows.
 */
const actualIntegrationPatchRequest = z.strictObject({
  serverUrl: integrationUrl,
  syncId: z.string().min(1),
  password: z.string().min(1).optional(),
  e2ePassword: z.string().min(1).optional(),
  /** The language the household typed its Actual categories in (#479). Never a secret. */
  categorySourceLocale: localeRequest,
})

/** The Ghostfolio connection (#369). See `actualIntegrationPatchRequest` for why `securityToken` is optional. */
const ghostfolioIntegrationPatchRequest = z.strictObject({
  url: integrationUrl,
  securityToken: z.string().min(1).optional(),
})

/**
 * Whether a euro amount's `eurToMicroEur` conversion is representable by
 * `microEur()` — the same schema the settings *response* validates against.
 * Checking this at the wire means the request and response schemas can never
 * disagree, unlike a plain `.max()` picked separately on each side (#578/C1): a
 * `budgetEur` or `modelPrices` entry large enough to overflow `microEur()`'s
 * safe-integer requirement on the way out is refused here, on the way in, instead
 * of getting stored and then bricking every later settings read.
 */
const fitsMicroEur = (eur: number): boolean => microEur().safeParse(eurToMicroEur(eur)).success

const euroAmount = (): z.ZodType<number> =>
  z.number().nonnegative().refine(fitsMicroEur, { message: 'value is too large to store as micro-euros' })

/**
 * The AI connection (#369, #422). `googleCloudProject` is not a secret, so unlike
 * `apiKey` it is not optional — it is replaced wholesale like every other plain field
 * on this page, and `null` is how a switch to AI Studio clears it.
 *
 * `modelFast`/`modelDeep`/`budgetEur` moved from `.env` to here (#371): a model
 * choice and a monthly cap are exactly as per-tenant as the credential they run
 * against, and unlike the credential neither is a secret — they round-trip as
 * plain fields, the same as `googleCloudProject`.
 */
const aiIntegrationPatchRequest = z.strictObject({
  provider: z.enum(AI_PROVIDERS),
  apiKey: z.string().min(1).optional(),
  clearApiKey: z.boolean().optional(),
  googleCloudProject: z.string().min(1).nullable(),
  baseUrl: z.string().min(1).nullable().default(null),
  modelFast: z.string().min(1),
  modelDeep: z.string().min(1),
  modelPrices: z.record(z.string().min(1), z.strictObject({
    inputEur: euroAmount(),
    cachedInputEur: euroAmount(),
    cacheWriteInputEur: euroAmount(),
    outputEur: euroAmount(),
  })).default({}),
  budgetEur: z.coerce.number().nonnegative().refine(fitsMicroEur, { message: 'value is too large to store as micro-euros' }),
}).refine((value) => !(value.clearApiKey === true && value.apiKey !== undefined), {
  message: 'apiKey and clearApiKey cannot be used together',
})

/**
 * Whether two URLs share a scheme and host — the check that gates the stored-secret
 * fallback below.
 *
 * Origin, not just host: a stored secret was verified over whichever scheme the
 * stored URL used, and a candidate that keeps the hostname but drops from `https:`
 * to `http:` is still a host nobody verified that secret against — the same
 * downgrade a browser's mixed-content warning exists for.
 */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/**
 * `sameHost` for the AI connection's `baseUrl`, which — unlike Actual's/
 * Ghostfolio's URL fields — is `null` for every provider except
 * `openai-compatible` (#579/S1). `null` on both sides means neither side has a
 * custom host to compare, which is still "the same host" for invalidation
 * purposes; `null` on only one side is itself a host change (a switch into or
 * out of a custom endpoint).
 */
function sameAiHost(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  return sameHost(a, b)
}

/**
 * A "test connection" body carries the *full* candidate credential, never a partial
 * patch — nothing is saved by a test, so there is no stored value to merge against.
 *
 * A secret key is optional here for the same reason it's optional on the PATCH
 * request: a secret field is always blank on load, so a test of an
 * already-configured integration can only omit it. The handler below falls back
 * to the tenant's own stored secret when it's omitted, one exists, *and* the
 * candidate host matches the host that secret was stored for (#382, #534) —
 * never the other way around, and never across hosts, so a test never sends a
 * stored secret for a candidate it did not ask to test.
 */
const actualIntegrationTestRequest = z.strictObject({
  serverUrl: integrationUrl,
  syncId: z.string().min(1),
  password: z.string().min(1).optional(),
  e2ePassword: z.string().min(1).optional(),
})

/** See `actualIntegrationTestRequest`. */
const ghostfolioIntegrationTestRequest = z.strictObject({
  url: integrationUrl,
  securityToken: z.string().min(1).optional(),
})

/** See `actualIntegrationTestRequest`. `googleCloudLocation` defaults to the deployment's own when omitted. */
const aiIntegrationTestRequest = z.strictObject({
  provider: z.enum(AI_PROVIDERS),
  apiKey: z.string().min(1).optional(),
  googleCloudProject: z.string().min(1).optional(),
  googleCloudLocation: z.string().min(1).optional(),
  baseUrl: z.string().min(1).nullable().default(null),
  model: z.string().min(1).optional(),
})

function tenantModelPrices(
  prices: Record<string, { inputEur: number; cachedInputEur: number; cacheWriteInputEur: number; outputEur: number }>,
): ModelPrices {
  const verified = new Date().toISOString().slice(0, 10)
  return Object.fromEntries(Object.entries(prices).map(([model, price]): [string, ModelPrice] => [
    model.trim().toLowerCase(),
    {
      input: eurToMicroEur(price.inputEur),
      cachedInput: eurToMicroEur(price.cachedInputEur),
      cacheWriteInput: eurToMicroEur(price.cacheWriteInputEur),
      output: eurToMicroEur(price.outputEur),
      verified,
    },
  ]))
}

function validatedAiBaseUrl(provider: AiProvider, candidate: string | null): string | null {
  if (provider === 'openai' || provider === 'xai' || provider === 'anthropic') {
    if (candidate !== null) throw badRequest('Official provider base URLs cannot be changed.')
    return null
  }
  if (provider === 'openai-compatible') {
    if (candidate === null) throw badRequest('A base URL is required for a custom OpenAI-compatible endpoint.')
    try {
      return validateCustomBaseUrl(candidate)
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : String(error))
    }
  }
  if (candidate !== null) throw badRequest('A base URL is not used by the selected provider.')
  return null
}

const capabilityProbe = (model: string) => ({
  model,
  systemPrompt: 'The API response format is authoritative even when the user asks for plain text.',
  instruction: 'Reply with the plain-text word unsupported and do not return JSON.',
  payload: { capability: 'structured_output' },
  responseJsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { balancr_probe: { enum: [true], type: 'boolean' } },
    required: ['balancr_probe'],
  },
  maxOutputTokens: 20,
})

function validCapabilityProbe(text: string): boolean {
  const parsed: unknown = JSON.parse(text)
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.keys(parsed).length === 1 &&
    (parsed as Record<string, unknown>)['balancr_probe'] === true
  )
}

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
  const versions = listPromptVersions(db, tenantId, key, locale)
  // Read off the raw row set, not off `active`: for a language with no override of its
  // own, `resolvePrompt` answers with the *shared* row, which this locale's own version
  // list does not contain — so `active.id` can differ from anything in `versions` even
  // though neither is locked or pinned (#468). `storedBody` is what this locale actually
  // has on file, independent of which row inheritance resolves to.
  const storedActive = versions.find((row) => row.active) ?? null
  // Fetched by id rather than found in `versions`, because the two are not the same set:
  // for a language with no override of its own, `resolvePrompt` answers with the *shared*
  // row, which this locale's version list does not contain. The verdict columns live on
  // that row, so looking in the wrong list would badge a cleared shared prompt as
  // unchecked under every language that inherits it.
  const activeRow = active.id === null ? null : loadPrompt(db, tenantId, active.id)
  const activeGate =
    activeRow === null
      ? // No row means the built-in constant. Asked through the same function rather than
        // hard-coded to `built_in`, so the fallback and a stored copy of the same text can
        // never end up badged differently.
        promptGateState(key, {
          body: active.body,
          validationVerdict: null,
          validationRulesVersion: null,
        })
      : promptGateState(key, activeRow)

  return promptSchema.parse({
    key,
    locale,
    base: DEFAULT_PROMPTS[key],
    active: {
      id: active.id,
      version: active.version,
      locale: active.locale,
      body: active.body,
      gate: activeGate,
      validatedAt: activeRow?.validatedAt?.toISOString() ?? null,
      rulesVersion: activeRow?.validationRulesVersion ?? null,
    },
    storedBody: storedActive?.body ?? null,
    versions: versions.map((row) => ({
      id: row.id,
      version: row.version,
      active: row.active,
      name: row.name,
      note: row.note,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      chars: row.body.length,
      gate: promptGateState(key, row),
      validatedAt: row.validatedAt?.toISOString() ?? null,
      rulesVersion: row.validationRulesVersion,
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
      categorySourceLocale: row.actualCategorySourceLocale,
    },
    ghostfolio: {
      url: row.ghostfolioUrl,
      tokenConfigured: row.ghostfolioSecurityTokenEnc.length > 0,
    },
    ai: {
      provider: row.aiProvider,
      apiKeyConfigured: row.aiApiKeyEnc !== null,
      googleCloudProject: row.googleCloudProject,
      baseUrl:
        row.aiProvider === 'openai'
          ? OPENAI_BASE_URL
          : row.aiProvider === 'xai'
            ? XAI_BASE_URL
            : row.aiProvider === 'anthropic'
              ? ANTHROPIC_BASE_URL
            : row.aiBaseUrl,
      modelFast: row.aiModelFast,
      modelDeep: row.aiModelDeep,
      modelPrices: Object.fromEntries(
        Object.entries(JSON.parse(row.aiModelPricesJson) as Record<string, ModelPrice>).map(([model, price]) => [
          model,
          {
            inputEurMicro: price.input,
            cachedInputEurMicro: price.cachedInput,
            cacheWriteInputEurMicro: price.cacheWriteInput,
            outputEurMicro: price.output,
          },
        ]),
      ),
      budgetEurMicro: row.aiMonthlyBudgetEurMicro,
    },
  })
}

/**
 * The digest preference (#52), plus whether a PDF from a past run is stored and
 * ready to download.
 *
 * `loadDigestPdf` is called only to check existence — its bytes are never put on
 * this wire; they travel solely through `GET /api/settings/digest/pdf`'s binary
 * response.
 *
 * `recipientEmails` is owner-only (#573): every other secret-shaped field on this
 * page masks to a `*Configured: boolean` for a viewer, and a recipient list is the
 * one place a plain value would otherwise round-trip to a role that cannot act on
 * it and did not choose to be in it. `recipientCount` carries the same information
 * a viewer is allowed to see either way, so the panel can still say "3 recipients"
 * rather than looking empty.
 */
function digestSetting(db: Db, tenantId: string, isOwner: boolean): Settings['digest'] {
  const preference = loadDigestPreference(db, tenantId)
  return {
    mode: preference.mode,
    recipientEmails: isOwner ? preference.recipientEmails : [],
    recipientCount: preference.recipientEmails.length,
    locale: preference.locale ?? null,
    hasPdf: loadDigestPdf(db, tenantId) !== null,
  }
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
    loans: listLoans(db, user.tenantId),
    debts: listDebts(db, user.tenantId),
    goals: listGoals(db, user.tenantId),
    integrations: loadIntegrations(db, user.tenantId),
    categoryTranslations: loadCategoryTranslationRows(db, user.tenantId),
    invites: listInvites(db, user.tenantId).map(toInviteSetting),
    // The shared text first, then only those languages someone has actually written
    // an override for. Listing every supported locale unconditionally is what made
    // the divergence look mandatory: four entries carrying two texts, and no way to
    // tell an override from a copy of the seed.
    //
    // A switched-off override keeps its entry, because its versions still exist and
    // reactivating one is the rollback gesture. `active.locale` is what distinguishes
    // the two states, and it is already on the wire.
    // Deployment-wide and read straight from `.env` (#454): there is nothing on this page
    // that can change it, which is exactly what makes it the one control an owner who is
    // also the operator is still bound by.
    promptEditing: config.PROMPT_EDITING,
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
      history: loadSpendHistory(db, user.tenantId),
    },
    digest: digestSetting(db, user.tenantId, user.role === 'owner'),
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

/** The sentence each gate state deserves. Named states, because the fix differs. */
const GATE_REFUSAL: Readonly<Record<string, string>> = {
  unvalidated:
    'This version of the instructions has not passed a safety check yet, so it cannot be ' +
    'made active. Run the check on it first.',
  unsafe:
    'A safety check found that this version of the instructions no longer imposes the ' +
    'rules the pass depends on, so it cannot be made active. Edit the text and save it ' +
    'as a new version.',
}

/**
 * `PromptGateError` → a `409`, with the gate state named.
 *
 * `409` rather than `403`: nothing here is about permission, and the state *is* fixable —
 * press the check, or rewrite the text — which is what `409` means. The wrapper exists
 * because the throw happens inside `createPromptVersion`/`activatePrompt`'s transactions,
 * two call sites deep, and the alternative is the error handler turning a deliberate
 * refusal into a `500`.
 *
 * The message names the state rather than quoting the judge: the judge's own words are
 * model output shaped by the text being judged, and this response is read by a person who
 * has just pressed a button. The per-rule detail is on the validate endpoint's own answer.
 */
function promptGateGuard<T>(write: () => T): T {
  try {
    return write()
  } catch (error) {
    if (!(error instanceof PromptGateError)) throw error
    throw conflict(
      GATE_REFUSAL[error.state] ??
        `These instructions cannot be made active: their safety state is ${error.state}.`,
    )
  }
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

/** One page of the AI log (#502) — small enough that "load more" feels immediate. */
const AI_LOG_PAGE_SIZE = 50

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
      tenantId: user.tenantId,
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
      tenantId: user.tenantId,
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
      tenantId: user.tenantId,
      action: 'settings.household',
      entity: 'settings',
      entityRef: HOUSEHOLD_KEY,
      actorId: user.id,
      // Shape, not values (#582/P2) — a member's birth year and label are PII of
      // someone who never chose to be tracked, same reasoning as `settings.integrations`
      // (`audit.ts`) never carrying a credential. The trail's question — "was this a
      // bigger or smaller household, and which country's benchmark did it compare
      // against" — is answered by a count either way.
      before: { country: before.country, memberCount: before.members.length },
      after: { country: after.country, memberCount: after.members.length },
    })

    return buildSettings(db, request)
  })

  /**
   * Whether, and how, this tenant wants the monthly digest (#52).
   *
   * Takes effect on the digest's next scheduled run, not immediately — unlike the
   * roster and the risk profile above, there is nothing here to recompute for the
   * current page. `saveDigestPreference` replaces the row wholesale, so a patch
   * without `recipientEmails` or `locale` lands the schema's own defaults, same as
   * `saveHousehold`.
   */
  app.patch('/api/settings/digest', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const patch = parseBody(digestPatchRequest, request.body)

    const before = loadDigestPreference(db, user.tenantId)
    let after
    try {
      after = saveDigestPreference(db, user.tenantId, patch)
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw invalidBody('The request body was not valid.', fieldIssues(error))
      }
      throw error
    }

    // The stored PDF is a "pdf" mode artifact, not an archive independent of the
    // current preference (#572) — once the household stops asking for it, the last
    // one generated should stop being downloadable too.
    if (before.mode === 'pdf' && after.mode !== 'pdf') deleteDigestPdf(db, user.tenantId)

    recordAudit(db, {
      tenantId: user.tenantId,
      action: 'settings.digest',
      entity: 'settings',
      entityRef: DIGEST_KEY,
      actorId: user.id,
      // Shape, not values (#582/P2) — a recipient address belongs to someone who,
      // per #573/#574, cannot act on it and did not choose to be in it. `mode` and a
      // count answer the trail's question ("who turned the digest on/off, and to how
      // many people") without becoming a second place an address could leak from.
      before: { mode: before.mode, recipientCount: before.recipientEmails.length },
      after: { mode: after.mode, recipientCount: after.recipientEmails.length },
    })

    return buildSettings(db, request)
  })

  /**
   * The latest generated digest PDF, for `pdf` mode's "download" link.
   *
   * Owner-only, like every other settings read/write on this page — the digest
   * covers the whole household's finances, not just the requester's own view of
   * them.
   */
  app.get('/api/settings/digest/pdf', (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireOwner(request)
    const stored = loadDigestPdf(db, user.tenantId)
    if (stored === null) throw notFound('No digest has been generated yet.')

    reply.header('Content-Disposition', `attachment; filename="balancr-digest-${stored.period}.pdf"`)
    reply.type('application/pdf')
    return stored.pdfBytes
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
      tenantId: user.tenantId,
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
      tenantId: user.tenantId,
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
   * A new fixed-schedule loan — car, personal (#441).
   *
   * Three routes rather than one whole-list PATCH, because a loan is a row with its own
   * id (see `loanRequest`). Each still answers with the whole settings payload, like
   * every other write on this page: the list the panel redraws and the loan it just
   * touched come back together, with nothing for the screen to reconcile.
   *
   * Takes effect immediately — the balance is amortized from this row on every read of
   * the overview or portfolio page, with no recompute step in between.
   */
  app.post('/api/settings/loans', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const body = parseBody(loanRequest, request.body)

    let created
    try {
      created = createLoan(db, user.tenantId, body)
    } catch (error) {
      // The rate/term bounds can only be checked once parsed, so they fail here rather
      // than in `parseBody` — same division as the property list above.
      if (error instanceof z.ZodError) {
        throw invalidBody('The request body was not valid.', fieldIssues(error))
      }
      // Not a fact about the body: the same request would have been accepted one loan
      // ago, which is what a 409 says and a 400 would not.
      if (error instanceof TooManyLoansError) {
        throw conflict(`A household may track at most ${String(MAX_LOANS)} loans.`)
      }
      throw error
    }

    recordAudit(db, {
      tenantId: user.tenantId,
      action: 'settings.loan',
      entity: 'loans',
      entityRef: created.id,
      actorId: user.id,
      // Null before, the loan after: the entry reads as "this came into being".
      before: null,
      after: { ...created },
    })

    return buildSettings(db, request)
  })

  /**
   * Replaces one loan — a correction, or the re-anchor a new statement calls for.
   *
   * There is no rate-history table here any more than there is for a mortgage: when the
   * rate, payment or remaining term changes, the owner sends today's real outstanding
   * balance as the new `principalCents`/`anchorDate`. The audit entry is what remembers
   * what it said before.
   */
  app.patch('/api/settings/loans/:id', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const id = (request.params as { id: string }).id
    const body = parseBody(loanRequest, request.body)

    // Read first, so a loan belonging to another tenant is a 404 rather than an update
    // that silently matches nothing and answers 200.
    const before = loadLoan(db, user.tenantId, id)
    if (before === null) throw notFound('No such loan.')

    let after
    try {
      after = updateLoan(db, user.tenantId, id, body)
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw invalidBody('The request body was not valid.', fieldIssues(error))
      }
      throw error
    }
    if (after === null) throw notFound('No such loan.')

    recordAudit(db, {
      tenantId: user.tenantId,
      action: 'settings.loan',
      entity: 'loans',
      entityRef: id,
      actorId: user.id,
      before: { ...before },
      after: { ...after },
    })

    return buildSettings(db, request)
  })

  /**
   * Drops a loan — paid off, refinanced, or entered by mistake.
   *
   * The only DELETE on this page, and it is one because a loan is a row: "remove this
   * one" cannot be expressed as a patch of a list that no longer contains it. `before`
   * carries the whole loan, since after this the row is the only place it existed.
   */
  app.delete('/api/settings/loans/:id', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const id = (request.params as { id: string }).id

    const before = loadLoan(db, user.tenantId, id)
    if (before === null) throw notFound('No such loan.')
    deleteLoan(db, user.tenantId, id)

    recordAudit(db, {
      tenantId: user.tenantId,
      action: 'settings.loan',
      entity: 'loans',
      entityRef: id,
      actorId: user.id,
      before: { ...before },
      // Null rather than the row: what was recorded is that this loan stopped existing.
      after: null,
    })

    return buildSettings(db, request)
  })

  /**
   * A new revolving debt — a credit card, a store card (#442).
   *
   * Three routes rather than one whole-list PATCH, same reasoning as the loan routes
   * above: a revolving debt is a row with its own id. Takes effect immediately — there
   * is no recompute step between this write and the next read of the overview or
   * portfolio page.
   */
  app.post('/api/settings/debts', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const body = parseBody(debtRequest, request.body)

    let created
    try {
      created = createDebt(db, user.tenantId, body)
    } catch (error) {
      // The balance/APR bounds can only be checked once parsed, so they fail here
      // rather than in `parseBody` — same division as the loan routes above.
      if (error instanceof z.ZodError) {
        throw invalidBody('The request body was not valid.', fieldIssues(error))
      }
      // Not a fact about the body: the same request would have been accepted one debt
      // ago, which is what a 409 says and a 400 would not.
      if (error instanceof TooManyDebtsError) {
        throw conflict(`A household may track at most ${String(MAX_DEBTS)} revolving debts.`)
      }
      throw error
    }

    recordAudit(db, {
      tenantId: user.tenantId,
      action: 'settings.debt',
      entity: 'revolving_debts',
      entityRef: created.id,
      actorId: user.id,
      // Null before, the debt after: the entry reads as "this came into being".
      before: null,
      after: { ...created },
    })

    return buildSettings(db, request)
  })

  /**
   * Replaces one revolving debt — a fresh statement, a corrected balance.
   *
   * There is no history table here any more than there is for a loan: the owner sends
   * today's real balance as the new `balanceCents`, and the audit entry is what
   * remembers what it said before.
   */
  app.patch('/api/settings/debts/:id', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const id = (request.params as { id: string }).id
    const body = parseBody(debtRequest, request.body)

    // Read first, so a debt belonging to another tenant is a 404 rather than an update
    // that silently matches nothing and answers 200.
    const before = loadDebt(db, user.tenantId, id)
    if (before === null) throw notFound('No such debt.')

    let after
    try {
      after = updateDebt(db, user.tenantId, id, body)
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw invalidBody('The request body was not valid.', fieldIssues(error))
      }
      throw error
    }
    if (after === null) throw notFound('No such debt.')

    recordAudit(db, {
      tenantId: user.tenantId,
      action: 'settings.debt',
      entity: 'revolving_debts',
      entityRef: id,
      actorId: user.id,
      before: { ...before },
      after: { ...after },
    })

    return buildSettings(db, request)
  })

  /**
   * Drops a revolving debt — paid off, closed, or entered by mistake.
   *
   * The only DELETE this panel needs, and it is one because a debt is a row: "remove
   * this one" cannot be expressed as a patch of a list that no longer contains it.
   * `before` carries the whole debt, since after this the row is the only place it
   * existed.
   */
  app.delete('/api/settings/debts/:id', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const id = (request.params as { id: string }).id

    const before = loadDebt(db, user.tenantId, id)
    if (before === null) throw notFound('No such debt.')
    deleteDebt(db, user.tenantId, id)

    recordAudit(db, {
      tenantId: user.tenantId,
      action: 'settings.debt',
      entity: 'revolving_debts',
      entityRef: id,
      actorId: user.id,
      before: { ...before },
      // Null rather than the row: what was recorded is that this debt stopped existing.
      after: null,
    })

    return buildSettings(db, request)
  })

  /**
   * A new savings goal (#407) — a target amount and, optionally, a target date.
   *
   * Three routes rather than one whole-list PATCH, same reasoning as loans/debts
   * above: a goal is a row with its own id. There is no `currentCents` to
   * amortize here — progress is read fresh off net worth on every request, so
   * unlike a loan or a debt this write changes nothing about the number itself,
   * only which target it is measured against.
   */
  app.post('/api/settings/goals', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const body = parseBody(goalRequest, request.body)

    let created
    try {
      created = createGoal(db, user.tenantId, body)
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw invalidBody('The request body was not valid.', fieldIssues(error))
      }
      // Not a fact about the body: the same request would have been accepted one
      // goal ago, which is what a 409 says and a 400 would not.
      if (error instanceof TooManyGoalsError) {
        throw conflict(`A household may track at most ${String(MAX_GOALS)} goals.`)
      }
      if (error instanceof UnknownCategoryError) {
        throw invalidBody(error.message, [{ path: 'categoryId', message: error.message }])
      }
      throw error
    }

    recordAudit(db, {
      tenantId: user.tenantId,
      action: 'settings.goal',
      entity: 'goals',
      entityRef: created.id,
      actorId: user.id,
      // Null before, the goal after: the entry reads as "this came into being".
      before: null,
      after: { ...created },
    })

    return buildSettings(db, request)
  })

  /** Replaces one goal — a raised target, a moved date, a re-prioritized row. */
  app.patch('/api/settings/goals/:id', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const id = (request.params as { id: string }).id
    const body = parseBody(goalRequest, request.body)

    // Read first, so a goal belonging to another tenant is a 404 rather than an
    // update that silently matches nothing and answers 200.
    const before = loadGoal(db, user.tenantId, id)
    if (before === null) throw notFound('No such goal.')

    let after
    try {
      after = updateGoal(db, user.tenantId, id, body)
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw invalidBody('The request body was not valid.', fieldIssues(error))
      }
      if (error instanceof UnknownCategoryError) {
        throw invalidBody(error.message, [{ path: 'categoryId', message: error.message }])
      }
      throw error
    }
    if (after === null) throw notFound('No such goal.')

    recordAudit(db, {
      tenantId: user.tenantId,
      action: 'settings.goal',
      entity: 'goals',
      entityRef: id,
      actorId: user.id,
      before: { ...before },
      after: { ...after },
    })

    return buildSettings(db, request)
  })

  /**
   * Drops a goal — reached, abandoned, or entered by mistake.
   *
   * The only DELETE this panel needs, same reasoning as loans/debts: "remove this
   * one" cannot be expressed as a patch of a list that no longer contains it.
   */
  app.delete('/api/settings/goals/:id', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const id = (request.params as { id: string }).id

    const before = loadGoal(db, user.tenantId, id)
    if (before === null) throw notFound('No such goal.')
    deleteGoal(db, user.tenantId, id)

    recordAudit(db, {
      tenantId: user.tenantId,
      action: 'settings.goal',
      entity: 'goals',
      entityRef: id,
      actorId: user.id,
      before: { ...before },
      // Null rather than the row: what was recorded is that this goal stopped existing.
      after: null,
    })

    return buildSettings(db, request)
  })

  /**
   * Ticks a goal done — its own route, not a `PATCH`, because `updateGoal` is a
   * whole-row replace and this is a manual, immediate action like `DELETE`, the
   * same reasoning `markGoalDone`'s own doc comment gives.
   */
  app.post('/api/settings/goals/:id/done', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const id = (request.params as { id: string }).id

    const before = loadGoal(db, user.tenantId, id)
    if (before === null) throw notFound('No such goal.')
    const after = markGoalDone(db, user.tenantId, id)
    if (after === null) throw notFound('No such goal.')

    recordAudit(db, {
      tenantId: user.tenantId,
      action: 'settings.goal',
      entity: 'goals',
      entityRef: id,
      actorId: user.id,
      before: { ...before },
      after: { ...after },
    })

    return buildSettings(db, request)
  })

  /**
   * Undoes a `done` tick, at any time — not only within the grace window that
   * governs whether an already-done goal still shows on Overview/Budget.
   */
  app.post('/api/settings/goals/:id/reactivate', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const id = (request.params as { id: string }).id

    const before = loadGoal(db, user.tenantId, id)
    if (before === null) throw notFound('No such goal.')

    let after
    try {
      after = reactivateGoal(db, user.tenantId, id)
    } catch (error) {
      // Same reasoning as the create route's TooManyGoalsError mapping: reactivating
      // a done goal is subject to the same MAX_GOALS cap createGoal enforces.
      if (error instanceof TooManyGoalsError) {
        throw conflict(`A household may track at most ${String(MAX_GOALS)} goals.`)
      }
      throw error
    }
    if (after === null) throw notFound('No such goal.')

    recordAudit(db, {
      tenantId: user.tenantId,
      action: 'settings.goal',
      entity: 'goals',
      entityRef: id,
      actorId: user.id,
      before: { ...before },
      after: { ...after },
    })

    return buildSettings(db, request)
  })

  /**
   * The Actual connection this tenant syncs from (#369).
   *
   * `password`/`e2ePassword` are the "omit means unchanged" case — see
   * `actualIntegrationPatchRequest`. `updatedAt` is set explicitly because the
   * column's default only fires on insert, never on update.
   *
   * A `serverUrl` whose host actually changes invalidates whichever of those two
   * was left unchanged (#534, #535): they were only ever verified against the old
   * host, and carrying them forward to a host nobody typed them for is the same
   * shape of trust mistake the "test connection" fallback made — the owner has to
   * retype the secret for the new host, the same way a first-ever save does.
   */
  app.patch('/api/settings/integrations/actual', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const patch = parseBody(actualIntegrationPatchRequest, request.body)
    const tenantId = user.tenantId
    const before = loadIntegrations(db, tenantId)
    const hostChanged = !sameHost(patch.serverUrl, before.actual.serverUrl)

    db.update(tenantIntegrations)
      .set({
        actualServerUrl: patch.serverUrl,
        actualSyncId: patch.syncId,
        actualCategorySourceLocale: patch.categorySourceLocale,
        ...(patch.password !== undefined
          ? { actualPasswordEnc: encryptField(patch.password) }
          : hostChanged
            ? { actualPasswordEnc: '' }
            : {}),
        ...(patch.e2ePassword !== undefined
          ? { actualE2ePasswordEnc: encryptField(patch.e2ePassword) }
          : hostChanged
            ? { actualE2ePasswordEnc: null }
            : {}),
        updatedAt: new Date(),
      })
      .where(eq(tenantIntegrations.tenantId, tenantId))
      .run()

    // The new source locale's name is the Actual snapshot from here on — any translation
    // rows already on file for it would otherwise keep outranking that snapshot forever,
    // with no way to clear them (`saveCategoryTranslation` rejects writes for the source
    // locale outright).
    if (patch.categorySourceLocale !== before.actual.categorySourceLocale) {
      clearTranslationsForLocale(db, tenantId, patch.categorySourceLocale)
    }

    const after = loadIntegrations(db, tenantId)
    recordAudit(db, {
      tenantId: user.tenantId,
      action: 'settings.integrations',
      entity: 'tenant_integrations',
      entityRef: tenantId,
      actorId: user.id,
      before: before.actual,
      after: after.actual,
    })

    return buildSettings(db, request)
  })

  /**
   * The Ghostfolio connection this tenant reads from (#369). See the Actual route
   * above for why a host change invalidates a token left unchanged (#535).
   */
  app.patch('/api/settings/integrations/ghostfolio', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const patch = parseBody(ghostfolioIntegrationPatchRequest, request.body)
    const tenantId = user.tenantId
    const before = loadIntegrations(db, tenantId)
    const hostChanged = !sameHost(patch.url, before.ghostfolio.url)

    db.update(tenantIntegrations)
      .set({
        ghostfolioUrl: patch.url,
        ...(patch.securityToken !== undefined
          ? { ghostfolioSecurityTokenEnc: encryptField(patch.securityToken) }
          : hostChanged
            ? { ghostfolioSecurityTokenEnc: '' }
            : {}),
        updatedAt: new Date(),
      })
      .where(eq(tenantIntegrations.tenantId, tenantId))
      .run()

    // The DB update above already erases a token stored for the old host; this does
    // the same for the copy `adapters/ghostfolio/client.ts` caches in memory; a JWT
    // minted against the old host is credential to that host, not to this tenant,
    // and must not outlive it either (#535).
    if (hostChanged) resetGhostfolioToken(tenantId)

    const after = loadIntegrations(db, tenantId)
    recordAudit(db, {
      tenantId: user.tenantId,
      action: 'settings.integrations',
      entity: 'tenant_integrations',
      entityRef: tenantId,
      actorId: user.id,
      before: before.ghostfolio,
      after: after.ghostfolio,
    })

    return buildSettings(db, request)
  })

  /** The selected AI connection this tenant's AI pass uses (#369, #422). */
  app.patch('/api/settings/integrations/ai', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const patch = parseBody(aiIntegrationPatchRequest, request.body)
    const tenantId = user.tenantId
    const before = loadIntegrations(db, tenantId)
    const row = integrationsRow(db, tenantId)
    const baseUrl = validatedAiBaseUrl(patch.provider, patch.baseUrl)
    const modelPrices = tenantModelPrices(patch.modelPrices)
    for (const model of new Set([patch.modelFast.trim(), patch.modelDeep.trim()])) {
      if (!priceFor(patch.provider, model, modelPrices).known) {
        throw badRequest(`An explicit price is required for unknown model ${model}.`)
      }
    }
    const providerChanged = row.aiProvider !== patch.provider
    // A custom `openai-compatible` endpoint can change host while the provider stays
    // the same; that's exactly the case #535 already invalidates a secret for on the
    // Actual/Ghostfolio routes, so the AI key must not survive it either (#579/S1).
    const hostChanged = providerChanged || !sameAiHost(baseUrl, row.aiBaseUrl)
    const apiKeyEnc =
      patch.apiKey !== undefined
        ? encryptField(patch.apiKey)
        : patch.clearApiKey === true || hostChanged
          ? null
          : row.aiApiKeyEnc

    db.update(tenantIntegrations)
      .set({
        aiProvider: patch.provider,
        googleCloudProject: patch.googleCloudProject,
        aiBaseUrl: baseUrl,
        aiApiKeyEnc: apiKeyEnc,
        aiModelFast: patch.modelFast,
        aiModelDeep: patch.modelDeep,
        aiModelPricesJson: JSON.stringify(modelPrices),
        aiMonthlyBudgetEurMicro: eurToMicroEur(patch.budgetEur),
        updatedAt: new Date(),
      })
      .where(eq(tenantIntegrations.tenantId, tenantId))
      .run()
    resetAiClients()

    const after = loadIntegrations(db, tenantId)
    recordAudit(db, {
      tenantId: user.tenantId,
      action: 'settings.integrations',
      entity: 'tenant_integrations',
      entityRef: tenantId,
      actorId: user.id,
      before: before.ai,
      after: after.ai,
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

      const row = integrationsRow(db, user.tenantId)
      const storedTokenApplies = row.ghostfolioSecurityTokenEnc.length > 0 && sameHost(candidate.url, row.ghostfolioUrl)
      const securityToken =
        candidate.securityToken ?? (storedTokenApplies ? decryptField(row.ghostfolioSecurityTokenEnc) : undefined)
      if (securityToken === undefined) {
        throw badRequest('A security token is required to test this connection.')
      }

      const result = await withScopedHost(candidate.url, async (): Promise<IntegrationTest> => {
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
   * Whether a candidate native Gemini key/project actually works (#369, #422).
   *
   * `models.list()` is the cheapest call that proves the credential is live —
   * never `generateContent`, so testing a key spends no part of the tenant's own
   * budget. The client built here is a throwaway instance, never
   * `setGeminiClient`'s shared one, so a test in flight cannot affect a real call
   * running at the same time.
   */
  app.post(
    '/api/settings/integrations/ai/test',
    { ...integrationsTestRateLimit() },
    async (request: FastifyRequest): Promise<IntegrationTest> => {
      const user = requireOwner(request)
      const candidate = parseBody(aiIntegrationTestRequest, request.body)
      const location = candidate.googleCloudLocation ?? config.GOOGLE_CLOUD_LOCATION
      const storedRow = integrationsRow(db, user.tenantId)

      if (candidate.provider === 'anthropic') {
        if (candidate.model === undefined) throw badRequest('A model is required for the structured-output probe.')
        const model = candidate.model
        validatedAiBaseUrl(candidate.provider, candidate.baseUrl)
        const stored = storedRow.aiProvider === candidate.provider ? storedRow.aiApiKeyEnc : null
        const apiKey = candidate.apiKey ?? (stored === null ? undefined : decryptField(stored))
        if (apiKey === undefined) throw badRequest('An API key is required to test Anthropic.')

        const result = await withScopedHost(ANTHROPIC_BASE_URL, async (): Promise<IntegrationTest> => {
          try {
            const probe = await callAnthropicWithConfig({ apiKey }, capabilityProbe(model))
            return validCapabilityProbe(probe.text)
              ? { ok: true, message: null }
              : { ok: false, message: 'Anthropic ignored the required JSON schema.' }
          } catch (error) {
            return {
              ok: false,
              message: `Structured-output capability probe failed: ${error instanceof Error ? error.message : String(error)}`,
            }
          }
        })
        return integrationTestSchema.parse(result)
      }

      if (
        candidate.provider === 'openai' ||
        candidate.provider === 'xai' ||
        candidate.provider === 'openai-compatible'
      ) {
        if (candidate.model === undefined) throw badRequest('A model is required for the structured-output probe.')
        const model = candidate.model
        const baseUrl = validatedAiBaseUrl(candidate.provider, candidate.baseUrl)
        // A stored key is credential to the host it was verified against; a candidate
        // `openai-compatible` endpoint that changes host must not reuse it even when
        // the provider itself is unchanged (#579/S1).
        const stored =
          storedRow.aiProvider === candidate.provider && sameAiHost(baseUrl, storedRow.aiBaseUrl)
            ? storedRow.aiApiKeyEnc
            : null
        const apiKey = candidate.apiKey ?? (stored === null ? null : decryptField(stored))
        if ((candidate.provider === 'openai' || candidate.provider === 'xai') && apiKey === null) {
          throw badRequest('An API key is required to test this provider.')
        }
        const connection = {
          provider: candidate.provider,
          baseUrl: baseUrlFor(candidate.provider, baseUrl),
          apiKey,
        }
        const testUrl = candidate.provider === 'openai-compatible' ? '' : connection.baseUrl
        const result = await withScopedHost(testUrl, async (): Promise<IntegrationTest> => {
          try {
            const probe = await callOpenAiCompatibleWithConfig(connection, capabilityProbe(model))
            if (!validCapabilityProbe(probe.text)) {
              return { ok: false, message: 'The endpoint ignored the required strict JSON schema.' }
            }
            return { ok: true, message: null }
          } catch (error) {
            return {
              ok: false,
              message: `Structured-output capability probe failed: ${error instanceof Error ? error.message : String(error)}`,
            }
          }
        })
        return integrationTestSchema.parse(result)
      }

      let options: GoogleGenAIOptions
      let testUrl: string
      if (candidate.provider === 'gemini-vertex') {
        const project = candidate.googleCloudProject
        if (project === undefined) {
          throw badRequest('A Google Cloud project is required to test a Vertex connection.')
        }
        options = { vertexai: true, project, location }
        testUrl = `https://${location}-aiplatform.googleapis.com`
      } else {
        const stored = storedRow.aiProvider === candidate.provider ? storedRow.aiApiKeyEnc : null
        const apiKey = candidate.apiKey ?? (stored === null ? undefined : decryptField(stored))
        if (apiKey === undefined) {
          throw badRequest('An API key is required to test an AI Studio connection.')
        }
        options = { apiKey }
        testUrl = ''
      }

      const result = await withScopedHost(testUrl, async (): Promise<IntegrationTest> => {
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
      const storedSecretsApply = row.actualServerUrl.length > 0 && sameHost(candidate.serverUrl, row.actualServerUrl)
      const password =
        candidate.password ?? (storedSecretsApply && row.actualPasswordEnc.length > 0 ? decryptField(row.actualPasswordEnc) : undefined)
      if (password === undefined) throw badRequest('A password is required to test this connection.')
      const e2ePassword =
        candidate.e2ePassword ??
        (storedSecretsApply && row.actualE2ePasswordEnc !== null ? decryptField(row.actualE2ePasswordEnc) : undefined)

      const result = await withScopedHost(candidate.serverUrl, () =>
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
      tenantId: user.tenantId,
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
   * A category's name in one member's locale (#479).
   *
   * The only writer of `category_translations`. `saveCategoryTranslation` throws for a
   * category with no `category_meta` row (a 404, same as `coicop` above) and for the
   * tenant's configured source locale (a 400 — that locale's name is the snapshot
   * itself, not a translation). Audited against `category_translations` rather than
   * `category_meta`: this table, not that one, is what actually changes.
   */
  app.patch('/api/settings/categories/:id/translation/:locale', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const { id: categoryId, locale } = request.params as { id: string; locale: string }
    const { name } = parseBody(categoryTranslationPatchRequest, request.body)

    if (!config.SUPPORTED_LOCALES.includes(locale)) {
      throw badRequest(`Unsupported locale: ${locale}`)
    }

    const before = loadCategoryTranslationRows(db, user.tenantId).find(
      (row) => row.categoryId === categoryId,
    )
    if (before === undefined) throw notFound('No such category.')

    try {
      saveCategoryTranslation(db, user.tenantId, categoryId, locale, name)
    } catch (error) {
      // Only reachable if the row disappeared between the two statements — see the
      // coicop route above for why that race is a 404, not a 500.
      if (error instanceof TranslationError) throw notFound('No such category.')
      if (error instanceof SourceLocaleError) throw badRequest(error.message)
      throw error
    }

    recordAudit(db, {
      tenantId: user.tenantId,
      action: 'settings.category-translation',
      entity: 'category_translations',
      entityRef: `${categoryId}:${locale}`,
      actorId: user.id,
      before: { name: before.translations[locale] ?? null },
      after: { name },
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
      tenantId: user.tenantId,
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
      tenantId: user.tenantId,
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
      tenantId: user.tenantId,
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
      tenantId: user.tenantId,
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
      tenantId: user.tenantId,
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
      tenantId: user.tenantId,
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
        tenantId: user.tenantId,
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
        tenantId: user.tenantId,
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
      tenantId: user.tenantId,
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
      name: row.name,
      note: row.note,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      chars: row.body.length,
      gate:
        // `promptKeyOf` would 400 on a stored key this build does not read, and reading a
        // version back is not the place to refuse one. An unknown key is not gated, so its
        // body is reported as the built-in state it effectively has.
        asPromptKey(row.key) === null
          ? 'built_in'
          : promptGateState(promptKeyOf(row.key), row),
      validatedAt: row.validatedAt?.toISOString() ?? null,
      rulesVersion: row.validationRulesVersion,
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
      // Priced on the same free request that already has the candidate in hand (#454), so
      // the editor can show what a safety check would cost before offering the button.
      // Local arithmetic: no call, no ledger row.
      validationEstimateMicroEur: estimatePromptValidation(db, user.tenantId, key, body),
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
    const row = promptGateGuard(() =>
      createPromptVersion(db, user.tenantId, {
        key: input.key,
        locale: input.locale,
        body: input.body,
        createdBy: user.id,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.activate === undefined ? {} : { activate: input.activate }),
      }),
    )

    recordAudit(db, {
      tenantId: user.tenantId,
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
        tenantId: user.tenantId,
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
    const key = promptKeyOf(row.key)

    const previous = loadActivePrompt(db, user.tenantId, key, row.locale)
    const activated = promptGateGuard(() => activatePrompt(db, user.tenantId, id))

    recordAudit(db, {
      tenantId: user.tenantId,
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
   * Removes a stored version outright — not the rollback gesture, the "this was wrong"
   * one. Allowed on the active version too: `resolvePrompt`'s built-in fallback is
   * exactly what makes losing the active row a safe, visible state rather than a broken
   * one, and refusing here would just be a second, redundant guard on top of it.
   *
   * The delete and its audit entry are one transaction, unlike the other write routes on
   * this page: those are all reversible (an activation, a save), so a lost audit entry
   * would be an annoyance the next write's own entry mostly explains. This one is not —
   * text that is gone is gone — so an audit insert failing here must take the delete back
   * with it rather than leave a silent, unexplained deletion behind.
   */
  app.delete('/api/settings/prompts/:id', (request: FastifyRequest) => {
    const user = requireOwner(request)
    const id = (request.params as { id: string }).id

    const before = loadPrompt(db, user.tenantId, id)
    if (before === null) throw notFound('No such prompt version.')

    db.transaction((tx) => {
      deletePromptVersion(tx, user.tenantId, id)
      recordAudit(tx, {
        tenantId: user.tenantId,
        action: 'prompt.delete',
        entity: 'prompts',
        entityRef: id,
        actorId: user.id,
        before: { key: before.key, locale: before.locale, version: before.version },
        after: null,
      })
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
      tenantId: user.tenantId,
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
   * The AI log's own list (#497) — every recorded run, newest first, no month
   * scoping. A session, not `requireOwner`, same reasoning as the payload route
   * in `api/insights.ts`: this is an audit view of data the session can already
   * see elsewhere, and gating the log harder than the numbers it explains would
   * only mean the person who can read the conclusions cannot check them.
   *
   * A dedicated endpoint rather than `/api/insights`, which is month-scoped and
   * bundles unrelated data — the wrong shape for an all-time log.
   *
   * `before` pages backwards from a previously-returned run's id (#502): `ai_runs`
   * is never pruned, so a fixed page with no way to reach what is past it made
   * every transcript older than the 50th permanently unreachable through this
   * screen. Resolved to that run's own `(createdAt, seq)` — the exact pair
   * `recentRuns` orders by (#510, #514) — rather than trusting an offset a concurrent
   * insert could shift. An id that no longer resolves for this tenant (a bad or
   * stale link) ends the log rather than silently restarting it from the top.
   */
  app.get('/api/settings/ai/runs', (request: FastifyRequest): AiRunList => {
    const user = requireUser(request)
    const query = request.query as { before?: unknown } | undefined
    const before = query?.before
    if (before !== undefined && typeof before !== 'string') {
      throw badRequest('before must be a run id.')
    }

    const cursor = before === undefined ? undefined : loadRunCursor(db, user.tenantId, before)
    if (before !== undefined && cursor === null) {
      return aiRunListSchema.parse({ runs: [], nextCursor: null })
    }

    const rows = recentRuns(db, user.tenantId, AI_LOG_PAGE_SIZE, undefined, cursor ?? undefined)
    return aiRunListSchema.parse({
      runs: rows.map(wireRun),
      nextCursor: rows.length === AI_LOG_PAGE_SIZE ? (rows[rows.length - 1]?.id ?? null) : null,
    })
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
