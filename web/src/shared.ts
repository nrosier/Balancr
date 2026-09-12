/**
 * The only file in `web/` that reaches outside it.
 *
 * Three things cross the boundary, and all three would be wrong to duplicate:
 *
 *  - **The formatters.** `src/i18n/format.ts` and `format-config.ts` are
 *    deliberately DOM-free and Node-free so the browser and the server write money
 *    identically. A second frontend implementation is how `1.234,56` becomes
 *    `1,234.56` on one screen and nowhere else.
 *  - **The response types.** `src/server/routes/api/schemas.ts` says so itself: the
 *    schemas *are* the client contract. Taken as types only, so no Zod reaches the
 *    bundle — the server validates its own output and the browser trusts it. The
 *    authentication and bootstrap shapes come from `src/server/contract.ts`, which
 *    the handlers annotate themselves with, so renaming a field there fails both
 *    builds.
 *  - **The finding vocabulary.** `domain/ai/codes.ts` and `domain/ai/vars.ts` are
 *    written to be importable here — no `config`, no i18next instance, no `node:`
 *    anything — because the API returns findings as codes and this side renders them.
 *    A browser-side copy of that table is how `{{delta}}` ends up printed literally on
 *    one screen and as `18%` on another.
 *  - **The tax describer.** `domain/tax/describe.ts` is pure for this import — the
 *    formatters and the tax types, nothing else — because a beurstaks estimate has to
 *    read identically in a browser, in a digest email and in a test. Its catalogue keys
 *    live in `portfolio` and `glossary`, which this file already ships.
 *  - **The risk vocabulary.** `domain/advice/vocabulary.ts` exists for this import and
 *    says so: the settings screen draws four bands and offers three presets, and the
 *    order of both is a decision made once. The rest of `domain/advice/` reaches the
 *    database and stays on the server.
 *  - **The benchmark vocabulary.** `domain/benchmark/vocabulary.ts` is split out of the
 *    loader for this import: the mapping form draws a picker over the twelve COICOP
 *    divisions plus the reserved `00`, the benchmark card names the two thresholds the
 *    comparison applied, and (#323) the same card's own period picker draws its three
 *    options from here rather than from `compare.ts`, which is where they are consumed
 *    but which reaches the loader and `config` to get there. Everything else in
 *    `domain/benchmark/` reads a YAML file off disk.
 *  - **The custody share.** `domain/aggregate/custody.ts` is pure for this one import:
 *    the household panel has to print what the roster currently implies before anybody
 *    states an override, and a second implementation of that mean is how the settings
 *    screen comes to promise a share the budget card does not apply (#44).
 *  - **The shared-prompt sentinel.** `domain/ai/prompt-locale.ts` is its own module for
 *    this import: the prompt editor has to know which value means "not a language's own
 *    text", and a literal `'*'` on this side is how the picker's first entry comes to
 *    mean something different from what the server stores under it.
 *  - **The catalogues.** The same JSON files, not a copy: `npm run i18n:check`
 *    guarantees `en` and `nl` parity for one set of files, and a build-time copy is
 *    how a Dutch string gets fixed in the place nothing renders.
 *
 * Routing every import through one named module rather than scattering
 * `../../src/...` across a dozen files makes the boundary something a reviewer can
 * check at a glance. A path alias in `vite.config.ts` would do the same job with less
 * typing and no name for what it is doing.
 */
import type { Resource, ResourceKey, ResourceLanguage } from 'i18next'

export {
  firstDayOfWeek,
  formatBp,
  formatDate,
  formatDateTime,
  formatDecimal,
  formatList,
  formatMicroEur,
  formatMonth,
  formatMonthShort,
  formatMoney,
  formatMoneyCompact,
  parseMoneyToCents,
  withFormattedCount,
} from '../../src/i18n/format.ts'
export type { MoneyOptions, UiLanguage, Vars } from '../../src/i18n/format.ts'

export { configureFormatting, formatRevision, formatSettings } from '../../src/i18n/format-config.ts'
export type { FormatSettings } from '../../src/i18n/format-config.ts'

export type {
  AccountSetting,
  Advice,
  AiAvailabilityWire,
  AiBudgetNudgeRun,
  AiDryRun,
  AiEstimate,
  AiNarrativeRun,
  AiRun,
  AiRunPayload,
  BandsSetting,
  BenchmarkGroupLine,
  BenchmarkSetting,
  BenchmarkWire,
  Budget,
  CategoryGuessCandidateWire,
  CategoryGuessEstimateWire,
  CategoryGuessRunWire,
  Changelog,
  ChangelogEntry,
  CustodyWire,
  DriftLine,
  Forecast,
  Freshness,
  Hygiene,
  Insights,
  JobHistory,
  JobRun,
  JobStatus,
  JobStep,
  Overview,
  Portfolio,
  PromptBody,
  PromptDiff,
  PromptSetting,
  PromptVersionSetting,
  PropertiesSetting,
  ProbeStatus,
  ProposalAdjustResult,
  ProposalBatchApply,
  ProposalDecision,
  RefreshAccepted,
  RiskProfileSetting,
  Settings,
  SpendMonthSetting,
  Status,
  Suggestion,
} from '../../src/server/routes/api/schemas.ts'

