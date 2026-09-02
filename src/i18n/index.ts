/**
 * Server-side i18n runtime.
 *
 * The catalogues in `locales/` are shared verbatim with the SPA — the browser
 * imports the same JSON. This module exists for the contexts that have no
 * request and therefore no `Accept-Language`: cron jobs, the monthly digest,
 * and rendering AI findings when something other than the browser needs the
 * sentence. That is exactly why `DEFAULT_LOCALE` is configuration rather than
 * a constant.
 *
 * The API returns finding *codes* and numbers, not sentences, so switching
 * language in the UI is instant and never triggers a re-analysis. `renderFinding`
 * here is the same rendering, for non-browser callers and for tests that assert
 * every code in `FINDING_SPECS` actually has a sentence in every language.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import i18next, {
  type i18n as I18nInstance,
  type Resource,
  type ResourceKey,
  type ResourceLanguage,
} from 'i18next'
import { config } from '../config.ts'
import { configureFormatting } from './format-config.ts'
import { withFormattedCount, type Vars } from './format.ts'
import { missingVars, type ClarificationCode, type FindingCode } from '../domain/ai/codes.ts'

export const localesDir = fileURLToPath(new URL('./locales', import.meta.url))

/** Namespaces are per feature so a view loads only the strings it needs. */
export const NAMESPACES = [
  'common',
  'budget',
  'portfolio',
  'ai',
  'settings',
  'glossary',
] as const
export type Namespace = (typeof NAMESPACES)[number]

// Defined next to the formatter it uses, so the browser applies the same rule.
export type { Vars }

function loadCatalogues(): Resource {
  const resources: Resource = {}
  for (const lang of config.SUPPORTED_LOCALES) {
    const dir = join(localesDir, lang)
    if (!existsSync(dir)) {
      throw new Error(
        `SUPPORTED_LOCALES lists "${lang}" but ${dir} does not exist ` +
          `(available: ${readdirSync(localesDir).join(', ')})`,
      )
    }
    const catalogues: ResourceLanguage = {}
    for (const ns of NAMESPACES) {
      const file = join(dir, `${ns}.json`)
      catalogues[ns] = JSON.parse(readFileSync(file, 'utf8')) as ResourceKey
    }
    resources[lang] = catalogues
  }
  return resources
}

let instance: I18nInstance | undefined

/**
 * Initialises translation and pins number/date formatting to the configured
 * Belgian locale. Call once at startup, before anything renders — the
 * formatters default to Belgian values, so a missed call is wrong only if the
 * operator overrode `FORMAT_LOCALE`.
 */
export async function initI18n(): Promise<I18nInstance> {
  if (instance) return instance

  configureFormatting({
    formatLocale: config.FORMAT_LOCALE,
    currency: config.BASE_CURRENCY,
    timeZone: config.TZ,
  })

  const created = i18next.createInstance()
  await created.init({
    lng: config.DEFAULT_LOCALE,
    fallbackLng: config.DEFAULT_LOCALE,
    supportedLngs: config.SUPPORTED_LOCALES,
    ns: NAMESPACES,
    defaultNS: 'common',
    resources: loadCatalogues(),
    interpolation: {
      // Values are pre-formatted by src/i18n/format.ts and rendered into React,
      // so i18next must not HTML-escape them a second time.
      escapeValue: false,
    },
    returnNull: false,
  })

  instance = created
  return created
}

function i18n(): I18nInstance {
  if (!instance) throw new Error('initI18n() has not been called')
  return instance
}

/**
 * Translates `ns:dotted.key`. Throws on an unknown key outside production —
 * i18next otherwise returns the key itself, which ships as UI text that looks
 * almost plausible and survives review.
 */
export function t(lang: string, key: string, vars: Vars = {}): string {
  const fixed = i18n().getFixedT(lang)
  // `vars` must be passed through: plural keys resolve to `key_one` / `key_other`
  // via `count`, so without it every pluralised key looks missing.
  if (!i18n().exists(key, { lng: lang, ...vars }) && config.NODE_ENV !== 'production') {
    throw new Error(`missing translation: ${key} [${lang}]`)
  }
  return fixed(key, withFormattedCount(vars)) as string
}

// `missingVars` lives in `domain/ai/codes.ts`, which imports nothing and can
// therefore be read by the browser bundle too — the budget and insights screens need
// the same check on the signals they are handed as codes. Re-exported here because
// callers know it as part of the rendering surface.
export { missingVars }

/**
 * Renders a finding sentence, or null when a variable is missing.
 *
 * Null rather than a throw: one malformed finding must not take down the
 * insights page. The real guard is at ingest, where the model's response is
 * schema-checked against `FINDING_SPECS` before anything is stored.
 */
export function renderFinding(
  code: FindingCode,
  vars: Vars,
  lang: string = config.DEFAULT_LOCALE,
): string | null {
  if (missingVars(code, vars).length > 0) return null
  return t(lang, `ai:findings.${code}`, vars)
}

export function renderClarification(
  code: ClarificationCode,
  vars: Vars,
  lang: string = config.DEFAULT_LOCALE,
): string | null {
  if (missingVars(code, vars).length > 0) return null
  return t(lang, `ai:clarify.${code}`, vars)
}
