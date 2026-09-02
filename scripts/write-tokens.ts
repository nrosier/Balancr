/**
 * Regenerates `web/src/theme/tokens.css` from `web/src/theme/tokens.ts`.
 *
 * Run it after changing a token: `npm run tokens:write`. The generated file is
 * committed, because the browser needs the custom properties at first paint and a
 * build step that produced them would leave the dev server and the tests reading
 * different values. `test/unit/web-tokens.test.ts` fails if the two ever disagree,
 * so forgetting to run this is a failing test rather than a silent drift.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderTokensCss } from '../web/src/theme/tokens.ts'

const target = fileURLToPath(new URL('../web/src/theme/tokens.css', import.meta.url))
writeFileSync(target, renderTokensCss(), 'utf8')
process.stdout.write(`wrote ${target}\n`)
