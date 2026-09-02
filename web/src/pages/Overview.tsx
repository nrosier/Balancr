import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { Placeholder } from './Placeholder.tsx'

export function Overview(): ReactNode {
  const { t } = useT()
  return (
    <Placeholder
      title={t('nav.overview')}
      lede={t('page.overview.lede')}
      note={t('page.overview.soon')}
    />
  )
}
