/**
 * The settings page's own sub-navigation (#200).
 *
 * `routeFor` in `../routes.ts` already resolves every `/settings/*` path to the one
 * `Settings` route (marked `nested`); this is the table `Settings.tsx` reads to decide
 * which panels to show for whichever of those paths is actually current, and that
 * `SettingsNav.tsx` reads to render the tab strip. One list rather than two, for the
 * same reason `routes.ts` is one list: a section added to one and not the other is a
 * tab that renders nothing, or a panel nothing links to.
 *
 * Built on `../ui/sections.ts`'s generic `Section`/`sectionFor` — the tab-strip
 * mechanism this page settled on and the one `#228`/`#229`/`#230` reuse rather than
 * reinventing.
 */
import { sectionFor as sectionForGeneric, type Section } from '../ui/sections.ts'

export type SettingsSectionId =
  | 'general'
  | 'ai'
  | 'risk'
  | 'thresholds'
  | 'net-worth'
  | 'benchmark'
  | 'integrations'

export const SETTINGS_SECTIONS: readonly Section<SettingsSectionId>[] = [
  { id: 'general', path: '/settings', labelKey: 'settings:nav.general' },
  { id: 'ai', path: '/settings/ai', labelKey: 'settings:nav.ai' },
  { id: 'risk', path: '/settings/risk', labelKey: 'settings:nav.risk' },
  { id: 'thresholds', path: '/settings/thresholds', labelKey: 'settings:nav.thresholds' },
  { id: 'net-worth', path: '/settings/net-worth', labelKey: 'settings:nav.netWorth' },
  { id: 'benchmark', path: '/settings/benchmark', labelKey: 'settings:nav.benchmark' },
  { id: 'integrations', path: '/settings/integrations', labelKey: 'settings:nav.integrations' },
]

/** The section an arbitrary `/settings*` path belongs to; an unknown one lands on General. */
export function sectionFor(pathname: string): SettingsSectionId {
  return sectionForGeneric(SETTINGS_SECTIONS, pathname, 'general')
}

/**
 * Where a pre-#528 flat tab moved to. `sectionFor` alone would resolve every one of
 * these old prefixes to General — none of them survive as a `SETTINGS_SECTIONS`
 * entry — so a bookmarked `/settings/goals` would silently show the wrong panel
 * instead of the one it was saved for. Prefixes, not exact paths, for the same
 * reason `sectionFor` itself is prefix-aware: none of these old tabs had a nested
 * strip of their own, but a saved deep link could still have landed one path level
 * below the tab (there wasn't one to land on, but nothing enforced that either).
 */
const LEGACY_SETTINGS_REDIRECTS: ReadonlyArray<readonly [from: string, to: string]> = [
  ['/settings/prompts', '/settings/ai/prompts'],
  ['/settings/ai-log', '/settings/ai/log'],
  ['/settings/accounts', '/settings/net-worth'],
  ['/settings/property', '/settings/net-worth/property'],
  ['/settings/loans', '/settings/net-worth/loans'],
  ['/settings/debts', '/settings/net-worth/debts'],
  ['/settings/goals', '/settings/net-worth/goals'],
]

/** The current path a legacy `/settings/*` path should redirect to, or `null` if it isn't one. */
export function legacyRedirectFor(pathname: string): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  for (const [from, to] of LEGACY_SETTINGS_REDIRECTS) {
    if (path === from) return to
    if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`
  }
  return null
}
