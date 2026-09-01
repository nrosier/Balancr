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

// 4. Every AI code the model may emit must have a sentence in every language,
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

if (problems.length > 0) {
  console.error(`i18n check failed — ${problems.length} problem(s):\n`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

const counts = Array.from(catalogues, ([lang, flat]) => `${lang}=${flat.size}`).join(' ')
console.log(
  `i18n ok — ${namespaces.length} namespaces, ${languages.length} languages (${counts}), ` +
    `${Object.keys(FINDING_SPECS).length} finding codes, ` +
    `${Object.keys(CLARIFICATION_SPECS).length} clarification codes`,
)
