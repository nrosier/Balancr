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
  | 'prompts'
  | 'risk'
  | 'thresholds'
  | 'accounts'
  | 'benchmark'
  | 'property'
  | 'spend'

export const SETTINGS_SECTIONS: readonly Section<SettingsSectionId>[] = [
  { id: 'general', path: '/settings', labelKey: 'settings:nav.general' },
  { id: 'prompts', path: '/settings/prompts', labelKey: 'settings:nav.prompts' },
  { id: 'risk', path: '/settings/risk', labelKey: 'settings:nav.risk' },
  { id: 'thresholds', path: '/settings/thresholds', labelKey: 'settings:nav.thresholds' },
  { id: 'accounts', path: '/settings/accounts', labelKey: 'settings:nav.accounts' },
  { id: 'benchmark', path: '/settings/benchmark', labelKey: 'settings:nav.benchmark' },
  { id: 'property', path: '/settings/property', labelKey: 'settings:nav.property' },
  { id: 'spend', path: '/settings/spend', labelKey: 'settings:nav.spend' },
]

/** The section an arbitrary `/settings*` path belongs to; an unknown one lands on General. */
export function sectionFor(pathname: string): SettingsSectionId {
  return sectionForGeneric(SETTINGS_SECTIONS, pathname, 'general')
}
