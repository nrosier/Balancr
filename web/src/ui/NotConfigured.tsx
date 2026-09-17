/**
 * What a page shows in place of figures it has no source for.
 *
 * An `info` notice, never `warn` — an integration nobody has connected yet is a
 * supported state, the same as the empty states in `DataState`, not a fault to flag
 * in yellow. `AiOff` (`pages/Insights.tsx`) is the same idea for the AI panels; this
 * is the version for a whole page's figures, with a link to where it gets fixed.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { Link } from '../router.tsx'

export interface NotConfiguredProps {
  integration: 'actual' | 'ghostfolio'
}

export function NotConfigured({ integration }: NotConfiguredProps): ReactNode {
  const { t } = useT()

  return (
    <div className="notice notice--info" role="status">
      <p className="notice__lead">{t(`notConfigured.${integration}.title`)}</p>
      <p>{t(`notConfigured.${integration}.body`)}</p>
      <p>
        <Link to="/settings/integrations" className="button">
          {t('notConfigured.cta')}
        </Link>
      </p>
    </div>
  )
}
