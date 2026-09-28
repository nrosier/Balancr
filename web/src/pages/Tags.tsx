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
import type { Refreshable, TagTotals } from '../shared.ts'
import { DataState } from '../ui/DataState.tsx'
import { Money } from '../ui/Money.tsx'
import { FreshnessBar } from '../ui/Refresh.tsx'
import { PageHeader } from './PageHeader.tsx'

const JOBS = ['sync'] as const satisfies readonly Refreshable[]

export function Tags(): ReactNode {
  const { t } = useT()
  const resource = useResource<TagTotals>('/api/tags')

  return (
    <>
      <PageHeader title={t('nav.tags')} lede={t('page.tags.lede')} />
      <DataState resource={resource}>
        {(data) =>
          data.tags.length === 0 ? (
            <TagsNotConfigured />
          ) : (
            <TagsTable data={data} onRefreshed={resource.reload} />
          )
        }
      </DataState>
    </>
  )
}

/**
 * A household with a synced Actual but no `#tag` anywhere is not "no data yet"
 * (#783) — the generic empty state's "run a sync" hint would be wrong, since a
 * sync may well have run. Tags are created in Actual's own UI, not a Balancr
 * setting, so there is nowhere in this app to send the reader — only what to do
 * in Actual.
 */
function TagsNotConfigured(): ReactNode {
  const { t } = useT()
  return (
    <div className="notice notice--info" role="status">
      <p className="notice__lead">{t('tags:notConfigured.title')}</p>
      <p>{t('tags:notConfigured.body')}</p>
    </div>
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
        <p className="panel__hint muted">{t('tags:hint')}</p>
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
                  <th scope="row" className="table__cell--name">
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
