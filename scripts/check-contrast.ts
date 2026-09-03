/**
 * Fails the build when a colour pair the stylesheets actually render falls under the
 * WCAG contrast floor, in either theme.
 *
 * The pairs are derived from the CSS rather than listed here, because a hand-kept list
 * is wrong the moment someone styles a new component and describes a pair that the
 * cascade never produces. Two shapes are read out of the stylesheets:
 *
 *   - a rule that sets both `color` and `background` from tokens is that one pair;
 *   - a rule that sets only `color` inherits its background, and which background
 *     cannot be read out of a stylesheet — so the token is required to clear the floor
 *     against every surface the layout paints a large area with (`CANVASES`). That is
 *     the strict reading, and it is the one that catches the real bug: a grey that
 *     clears the white card and fails the slightly darker page behind it.
 *
 * `EXTRA` carries the pairs no rule states: a border against the two fills it can sit
 * on, and the chart axis label, whose colour is applied in `charts/theme.ts` and so
 * appears in no stylesheet at all.
 *
 * Every ratio is printed with its margin on success. A check that only speaks up when
 * it fails leaves nobody able to see that a pair passes by 0.02 and is one nudge from
 * failing.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHART_SERIES, DARK, LIGHT } from '../web/src/theme/tokens.ts'
import type { ColourToken } from '../web/src/theme/tokens.ts'

/**
 * The stylesheets to read. Defaults to the application's; an argument points it at a
 * fixture tree instead, which is how `test/unit/web-contrast.test.ts` exercises the
 * guard itself — a check nobody checks stops catching things silently.
 */
const webSrc = resolve(process.argv[2] ?? fileURLToPath(new URL('../web/src', import.meta.url)))

/** Text has to clear this against its background. */
const TEXT = 4.5
/** A border, a control's edge, a plotted shape: WCAG 1.4.11 non-text contrast. */
const UI = 3

/**
 * The surfaces the layout paints large areas with. A `color`-only rule is measured
 * against all of them, since a component gets moved between a card and the page
 * behind it without anybody revisiting its colour.
 */
const CANVASES = ['surface-page', 'surface-card', 'surface-sunken', 'surface-hover'] as const

/**
 * Foreground tokens whose background is not a canvas and is never inherited from one.
 * Each is only ever painted by a rule that sets its own background, which is measured
 * as a pair in its own right — so requiring them against a bare canvas as well would
 * demand white text be legible on white.
 */
const ON_THEIR_OWN_GROUND = new Set<string>([
  'accent-text',
  'text-inverse',
  'chart-tooltip-text',
])

/** Pairs no single rule states. */
const EXTRA: readonly { fg: ColourToken; bg: ColourToken; min: number; why: string }[] = [
  // `.field__input` draws this border over `--surface-page` inside a `--surface-card`
  // panel, so the edge of an empty text box has to be findable against both.
  { fg: 'border-strong', bg: 'surface-page', min: UI, why: 'input border on its own fill' },
  { fg: 'border-strong', bg: 'surface-card', min: UI, why: 'input border on the card' },
  // Applied in `charts/theme.ts` as ECharts `axisLabel.color`, never in a stylesheet.
  { fg: 'chart-axis', bg: 'surface-card', min: TEXT, why: 'chart axis labels' },
]

/**
 * The focus ring, which is drawn as an `outline` and so is invisible to the `color`
 * and `background` parse above. It is the one indicator that has to be findable
 * against everything, because focus lands wherever the tab order goes.
 *
 * `--border` is deliberately not required at this floor. It draws a card's edge and a
 * header's underline, which are decoration; the borders that identify a control —
 * a text box's edge, a chart's axis line — are `--border-strong`, and those are above.
 */
const INDICATORS = ['focus-ring'] as const

type Rgb = readonly [number, number, number]

