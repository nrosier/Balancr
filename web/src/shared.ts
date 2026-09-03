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
  AiDryRun,
  AiEstimate,
  Budget,
  Freshness,
  Hygiene,
  Insights,
  JobStatus,
  Overview,
  Portfolio,
  PromptBody,
  PromptDiff,
  PromptSetting,
  PromptVersionSetting,
  ProbeStatus,
  Settings,
  SpendMonthSetting,
  Status,
} from '../../src/server/routes/api/schemas.ts'

export { FINDING_SPECS, isFindingCode, missingVars } from '../../src/domain/ai/codes.ts'
export type { FindingCode, Severity } from '../../src/domain/ai/codes.ts'

export { findingVars, isNeverReconciled } from '../../src/domain/ai/vars.ts'
export { isSharedLocale, SHARED_LOCALE } from '../../src/domain/ai/prompt-locale.ts'
export type { SignalFacts, Translate } from '../../src/domain/ai/vars.ts'

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
