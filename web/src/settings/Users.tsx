/**
 * Account access, owner-facing (#695, #739).
 *
 * The one gesture #695 added and #739 found unreachable from the browser: an
 * owner disabling another account. `PATCH /api/settings/users/:id` already ends
 * every session the account currently holds the moment it goes disabled (see
 * that route's own doc comment) — so "disable" here is also the session-kill and
 * the access-removal #695's original request asked for, not a separate control.
 * There is no way to delete a user row outright; disabling is the in-app ceiling,
 * same as revoking is for an invite in `Members.tsx` next to it.
 *
 * A row for the signed-in owner's own account is rendered same as any other —
 * the server, not this panel, is what refuses to leave the tenant with no
 * enabled owner, so disabling here can fail with a field-less issue same as any
 * other rejected write.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { formatDateTime, type UserSetting } from '../shared.ts'
import { Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

function StatusBadge({ disabled }: { disabled: boolean }): ReactNode {
  const { t } = useT()
  return (
    <span className={`badge badge--${disabled ? 'warn' : 'ok'}`}>
      {t(disabled ? 'settings:users.status.disabled' : 'settings:users.status.enabled')}
    </span>
  )
}

export function UsersPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const locked = !owner || state.busy

  const setDisabled = (row: UserSetting, disabled: boolean): void => {
    state.save('user-access', 'PATCH', `/api/settings/users/${row.id}`, { disabled })
  }

  return (
    <Panel
      title={t('settings:users.title')}
      hint={t('settings:users.hint')}
      notice={owner ? null : <p className="panel__meta muted">{t('settings:viewerOnly')}</p>}
    >
      {settings.users.length === 0 ? (
        <p className="muted">{t('settings:users.empty')}</p>
      ) : (
        <ul className="invites">
          {settings.users.map((row) => (
            <li className="invite" key={row.id}>
              <div className="invite__meta">
                <span>{row.displayName ?? row.email ?? t('settings:users.unnamed')}</span>
                <StatusBadge disabled={row.disabled} />
              </div>
              <p className="invite__reads muted">
                {t(`settings:profile.role.${row.role}`)}
                {' · '}
                {t('settings:users.createdReads', { when: formatDateTime(row.createdAt) })}
                {' · '}
                {row.lastSeenAt === null
                  ? t('settings:users.lastSeenNever')
                  : t('settings:users.lastSeenReads', { when: formatDateTime(row.lastSeenAt) })}
              </p>
              <button
                type="button"
                className="button button--quiet"
                disabled={locked}
                onClick={() => setDisabled(row, !row.disabled)}
              >
                {t(row.disabled ? 'settings:users.enable' : 'settings:users.disable')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