function parseHex(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (m === null) return null
  const n = Number.parseInt(m[1] as string, 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const channel = (v: number): number => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function ratio(fg: Rgb, bg: Rgb): number {
  const a = luminance(fg)
  const b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** Every `.css` file under `web/src`, `tokens.css` excluded — it declares, it renders nothing. */
function stylesheets(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) stylesheets(path, out)
    else if (entry.endsWith('.css') && entry !== 'tokens.css') out.push(path)
  }
  return out
}

const comments = /\/\*[\s\S]*?\*\//g
const varRef = /^var\(--([a-z0-9-]+)\)$/

/**
 * The `color` and `background` a rule sets, for every rule in a stylesheet.
 *
 * Blocks whose selector begins `@` are recursed into rather than read: an `@media`
 * block's own text sets nothing, and the rules inside it paint exactly like the ones
 * outside. Anything not a bare `var(--token)` — `inherit`, `transparent`, a gradient —
 * is skipped, because there is no single colour to measure.
 */
function rules(css: string): { selector: string; fg?: string; bg?: string }[] {
  const found: { selector: string; fg?: string; bg?: string }[] = []
  const source = css.replace(comments, '')
  let index = 0
  while (index < source.length) {
    const open = source.indexOf('{', index)
    if (open === -1) break
    let depth = 1
    let close = open + 1
    while (close < source.length && depth > 0) {
      if (source[close] === '{') depth += 1
      else if (source[close] === '}') depth -= 1
      close += 1
    }
    const selector = source.slice(index, open).trim().replace(/\s+/g, ' ')
    const body = source.slice(open + 1, close - 1)
    if (selector.startsWith('@')) {
      found.push(...rules(body))
    } else {
      let fg: string | undefined
      let bg: string | undefined
      for (const decl of body.split(';')) {
        const colon = decl.indexOf(':')
        if (colon === -1) continue
        const property = decl.slice(0, colon).trim()
        const token = varRef.exec(decl.slice(colon + 1).trim())?.[1]
        if (token === undefined) continue
        if (property === 'color') fg = token
        else if (property === 'background' || property === 'background-color') bg = token
      }
      if (fg !== undefined || bg !== undefined) {
        const front = fg === undefined ? {} : { fg }
        found.push({ selector, ...front, ...(bg === undefined ? {} : { bg }) })
      }
    }
    index = close
  }
  return found
}

type Pair = { fg: string; bg: string; min: number; why: string }

const pairs = new Map<string, Pair>()
const add = (pair: Pair): void => {
  const key = `${pair.fg}|${pair.bg}|${String(pair.min)}`
  if (!pairs.has(key)) pairs.set(key, pair)
}

const sheets = stylesheets(webSrc)
for (const path of sheets) {
  const name = path.slice(webSrc.length + 1)
  for (const rule of rules(readFileSync(path, 'utf8'))) {
    if (rule.fg === undefined) continue
    if (rule.bg !== undefined) {
      add({ fg: rule.fg, bg: rule.bg, min: TEXT, why: `${name} ${rule.selector}` })
    } else if (!ON_THEIR_OWN_GROUND.has(rule.fg)) {
      for (const canvas of CANVASES) {
        add({ fg: rule.fg, bg: canvas, min: TEXT, why: `${name} ${rule.selector}, inherited` })
      }
    }
  }
}
for (const extra of EXTRA) add(extra)
for (const indicator of INDICATORS) {
  for (const canvas of CANVASES) {
    add({ fg: indicator, bg: canvas, min: UI, why: 'focus ring' })
  }
}
// Plotted shapes carry the meaning in a chart, so each series colour has to be
// distinguishable from the surface it is drawn on.
for (const series of CHART_SERIES) {
  add({ fg: series, bg: 'surface-card', min: UI, why: 'chart series' })
}

const problems: string[] = []
const rows: string[] = []

for (const [theme, palette] of [
  ['light', LIGHT],
  ['dark', DARK],
] as const) {
  const colours: Readonly<Record<string, string>> = palette
  for (const { fg, bg, min, why } of [...pairs.values()].sort((a, b) => a.fg.localeCompare(b.fg))) {
    const front = colours[fg]
    const back = colours[bg]
    if (front === undefined || back === undefined) {
      problems.push(`${theme}: no token --${front === undefined ? fg : bg}`)
      continue
    }
    const a = parseHex(front)
    const b = parseHex(back)
    if (a === null || b === null) {
      problems.push(`${theme}: --${fg} or --${bg} is not a six-digit hex`)
      continue
    }
    const measured = ratio(a, b)
    const margin = measured - min
    const line =
      `  ${theme.padEnd(5)} --${fg} on --${bg} ` +
      `${measured.toFixed(2)}:1 (needs ${min.toFixed(1)}, ` +
      `${margin >= 0 ? '+' : ''}${margin.toFixed(2)}) — ${why}`
    if (margin < 0) problems.push(line.trim())
    else rows.push(line)
  }
}

if (problems.length > 0) {
  console.error(`contrast check failed — ${problems.length} pair(s) under the floor:\n`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

for (const row of rows) console.log(row)
console.log(
  `contrast ok — ${pairs.size} pairs in 2 themes from ${sheets.length} stylesheets, ` +
    `text at ${TEXT.toFixed(1)}:1, borders and plotted shapes at ${UI.toFixed(1)}:1`,
)
