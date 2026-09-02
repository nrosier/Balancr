/**
 * The generated stylesheet must match its generator.
 *
 * `web/src/theme/tokens.css` is committed rather than built, because the browser needs
 * the custom properties at first paint with no JavaScript and because the dev server,
 * the tests and the production bundle must all read the same values. That makes it the
 * one file in the repository that can go stale without anything failing: change a
 * colour in `tokens.ts`, forget `npm run tokens:write`, and the charts use the new
 * palette while every border and background keeps the old one. Nobody notices, because
 * both halves look deliberate.
 *
 * So this test is the thing that notices. It is not testing the renderer; it is
 * testing that someone ran it.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BASE, DARK, LIGHT, renderTokensCss } from '../../web/src/theme/tokens.ts'

const cssPath = fileURLToPath(new URL('../../web/src/theme/tokens.css', import.meta.url))
const committed = readFileSync(cssPath, 'utf8')

describe('tokens.css', () => {
  it('is byte-identical to what tokens.ts renders', () => {
    // If this fails: `npm run tokens:write`.
    expect(committed).toBe(renderTokensCss())
  })

  it('declares every token as a custom property', () => {
    for (const name of [...Object.keys(BASE), ...Object.keys(LIGHT)]) {
      expect(committed, `--${name} is missing`).toContain(`--${name}:`)
    }
  })

  it('gives the dark palette the same names as the light one', () => {
    // A colour that exists in one theme and not the other is a component that renders
    // correctly until the toggle is used. The names have to be a matched set.
    expect(Object.keys(DARK).sort()).toEqual(Object.keys(LIGHT).sort())
  })

  it('carries the dark palette twice, identically', () => {
    // Once under `prefers-color-scheme` for the system setting and once under
    // `[data-theme='dark']` for an explicit choice — the pair is what avoids a flash
    // of the light theme before JavaScript runs. The renderer interpolates one string
    // into both places, so they cannot drift today; this pins that, because the
    // tempting refactor is to build them separately.
    const blocks = [...committed.matchAll(/color-scheme: dark;\n\n([\s\S]*?)\n\s*}/g)].map(
      (match) => (match[1] ?? '').replace(/^\s+/gm, ''),
    )
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toBe(blocks[1])
  })

  it('states a light and a dark color-scheme, so form controls follow the theme', () => {
    expect(committed).toContain('color-scheme: light')
    expect(committed).toContain('color-scheme: dark')
  })
})
