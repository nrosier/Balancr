import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { Placeholder } from './Placeholder.tsx'

export function Budget(): ReactNode {
  const { t } = useT()
  return (
    <Placeholder
      title={t('nav.budget')}
      lede={t('page.budget.lede')}
      note={t('page.budget.soon')}
    />
  )
}
