/**
 * Rendered when the path matches no route.
 *
 * The server hands any unknown path the same `index.html`, so a mistyped URL — or a
 * bookmark from a route that has since moved — arrives here rather than at a Fastify
 * 404. The way out is a real link, not `history.back()`: someone who typed the
 * address has nothing to go back to.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { Link } from '../router.tsx'
import { PageHeader } from './PageHeader.tsx'

export function NotFound(): ReactNode {
  const { t } = useT()
  return (
    <>
      <PageHeader title={t('notFound.title')} lede={t('notFound.lede')} />
      <p>
        <Link to="/" className="button">
          {t('notFound.back')}
        </Link>
      </p>
    </>
  )
}
