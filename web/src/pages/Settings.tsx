import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { Placeholder } from './Placeholder.tsx'

export function Settings(): ReactNode {
  const { t } = useT()
  return (
    <Placeholder
      title={t('nav.settings')}
      lede={t('page.settings.lede')}
      note={t('page.settings.soon')}
    />
  )
}
