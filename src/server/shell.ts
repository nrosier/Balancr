/**
 * `index.html`, once per language, with `<html lang>` already right.
 *
 * The client could set `document.documentElement.lang` after the bundle boots, and it
 * does — but "after the bundle boots" is the problem. Between the first byte and the
 * first render a screen reader has already announced the document in the wrong
 * language, and the browser has already chosen hyphenation and quotation rules from
 * it. `lang` is one of the few attributes whose value matters before any script runs,
 * so it has to be in the document the server sends.
 *
 * Substituted at startup rather than per request. There are two languages and the
 * file is about a kilobyte, so the whole set is a couple of kilobytes of resident
 * memory and every request is a map lookup. Per-request string replacement would be
 * cheap too; what it would also be is a template step in the hot path for a file that
 * never changes while the process lives.
 *
 * **No templating engine, and no placeholder token.** The substitution is the value of
 * one attribute on the document element, matched with an anchored expression and
 * required to appear exactly once. A `{{lang}}` placeholder would mean the file in
 * `web/` is no longer a valid document — it would stop opening in a browser during
 * development, and Vite would serve it to `npm run dev:web` with the placeholder
 * intact. Rewriting a real attribute keeps the source file honest and makes a
 * mismatch a startup failure rather than a page with `lang="{{lang}}"` on it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.ts'

/** The document Vite emits. */
const INDEX = 'index.html'

/**
 * Built once per bundle root.
 *
 * Two call sites want the same set — the `/` route and the not-found handler — and a
 * module-level cache is what keeps that from being two reads of the same file and two
 * copies in memory. Keyed by root rather than a bare variable so a test that builds a
 * second app against a fixture directory gets that directory's document, not the first
 * one it ever saw.
 */
const shellCache = new Map<string, Map<string, string>>()

/**
 * The `lang` attribute on the document element.
 *
 * Anchored on `<html` so a `lang` attribute anywhere else in the file — on a
 * `<blockquote>`, say, which is a real reason to use one — is not the thing that gets
 * rewritten. The value pattern excludes `>` so a malformed tag cannot swallow the
 * rest of the document.
 */
const HTML_LANG = /(<html\b[^>]*\blang=")([^">]*)(")/

/**
 * `index.html` for each of `SUPPORTED_LOCALES`, keyed by locale.
 *
 * Throws when the attribute is missing or appears twice, because both mean the
 * document is not the one this function was written against — and a silent fallback
 * would serve every language as `lang="en"`, which is the exact defect this exists to
 * prevent, now invisible.
 */
export function localeShells(root: string): Map<string, string> {
  const cached = shellCache.get(root)
  if (cached !== undefined) return cached

  const source = readFileSync(join(root, INDEX), 'utf8')

  const match = HTML_LANG.exec(source)
  if (match === null) {
    throw new Error(`${INDEX} has no <html lang>; cannot serve one language per request`)
  }
  if (HTML_LANG.exec(source.slice(match.index + match[0].length)) !== null) {
    throw new Error(`${INDEX} has more than one <html lang>; which one is the document's?`)
  }

  const shells = new Map<string, string>()
  for (const locale of config.SUPPORTED_LOCALES) {
    shells.set(locale, source.replace(HTML_LANG, `$1${locale}$3`))
  }
  shellCache.set(root, shells)
  return shells
}
