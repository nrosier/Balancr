/**
 * Fails the build when the translation catalogues drift.
 *
 * Without this, `nl` rots within a month: a key gets added to `en` during a
 * feature, the Dutch UI silently falls back to English, and nobody notices
 * because nobody clicks through the whole app in Dutch.
 *
 * Deliberately does not import `src/config.ts` — CI has no `.env`, and a check
 * that only runs with production secrets present is a check that never runs.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLARIFICATION_SPECS,
  FINDING_SPECS,
} from '../src/domain/ai/codes.ts'
import {
  BENCHMARK_BLOCKS,
  BENCHMARK_GROUPS,
  COICOP_DIVISIONS,
  OUTSIDE_CONSUMPTION,
} from '../src/domain/benchmark/vocabulary.ts'

const localesDir = fileURLToPath(new URL('../src/i18n/locales', import.meta.url))
const SOURCE = 'en'

const problems: string[] = []
const fail = (msg: string): void => void problems.push(msg)

type Flat = Map<string, string>

/** Flattens nested catalogue objects to `dotted.path` → value. */
function flatten(node: unknown, prefix: string, out: Flat, file: string): void {
  if (typeof node === 'string') {
    if (node.trim() === '') fail(`${file}: "${prefix}" is empty`)
    out.set(prefix, node)
    return
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    fail(`${file}: "${prefix}" must be a string or an object`)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    flatten(value, prefix ? `${prefix}.${key}` : key, out, file)
  }
}

const placeholder = /\{\{\s*([A-Za-z0-9_]+)\s*(?:,[^}]*)?\}\}/g
function varsIn(value: string): Set<string> {
  return new Set(Array.from(value.matchAll(placeholder), (m) => m[1] as string))
}

const languages = readdirSync(localesDir).filter((d) =>
  statSync(join(localesDir, d)).isDirectory(),
)
if (!languages.includes(SOURCE)) {
  console.error(`no "${SOURCE}" catalogue in ${localesDir}`)
  process.exit(1)
}

const namespaces = readdirSync(join(localesDir, SOURCE))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort()

// lang -> "ns:key" -> value
const catalogues = new Map<string, Flat>()

for (const lang of languages) {
  const flat: Flat = new Map()
  for (const ns of namespaces) {
    const file = `${lang}/${ns}.json`
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(localesDir, lang, `${ns}.json`), 'utf8'))
    } catch (error) {
      fail(`${file}: ${(error as Error).message}`)
      continue
    }
    const nsFlat: Flat = new Map()
    flatten(parsed, '', nsFlat, file)
    for (const [key, value] of nsFlat) flat.set(`${ns}:${key}`, value)
  }
  catalogues.set(lang, flat)
}

const source = catalogues.get(SOURCE) as Flat

// 1. Key parity, both directions. An orphan is as much a bug as a gap: it means
//    a key was renamed in `en` and the old translation is now dead weight.
for (const [lang, flat] of catalogues) {
  if (lang === SOURCE) continue
  for (const key of source.keys()) {
    if (!flat.has(key)) fail(`${lang}: missing key "${key}"`)
  }
  for (const key of flat.keys()) {
    if (!source.has(key)) fail(`${lang}: orphaned key "${key}" (not in ${SOURCE})`)
  }
}

// 2. Interpolation parity. A translation that drops {{delta}} renders a sentence
//    with the number silently removed — worse than an untranslated string.
for (const [lang, flat] of catalogues) {
  if (lang === SOURCE) continue
  for (const [key, value] of source) {
    const translated = flat.get(key)
    if (translated === undefined) continue
    const expected = varsIn(value)
    const actual = varsIn(translated)
    for (const v of expected) {
      if (!actual.has(v)) fail(`${lang}: "${key}" drops {{${v}}}`)
    }
    for (const v of actual) {
      if (!expected.has(v)) fail(`${lang}: "${key}" adds unknown {{${v}}}`)
    }
  }
}

// 3. Plurals come in complete sets, or the count silently disappears.
for (const [lang, flat] of catalogues) {
  for (const key of flat.keys()) {
    if (key.endsWith('_one') && !flat.has(`${key.slice(0, -4)}_other`)) {
      fail(`${lang}: "${key}" has no _other form`)
    }
  }
}

// 4. A pluralised sentence prints {{value}}, never {{count}}. `count` stays a
//    number because it is what selects `_one` from `_other`, and i18next writes an
//    interpolated number with `String(value)` — `{{count}} months` would render
//    `2.4 months` in a UI that spells every other number `2,4`. `t()` supplies
//    the formatted `{{value}}`; this check is what stops the next plural key from
//    quietly reaching for `{{count}}` again.
for (const [lang, flat] of catalogues) {
  for (const [key, value] of flat) {
    if (!/_(one|other|two|few|many|zero)$/.test(key)) continue
    if (varsIn(value).has('count')) {
      fail(`${lang}: plural key "${key}" prints {{count}}; use {{value}} (see t() in src/i18n)`)
    }
  }
}

