/**
 * The settings page's tab strip (#200), a thin instance of the generic `SectionNav`
 * (`../ui/SectionNav.tsx`) over `SETTINGS_SECTIONS`.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { SectionNav } from '../ui/SectionNav.tsx'
import { SETTINGS_SECTIONS } from './sections.ts'

export function SettingsNav(): ReactNode {
  const { t } = useT()

  return <SectionNav sections={SETTINGS_SECTIONS} ariaLabel={t('nav.settings')} />
}
