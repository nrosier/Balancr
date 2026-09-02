/**
 * Translation in the browser, and the number format that is deliberately not part of it.
 *
 * The one property this file exists for: **language and formatting are separate
 * settings.** Choosing English must not turn `2,4 months` into `2.4 months`. Every
 * figure on screen is cross-checked against a Belgian bank statement or Actual's own
 * UI, so the decimal comma stays whatever the UI language is — and the way that breaks
 * is silent, because `2.4 months` is a perfectly plausible-looking string.
 *
 * The mechanism is `withFormattedCount`: `count` stays a number so i18next can pick
 * `_one` from `_other`, and a separately formatted `{{value}}` is what the sentence
 * prints. A component reaching for `useTranslation` directly would skip that and
 * nothing would fail, which is why `useT` is what the components use and what is
 * tested here.
 *
 * The catalogues are asserted to be the server's own files rather than a copy. That is
 * what makes `npm run i18n:check` cover the frontend as well: one set of files, one
 * parity check, and no build step that could go stale.
 */
import { act, renderHook } from '@testing-library/react'
import i18next from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import { setDocumentLanguage, setLanguage, useT } from '../src/i18n.ts'
import { catalogues } from '../src/shared.ts'
import { i18nReady, SUPPORTED } from './helpers.tsx'

beforeAll(async () => {
  await i18nReady('en')
})

describe('the catalogues', () => {
  it('bundles every language on disk', () => {
    const { languages } = catalogues()
    expect(languages).toEqual([...SUPPORTED])
  })

  it('bundles the same namespaces for each of them', () => {
    const { resources, languages, namespaces } = catalogues()
    expect(namespaces.length).toBeGreaterThan(0)
    for (const language of languages) {
      expect(Object.keys(resources[language] ?? {}).sort()).toEqual([...namespaces].sort())
    }
  })

  it('puts the default namespace first, so a bare key resolves', () => {
    expect(catalogues().namespaces[0]).toBe('common')
  })

  it('reads the server’s own files rather than a copy of them', async () => {
    // Not a string comparison against a fixture: the same JSON, imported. If the
    // frontend ever grew its own copy, `i18n:check` would stop covering what renders.
    const onDisk = (await import('../../src/i18n/locales/en/common.json')) as {
      default: { nav: { overview: string } }
    }
    const bundled = catalogues().resources['en']?.['common'] as { nav: { overview: string } }
    expect(bundled.nav.overview).toBe(onDisk.default.nav.overview)
  })
})

describe('initI18n', () => {
  it('starts in the language it was asked for and says so on the document', () => {
    expect(i18next.language).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('offers no language the operator switched off', () => {
    // A language present in `locales/` but absent from `SUPPORTED_LOCALES` has been
    // turned off on purpose, and offering it would let the UI render in a language
    // the server will not use for the AI narrative.
    expect(i18next.options.supportedLngs).toEqual(expect.arrayContaining([...SUPPORTED]))
    expect(i18next.options.supportedLngs).not.toContain('de')
  })
})

describe('useT', () => {
  it('formats a counted value the Belgian way, in either language', async () => {
    const { result } = renderHook(() => useT())
    expect(result.current.t('time.monthCount', { count: 2.4 })).toBe('2,4 months')

    await act(async () => {
      await setLanguage('nl')
    })
    expect(result.current.t('time.monthCount', { count: 2.4 })).toBe('2,4 maanden')

    await act(async () => {
      await setLanguage('en')
    })
  })

  it('picks the singular from the number, not from the formatted string', () => {
    const { result } = renderHook(() => useT())
    expect(result.current.t('time.monthCount', { count: 1 })).toBe('1 month')
    expect(result.current.t('time.dayCount', { count: 2 })).toBe('2 days')
  })

  it('leaves an explicit value alone', () => {
    // A caller that already formatted the thing being printed — a money amount, say —
    // still needs `count` to select the form.
    const { result } = renderHook(() => useT())
    expect(result.current.t('time.monthCount', { count: 3, value: '€ 1.234,56' })).toBe(
      '€ 1.234,56 months',
    )
  })

  it('keeps a stable function identity across renders', () => {
    // A fresh `t` every render defeats every `memo` below it, and the charts are the
    // expensive thing under this.
    const { result, rerender } = renderHook(() => useT())
    const first = result.current.t
    rerender()
    expect(result.current.t).toBe(first)
  })

  it('reports the active language, so a component can key off it', async () => {
    const { result } = renderHook(() => useT())
    expect(result.current.language).toBe('en')

    await act(async () => {
      await setLanguage('nl')
    })
    expect(result.current.language).toBe('nl')

    await act(async () => {
      await setLanguage('en')
    })
  })
})

describe('setLanguage', () => {
  it('changes the strings and keeps <html lang> truthful', async () => {
    const { result } = renderHook(() => useT())
    expect(result.current.t('nav.overview')).toBe('Overview')

    await act(async () => {
      await setLanguage('nl')
    })
    expect(result.current.t('nav.overview')).toBe('Overzicht')
    // Screen readers and hyphenation both read this; a stale value mispronounces
    // every word on the page.
    expect(document.documentElement.lang).toBe('nl')

    await act(async () => {
      await setLanguage('en')
    })
    expect(document.documentElement.lang).toBe('en')
  })

  it('exposes the document update on its own, for a caller that has no i18next', () => {
    setDocumentLanguage('nl')
    expect(document.documentElement.lang).toBe('nl')
    setDocumentLanguage('en')
  })
})
