/**
 * Precomputing `index.html` once per language.
 *
 * Small enough to fit in a paragraph, and worth a suite anyway, because every way it
 * can go wrong is silent. A regex that missed the attribute would serve the document
 * unchanged — correct-looking English HTML for a Dutch reader. A regex that matched too
 * much would rewrite a `lang` attribute somewhere else in the file, or swallow the rest
 * of the document into the replacement. Neither throws, and neither is visible in a
 * screenshot.
 *
 * So the assertions are: exactly the attribute changes, nothing else does, a `lang` on
 * some other element is left alone, and a document this function cannot make sense of
 * stops the process at startup instead of being served.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localeShells } from '../../src/server/shell.ts'

const roots: string[] = []

/** A fresh bundle root, because `localeShells` caches per root by design. */
function bundle(html: string): string {
  const root = mkdtempSync(join(tmpdir(), 'balancr-shell-'))
  writeFileSync(join(root, 'index.html'), html)
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const DOC = '<!doctype html><html lang="en"><head><title>Balancr</title></head><body></body></html>'

describe('localeShells', () => {
  it('produces one document per supported locale', () => {
    const shells = localeShells(bundle(DOC))
    expect([...shells.keys()]).toEqual(['en', 'nl'])
  })

  it('rewrites the attribute and nothing else', () => {
    const shells = localeShells(bundle(DOC))
    expect(shells.get('nl')).toBe(DOC.replace('lang="en"', 'lang="nl"'))
    expect(shells.get('en')).toBe(DOC)
  })

  it('rewrites an html element that has other attributes first', () => {
    // Vite emits `<html lang="en">`, but a `data-theme` or a `class` in front of it is
    // an edit away, and an expression anchored on `<html lang` would stop matching.
    const doc = '<html class="no-js" data-x="1" lang="en"><body></body></html>'
    const shells = localeShells(bundle(doc))
    expect(shells.get('nl')).toBe(doc.replace('lang="en"', 'lang="nl"'))
  })

  it('leaves a lang attribute on another element alone', () => {
    // The `<noscript>` block carries both languages, and a quotation in a narrative is
    // a real reason for a second `lang`. Only the document element decides the page.
    const doc = '<html lang="en"><body><p lang="nl">Balancr kon niet starten.</p></body></html>'
    const shells = localeShells(bundle(doc))
    expect(shells.get('nl')).toBe(
      '<html lang="nl"><body><p lang="nl">Balancr kon niet starten.</p></body></html>',
    )
  })

  it('caches per root, so two call sites read the file once', () => {
    const root = bundle(DOC)
    expect(localeShells(root)).toBe(localeShells(root))
  })

  it('refuses a document with no lang attribute', () => {
    // A build that dropped it would otherwise serve every language as whatever the
    // browser guesses, which is the defect this module exists to prevent.
    expect(() => localeShells(bundle('<html><body></body></html>'))).toThrow(/no <html lang>/)
  })

  it('refuses a document with two of them', () => {
    expect(() =>
      localeShells(bundle('<html lang="en"><body></body></html><html lang="nl"></html>')),
    ).toThrow(/more than one/)
  })

  it('refuses a bundle with no index.html at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'balancr-shell-'))
    roots.push(root)
    expect(() => localeShells(root)).toThrow()
  })
})
