/**
 * The trail of every change a human approved (#592): `GET /api/audit`, read-only.
 *
 * Owner-only on the server (`audit.ts`'s own header explains why: `before`/`after`
 * can name a co-parent or an amount a viewer should not see) — so this panel is not
 * offered to a viewer at all, the same call `GeneralSection` makes for the subsection
 * itself, rather than being rendered and left to show a 403.
 *
 * Self-fetching, like `AiLog`: `/api/audit` is not part of the settings payload, and
 * the drawer that shows one entry's before/after reuses `AiLog`'s own
 * `ai-log__drawer`/`ai-log__transcript` classes rather than inventing a second set for
 * the same two-column "here is what changed" shape.
 */
import { Fragment, useId, useState, type ReactNode } from 'react'
import { useResource } from '../api/resource.tsx'
import { useT } from '../i18n.ts'
import { formatDateTime, type AuditEntry, type AuditTrail } from '../shared.ts'
import { DataState } from '../ui/DataState.tsx'
import { Panel } from './Panel.tsx'

export function AuditPanel(): ReactNode {
  const { t } = useT()
  const resource = useResource<AuditTrail>('/api/audit')
  const captionId = useId()
  const [opened, setOpened] = useState<string | null>(null)

  return (
    <Panel title={t('settings:audit.title')} hint={t('settings:audit.hint')}>
      <DataState resource={resource}>
        {(trail) =>
          trail.entries.length === 0 ? (
            <p className="muted">{t('settings:audit.empty')}</p>
          ) : (
            <div className="table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
              <table className="table">
                <caption className="table__caption" id={captionId}>
                  {t('settings:audit.caption', { count: trail.entries.length })}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t('settings:audit.column.when')}</th>
                    <th scope="col">{t('settings:audit.column.action')}</th>
                    <th scope="col">{t('settings:audit.column.entity')}</th>
                    <th scope="col">{t('settings:audit.column.actor')}</th>
                    <th scope="col">
                      <span className="sr-only">{t('settings:audit.viewChange')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {trail.entries.map((entry) => (
                    <EntryRow
                      entry={entry}
                      open={opened === entry.id}
                      onToggle={() => setOpened(opened === entry.id ? null : entry.id)}
                      key={entry.id}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </DataState>
    </Panel>
  )
}

function EntryRow({
  entry,
  open,
  onToggle,
}: {
  entry: AuditEntry
  open: boolean
  onToggle: () => void
}): ReactNode {
  const { t } = useT()
  const hasChange = entry.before !== null || entry.after !== null

  return (
    <Fragment>
      <tr>
        <th scope="row">{formatDateTime(entry.at)}</th>
        <td className="table__cell--code">{entry.action}</td>
        <td className="table__cell--code">
          {entry.entity} · {entry.entityRef}
        </td>
        <td className="table__cell--code">{entry.actorId ?? t('settings:audit.system')}</td>
        <td>
          {hasChange ? (
            <button type="button" className="button button--quiet" aria-expanded={open} onClick={onToggle}>
              {open ? t('settings:audit.hideChange') : t('settings:audit.viewChange')}
            </button>
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr>
          <td className="ai-log__drawer" colSpan={5}>
            <div className="ai-log__transcript">
              <div>
                <h3 className="ai-log__transcriptTitle">{t('settings:audit.before')}</h3>
                {entry.before === null ? (
                  <p className="muted">{t('settings:audit.none')}</p>
                ) : (
                  <pre className="ai-log__pre">{JSON.stringify(entry.before, null, 2)}</pre>
                )}
              </div>
              <div>
                <h3 className="ai-log__transcriptTitle">{t('settings:audit.after')}</h3>
                {entry.after === null ? (
                  <p className="muted">{t('settings:audit.none')}</p>
                ) : (
                  <pre className="ai-log__pre">{JSON.stringify(entry.after, null, 2)}</pre>
                )}
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </Fragment>
  )
}