// 5. Every AI code the model may emit must have a sentence in every language,
//    using exactly the variables its spec declares. This is the check that stops
//    a new finding code shipping as a raw identifier in the Dutch UI.
const codeGroups: Array<[string, Record<string, { readonly vars: readonly string[] }>]> = [
  ['ai:findings', FINDING_SPECS],
  ['ai:clarify', CLARIFICATION_SPECS],
]
for (const [prefix, specs] of codeGroups) {
  for (const [code, spec] of Object.entries(specs)) {
    for (const [lang, flat] of catalogues) {
      const key = `${prefix}.${code}`
      const value = flat.get(key)
      if (value === undefined) {
        fail(`${lang}: AI code "${code}" has no sentence at "${key}"`)
        continue
      }
      const actual = varsIn(value)
      for (const v of spec.vars) {
        if (!actual.has(v)) fail(`${lang}: "${key}" does not use {{${v}}} from its spec`)
      }
      for (const v of actual) {
        if (!spec.vars.includes(v)) fail(`${lang}: "${key}" uses {{${v}}}, not in its spec`)
      }
    }
  }
}

// 6. The benchmark vocabulary. Both of these are closed sets in code that reach the
//    screen as identifiers, and both would ship as one: `housing` as a table row header
//    in the Dutch UI, or `07` as the label of a menu entry somebody has to choose from.
//    Neither is a string the fallback chain can rescue, because `en` would render the
//    identifier too — the catalogue is the only place either has a name at all.
const vocabularies: Array<[string, readonly string[], string]> = [
  ['budget:benchmark.group.', BENCHMARK_GROUPS, 'benchmark group'],
  // The file's three blocks, which both the card and the settings panel name when
  // nobody has confirmed one against the source.
  ['budget:benchmark.block.', BENCHMARK_BLOCKS, 'benchmark file block'],
  // The twelve COICOP divisions plus `00`: every entry the mapping picker offers, and
  // the reason it is this list and not the ten groups is in `mapping.ts`.
  ['settings:benchmark.coicop.', [...COICOP_DIVISIONS, OUTSIDE_CONSUMPTION], 'COICOP division'],
]
for (const [prefix, ids, what] of vocabularies) {
  for (const id of ids) {
    for (const [lang, flat] of catalogues) {
      if (flat.get(`${prefix}${id}`) === undefined) {
        fail(`${lang}: ${what} "${id}" has no name at "${prefix}${id}"`)
      }
    }
  }
}

// 7. Layout bounds. Dutch runs 10-30% longer than English, and where that shows is
//    wherever the box is fixed: the bottom tab bar, a button beside another button, a
//    chart legend, a badge in a table cell. Those boxes are sized for the Dutch string
//    rather than the English one — see `.nav__label` in `web/src/shell/shell.css` and
//    `CHROME_REM` in `web/src/charts/BudgetBullet.tsx` — and this is the other half of
//    that bargain: a translation longer than its box holds fails here, rather than
//    clipping on a phone screen nobody is looking at in Dutch.
//
//    A character count is a proxy for rendered width, and a coarse one. It is used
//    anyway because it needs no browser and an author can check it by counting. Every
//    bound below is a decision about a specific box; raising one means widening that
//    box first, in the stylesheet that owns it.
const BADGE_MAX = 24
/** Groups rendered as a badge, a pill or a select option — narrow, and never wrapped. */
const BADGE_GROUPS = [
  'budget:group.',
  'common:accountKind.',
  'common:frequency.',
  'common:job.',
  'common:nature.',
  'common:severity.',
  'common:source.',
  'common:status.',
  'common:theme.',
  'portfolio:advice.badge.',
  'portfolio:assetClass.',
  'portfolio:suggest.action.',
]
const bounds: Array<{ prefix: string; max: number; box: string }> = [
  { prefix: 'common:nav.', max: 18, box: 'two lines of a fifth of a 360px tab bar' },
  { prefix: 'common:action.', max: 20, box: 'a button sharing a row with another button' },
  { prefix: 'settings:nav.', max: 20, box: 'one link in a section tab strip' },
  { prefix: 'insights:nav.', max: 20, box: 'one link in a section tab strip' },
  { prefix: 'portfolio:nav.', max: 20, box: 'one link in a section tab strip' },
  { prefix: 'budget:metric.', max: 24, box: 'two rows of the bullet-chart legend' },
  {
    prefix: 'budget:benchmark.state.',
    max: 24,
    box: "the benchmark table's last column, which does not wrap",
  },
  ...BADGE_GROUPS.map((prefix) => ({ prefix, max: BADGE_MAX, box: 'a badge in a table cell' })),
]
for (const { prefix, max, box } of bounds) {
  for (const [lang, flat] of catalogues) {
    for (const [key, value] of flat) {
      if (!key.startsWith(prefix) || value.length <= max) continue
      fail(
        `${lang}: "${key}" is ${String(value.length)} characters; ` +
          `${String(max)} is what ${box} holds`,
      )
    }
  }
}

if (problems.length > 0) {
  console.error(`i18n check failed — ${problems.length} problem(s):\n`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

const counts = Array.from(catalogues, ([lang, flat]) => `${lang}=${flat.size}`).join(' ')
console.log(
  `i18n ok — ${namespaces.length} namespaces, ${languages.length} languages (${counts}), ` +
    `${Object.keys(FINDING_SPECS).length} finding codes, ` +
    `${Object.keys(CLARIFICATION_SPECS).length} clarification codes, ` +
    `${bounds.length} length bounds`,
)
