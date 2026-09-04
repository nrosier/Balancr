/**
 * The settings page's own sub-navigation (#200).
 *
 * `routeFor` in `../routes.ts` already resolves every `/settings/*` path to the one
 * `Settings` route (marked `nested`); this is the table `Settings.tsx` reads to decide
 * which panels to show for whichever of those paths is actually current, and that
 * `SettingsNav.tsx` reads to render the tab strip. One list rather than two, for the
 * same reason `routes.ts` is one list: a section added to one and not the other is a
 * tab that renders nothing, or a panel nothing links to.
 */
export type SettingsSectionId =
  | 'general'
  | 'prompts'
  | 'risk'
  | 'thresholds'
  | 'accounts'
  | 'benchmark'
  | 'spend'

export interface SettingsSection {
  readonly id: SettingsSectionId
  /** Absolute path, `/settings` for the default section. */
  readonly path: string
  /** Catalogue key in the `settings` namespace. */
  readonly labelKey: string
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'general', path: '/settings', labelKey: 'settings:nav.general' },
  { id: 'prompts', path: '/settings/prompts', labelKey: 'settings:nav.prompts' },
  { id: 'risk', path: '/settings/risk', labelKey: 'settings:nav.risk' },
  { id: 'thresholds', path: '/settings/thresholds', labelKey: 'settings:nav.thresholds' },
  { id: 'accounts', path: '/settings/accounts', labelKey: 'settings:nav.accounts' },
  { id: 'benchmark', path: '/settings/benchmark', labelKey: 'settings:nav.benchmark' },
  { id: 'spend', path: '/settings/spend', labelKey: 'settings:nav.spend' },
]

/** The section an arbitrary `/settings*` path belongs to; an unknown one lands on General. */
export function sectionFor(pathname: string): SettingsSectionId {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  const normalized = path === '' ? '/' : path
  return SETTINGS_SECTIONS.find((section) => section.path === normalized)?.id ?? 'general'
}
