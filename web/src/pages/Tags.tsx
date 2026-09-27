/**
 * Per-tag net cost/gain totals — #663 spike.
 *
 * Read-only, like every other page: `GET /api/tags` reads `tag_meta`/`tag_monthly_facts`,
 * cached by the nightly sync — see `domain/aggregate/tags.ts` for how the three views
 * (all-time, rolling 12 months, this year) are derived from the stored monthly series.
 * No chart for this first spike, just the table — the point is answering "what did this
 * cost, all in" for something that already cuts across categories and budget lines, not
 * showing its shape over time.
 */
import { useId, type ReactNode } from 'react'
import { useResource } from '../api/resource.tsx'
import { useT } from '../i18n.ts'
import type { TagTotals } from '../shared.ts'
import { DataState } from '../ui/DataState.tsx'
import { Money } from '../ui/Money.tsx'
import { FreshnessBar } from '../ui/Refresh.tsx'
import { PageHeader } from './PageHeader.tsx'

const JOBS = ['sync'] as const

function isEmpty(data: TagTotals): boolean {
  return data.tags.length === 0
}

export function Tags(): ReactNode {
  const { t } = useT()
  const resource = useResource<TagTotals>('/api/tags')

  return (
    <>
      <PageHeader title={t('nav.tags')} lede={t('page.tags.lede')} />
      <DataState resource={resource} isEmpty={isEmpty}>
        {(data) => <TagsTable data={data} onRefreshed={resource.reload} />}
      </DataState>
    </>
  )
}

function TagsTable({ data, onRefreshed }: { data: TagTotals; onRefreshed: () => void }): ReactNode {
  const { t } = useT()
  const captionId = useId()

  return (
    <>
      <FreshnessBar freshness={data.freshness} jobs={JOBS} onRefreshed={onRefreshed} />

      <section className="card">
        <h2 className="card__title">{t('tags:title')}</h2>
        <div className="table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
          <table className="table">
            <caption className="table__caption" id={captionId}>
              {t('tags:table.caption', { count: data.tags.length })}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('tags:table.column.tag')}</th>
                <th scope="col" className="table__cell--number">
                  {t('tags:table.column.thisYear')}
                </th>
                <th scope="col" className="table__cell--number">
                  {t('tags:table.column.rolling12')}
                </th>
                <th scope="col" className="table__cell--number">
                  {t('tags:table.column.allTime')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.tags.map((tag) => (
                <tr key={tag.id}>
                  <th scope="row">
                    {tag.color === null ? null : (
                      <span className="tag-dot" aria-hidden="true" style={{ backgroundColor: tag.color }} />
                    )}
                    {tag.tag}
                  </th>
                  <td className="table__cell--number">
                    <Money cents={tag.thisYearNetCents} options={{ whole: true }} />
                  </td>
                  <td className="table__cell--number">
                    <Money cents={tag.rolling12NetCents} options={{ whole: true }} />
                  </td>
                  <td className="table__cell--number">
                    <Money cents={tag.allTimeNetCents} options={{ whole: true }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
