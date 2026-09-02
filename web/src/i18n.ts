/**
 * Translation in the browser.
 *
 * The catalogues are the server's own files, inlined by the bundler (see
 * `shared.ts`), so the same key renders the same sentence whether it came from a
 * cron job's digest or from a chart tooltip. Adding a language is a directory, not a
 * code change.
 *
 * Full language switching — the resolution order, the cookie, `<html lang>` per
 * request, the control in the header — is issue #34's job. What is here is the part
 * the shell cannot start without: catalogues loaded, a language chosen from the
 * bootstrap payload, and `t()` wrapped so numbers come out Belgian.
 */
import { useMemo } from 'react'
import i18next, { type i18n as I18nInstance } from 'i18next'
import { initReactI18next, useTranslation } from 'react-i18next'
import { catalogues, withFormattedCount, type Vars } from './shared.ts'

export const DEFAULT_NAMESPACE = 'common'

export interface I18nOptions {
  /** From `/bootstrap`: what the operator configured, not what is on disk. */
  supported: readonly string[]
  language: string
}

/**
 * Initialises i18next and returns the instance.
 *
 * The catalogues are narrowed to the operator's `SUPPORTED_LOCALES` rather than
 * loaded wholesale: a language present in `locales/` but absent from that list has
 * deliberately been switched off, and offering it here would let the UI render in a
 * language the server will not use for the AI narrative.
 */
export async function initI18n(options: I18nOptions): Promise<I18nInstance> {
  const { resources, languages, namespaces } = catalogues()
  const supported = languages.filter((lang) => options.supported.includes(lang))
  const available = supported.length > 0 ? supported : languages

  const permitted: typeof resources = {}
  for (const lang of available) {
    const catalogue = resources[lang]
    if (catalogue !== undefined) permitted[lang] = catalogue
  }

  const fallback = available.includes(options.language) ? options.language : available[0]
  if (fallback === undefined) {
    // `catalogues()` globs the locale directory at build time, so an empty list means
    // the bundle itself is broken rather than the configuration.
    throw new Error('no translation catalogues were bundled')
  }

  await i18next.use(initReactI18next).init({
    lng: fallback,
    fallbackLng: fallback,
    supportedLngs: available,
    ns: namespaces,
    defaultNS: DEFAULT_NAMESPACE,
    resources: permitted,
    // Values arrive already formatted by `format.ts` and are rendered into React,
    // which escapes them itself. Escaping twice turns `&` into `&amp;` on screen.
    interpolation: { escapeValue: false },
    returnNull: false,
    react: {
      // Everything is bundled, so there is nothing to wait for and no reason to
      // render a blank tree on first paint.
      useSuspense: false,
    },
  })

  setDocumentLanguage(i18next.language)
  return i18next
}

/** Keeps `<html lang>` truthful — screen readers and hyphenation both read it. */
export function setDocumentLanguage(language: string): void {
  document.documentElement.lang = language
}

export async function setLanguage(language: string): Promise<void> {
  await i18next.changeLanguage(language)
  setDocumentLanguage(language)
}

export type TFunction = (key: string, vars?: Vars) => string

/**
 * `t()`, with the plural rule applied.
 *
 * Components use this instead of `useTranslation` directly, because a pluralised key
 * needs `count` to choose the form *and* a separately formatted `{{value}}` to print
 * it — see `withFormattedCount` for why i18next cannot be configured to do this. A
 * component that reached for `useTranslation` would render `2.4 months` in a UI that
 * writes every other number `2,4`, and nothing would fail.
 */
export function useT(namespace: string = DEFAULT_NAMESPACE): {
  t: TFunction
  language: string
} {
  const { t, i18n } = useTranslation(namespace)
  // Memoised so the wrapper keeps a stable identity across renders — a fresh function
  // every render defeats every `memo` further down the tree.
  const translate = useMemo<TFunction>(
    () =>
      (key, vars = {}) =>
        t(key, withFormattedCount(vars)) as string,
    [t],
  )
  return { t: translate, language: i18n.language }
}
