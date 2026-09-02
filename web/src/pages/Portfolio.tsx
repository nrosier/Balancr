import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { Placeholder } from './Placeholder.tsx'

export function Portfolio(): ReactNode {
  const { t } = useT()
  return (
    <Placeholder
      title={t('nav.portfolio')}
      lede={t('page.portfolio.lede')}
      note={t('page.portfolio.soon')}
    />
  )
}
