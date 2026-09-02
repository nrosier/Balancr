import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { Placeholder } from './Placeholder.tsx'

export function Insights(): ReactNode {
  const { t } = useT()
  return (
    <Placeholder
      title={t('nav.insights')}
      lede={t('page.insights.lede')}
      note={t('page.insights.soon')}
    />
  )
}
