/**
 * The static-scan counterpart to `test/unit/server-api.test.ts`'s "no-upstream rule":
 * a direct `formatMoney`/`formatMoneyCompact`/`formatMicroEur` call anywhere under
 * `web/src` is a money figure privacy mode cannot blur, because only `<Money>` and
 * `<Private>` (`web/src/ui/Money.tsx`) attach the `data-private` hook `privacy.css`
 * blurs. Rather than everybody remembering to route new money JSX through `<Money>`,
 * this scans the tree and fails on any call site outside a short, named allowlist —
 * so a new one fails here instead of shipping unblurred.
 *
 * The allowlist is not "files that happen to call these functions today" — each entry
 * is a category #171 deliberately excludes, stated where it is decided:
 *
 *  - `ui/Money.tsx` — the wrapper itself.
 *  - The five ECharts files — `Chart` renders with the SVG renderer, so a chart flagged
 *    `blurWhenPrivate` (`NetWorthChart`, `BudgetBullet`, `CategoryTrend` — an axis whose
 *    labels are money) does blur its labels along with the rest of the drawing; the
 *    other two (`AllocationChart`, `SpendSankey`) have no money-labelled axis to leak in
 *    the first place, only a tooltip, and the tooltip's money substrings already go
 *    through `privateText` (`charts/tooltip.ts`). Every file's remaining call builds
 *    either a tooltip string or a `summary`/aria-label string (screen-reader-only text
 *    nothing renders visually), neither of which `<Money>` can wrap — same reasoning as
 *    the `Budget.tsx` entry below.
 *  - `insights/Narrative.tsx`, `insights/Pending.tsx` and `pages/Insights.tsx` — all call
 *    the formatter only to build a `{{cost}}`/`{{spent}}`/`{{budget}}` value for a
 *    translated sentence, which `t()` returns as a plain string i18next has already
 *    assembled — there is no sub-string DOM node left to wrap. Each wraps the *whole
 *    rendered sentence* in `<Private>` at the call site instead (verified by reading each
 *    site, not by this scan), which blurs the figure along with the words around it.
 *    `Narrative.tsx`'s and `Pending.tsx`'s confirm-button labels are the calls left
 *    genuinely unwrapped: each repeats a cost already blurred one line above it, moments
 *    before the reader presses the button that spends it, and a nested focusable span
 *    inside a `<button>` would double the tab stop. `Pending.tsx`'s transaction-amount
 *    figure is not one of these — it renders through `<Money>` like everywhere else.
 *  - AI-operational-cost figures elsewhere — the price of a Gemini call, not personal
 *    spending — in `settings/Spend.tsx`, `settings/Prompts.tsx`.
 *  - Settings/configuration numbers — thresholds and trading minimums the account
 *    configures, not spending — in `settings/Thresholds.tsx`, `settings/Risk.tsx`.
 *  - `pages/Budget.tsx`'s `pace.summary` — an aria-label on `PaceBar`, never rendered
 *    visually.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', 'src')

const CALL_PATTERN = /\bformatMoney(?:Compact)?\(|\bformatMicroEur\(/

const ALLOWED = new Set(
  [
    'ui/Money.tsx',
    'charts/NetWorthChart.tsx',
    'charts/AllocationChart.tsx',
    'charts/BudgetBullet.tsx',
    'charts/SpendSankey.tsx',
    'charts/CategoryTrend.tsx',
    'insights/Narrative.tsx',
    'insights/Pending.tsx',
    'settings/Spend.tsx',
    'settings/Prompts.tsx',
    'pages/Insights.tsx',
    'settings/Thresholds.tsx',
    'settings/Risk.tsx',
    'pages/Budget.tsx',
  ].map((path) => join(ROOT, path)),
)

/** Every `.ts`/`.tsx` file under `dir`, recursively — `shared.ts` defines the functions and is not itself a call site. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    if (!/\.tsx?$/.test(name) || path === join(ROOT, 'shared.ts')) return []
    return [path]
  })
}

describe('the money-blur rule', () => {
  it('routes every money figure through <Money>/<Private>, except the allowed exceptions', () => {
    const offenders = sourceFiles(ROOT)
      .filter((path) => !ALLOWED.has(path))
      .filter((path) => CALL_PATTERN.test(readFileSync(path, 'utf8')))

    expect(offenders).toEqual([])
  })

  it('keeps every allowlisted path pointing at a real, still-offending file', () => {
    // Guards the allowlist itself: a path that no longer calls one of these functions
    // (renamed, refactored to <Money>) should be removed, or the list silently grows
    // stale and stops meaning anything.
    const stale = [...ALLOWED].filter((path) => {
      try {
        return !CALL_PATTERN.test(readFileSync(path, 'utf8'))
      } catch {
        return true
      }
    })

    expect(stale).toEqual([])
  })
})
