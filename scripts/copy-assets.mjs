/**
 * tsc emits only TypeScript. Anything the runtime reads from disk — SQL
 * migrations, i18n catalogues — has to be copied alongside it, or the built
 * image fails at startup with "Can't find meta/_journal.json".
 */
import { cpSync, existsSync } from 'node:fs'

const assets = [
  ['src/db/migrations', 'dist/db/migrations'],
  ['src/i18n/locales', 'dist/i18n/locales'],
]

for (const [from, to] of assets) {
  if (!existsSync(from)) {
    console.log(`skip  ${from} (not present)`)
    continue
  }
  cpSync(from, to, { recursive: true })
  console.log(`copy  ${from} -> ${to}`)
}