export {
  FINDING_SPECS,
  isFindingCode,
  missingVars,
  SEVERITY_RANK,
} from '../../src/domain/ai/codes.ts'
export type { FindingCode, Severity } from '../../src/domain/ai/codes.ts'

export { findingVars, isNeverReconciled } from '../../src/domain/ai/vars.ts'
export { isSharedLocale, SHARED_LOCALE } from '../../src/domain/ai/prompt-locale.ts'
export type { SignalFacts, Translate } from '../../src/domain/ai/vars.ts'

export { describeTaxEstimate } from '../../src/domain/tax/describe.ts'
export type { TaxEstimateText, TaxLineText } from '../../src/domain/tax/describe.ts'

export { custodyShare } from '../../src/domain/aggregate/custody.ts'
export type { CustodyBasis } from '../../src/domain/aggregate/custody.ts'

// The savings card reads its own period (#288). Re-exported for the same reason
// `custodyShare` is: a second copy is a second chance to average the monthly
// percentages instead of summing the flows first.
export {
  DEFAULT_SAVINGS_PERIOD,
  periodSavings,
  SAVINGS_PERIODS,
  TRAILING_MONTHS,
} from '../../src/domain/aggregate/savings.ts'
export type { PeriodSavings, SavingsMonth, SavingsPeriod } from '../../src/domain/aggregate/savings.ts'

export {
  grossYieldBp,
  MAX_PROPERTIES,
  netCashFlowCents,
  outstandingBalanceCents,
  propertyEquityCents,
  propertyKinds,
  standardMonthlyPaymentCents,
  totalEquityCents,
} from '../../src/domain/property/vocabulary.ts'
export type { Mortgage, Property, PropertyKind } from '../../src/domain/property/vocabulary.ts'

export { BAND_CLASSES, PRESET_IDS } from '../../src/domain/advice/vocabulary.ts'
export type { BandClass, PresetId, ProfileId } from '../../src/domain/advice/vocabulary.ts'

export {
  BENCHMARK_GROUPS,
  // The benchmark card's own period chooser (#323), re-exported for the same reason
  // `SAVINGS_PERIODS` is: the option list and the type it narrows to have to be the
  // same list the server accepts, or a card and a query string could disagree about
  // it. From `vocabulary.ts` rather than `compare.ts`, which the comment above the
  // group list already explains: `compare.ts` imports the file loader and through it
  // `config`, which a browser bundle cannot carry.
  BENCHMARK_PERIODS,
  COICOP_DIVISIONS,
  divisionOf,
  MAX_HOUSEHOLD_MEMBERS,
  MIN_DELTA_BP,
  MIN_MAPPED_BP,
  OUTSIDE_CONSUMPTION,
  SHARED_COST_DIRECTIONS,
} from '../../src/domain/benchmark/vocabulary.ts'
export type {
  BenchmarkGroup,
  BenchmarkPeriodKind,
  CoicopDivision,
  SharedCostDirection,
} from '../../src/domain/benchmark/vocabulary.ts'

export { AI_VISIBILITY_CHOICES, SAVINGS_NATURE_CHOICES } from '../../src/domain/benchmark/mapping.ts'
export type { AiVisibility, SavingsNatureChoice } from '../../src/domain/benchmark/mapping.ts'

export type {
  BootstrapResponse,
  LocalLoginResponse,
  SessionResponse,
  SessionUserResponse,
} from '../../src/server/contract.ts'

// ---------------------------------------------------------------------------
//  The catalogues
// ---------------------------------------------------------------------------

/**
 * Every catalogue file, read at build time.
 *
 * `import.meta.glob` with `eager` inlines the JSON into the bundle, so there is no
 * fetch for translations and no flash of untranslated text — and no separate
 * request that could be served stale from a cache after a release.
 *
 * The languages and namespaces come from what is on disk rather than from a list
 * repeated here: `src/i18n/index.ts` derives its namespaces from a constant because
 * Node reads the directory at runtime and a typo there is a crash, whereas a glob
 * that finds nothing is a silent empty UI. Deriving from the filenames means adding
 * `locales/{en,nl}/foo.json` needs no edit on this side, and `npm run i18n:check`
 * still enforces that both languages have it.
 */
const FILES = import.meta.glob('../../src/i18n/locales/*/*.json', { eager: true }) as Record<
  string,
  { default?: unknown }
>

export interface Catalogues {
  resources: Resource
  /** The languages found on disk, which the caller narrows to `SUPPORTED_LOCALES`. */
  languages: string[]
  namespaces: string[]
}

export function catalogues(): Catalogues {
  const resources: Resource = {}
  const namespaces = new Set<string>()

  for (const [path, module] of Object.entries(FILES)) {
    const match = /\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path)
    if (match === null) continue
    const [, lang, ns] = match
    if (lang === undefined || ns === undefined) continue

    const body = (module.default ?? module) as ResourceKey
    const language: ResourceLanguage = resources[lang] ?? {}
    language[ns] = body
    resources[lang] = language
    namespaces.add(ns)
  }

  return {
    resources,
    languages: Object.keys(resources).sort(),
    // Sorted so the order does not depend on the filesystem, and `common` first
    // because it is the default namespace.
    namespaces: [...namespaces].sort((a, b) =>
      a === 'common' ? -1 : b === 'common' ? 1 : a.localeCompare(b),
    ),
  }
}
