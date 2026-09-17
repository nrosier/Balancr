/**
 * Invite management, owner-facing (#373).
 *
 * The one panel on this page that does not wait for a whole-payload refetch
 * after its write: creating an invite answers with `{ invite, code }`, not the
 * whole `Settings` payload, because the plaintext code is shown exactly once
 * and would otherwise have nowhere to live — `state.ask`, not `state.save`,
 * and the new invite is merged into local state by hand. Revoking, by
 * contrast, answers with the whole payload like every other write on this
 * page, so it goes through `state.save` same as `Property.tsx`'s remove.
 *
 * Status is computed client-side from the four timestamps a row carries
 * rather than stored as a fifth column — `redeemedAt`/`revokedAt`/`expiresAt`
 * are the facts, and "pending" is just what none of them being true means
 * right now, at read time.
 */
import { useState, type FormEvent, type ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { formatDateTime, type InviteCreated, type InviteSetting } from '../shared.ts'
import { Issue, Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

type InviteStatus = 'pending' | 'redeemed' | 'revoked' | 'expired'

function statusOf(invite: InviteSetting): InviteStatus {
  if (invite.revokedAt !== null) return 'revoked'
  if (invite.redeemedAt !== null) return 'redeemed'
  if (new Date(invite.expiresAt).getTime() <= Date.now()) return 'expired'
  return 'pending'
}

function StatusBadge({ status }: { status: InviteStatus }): ReactNode {
  const { t } = useT()
  const tone = status === 'pending' ? 'ok' : status === 'redeemed' ? 'info' : 'warn'
  return <span className={`badge badge--${tone}`}>{t(`settings:members.status.${status}`)}</span>
}

export function MembersPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const locked = !owner || state.busy
  const [label, setLabel] = useState('')
  const [justCreated, setJustCreated] = useState<InviteCreated | null>(null)
  const [invites, setInvites] = useState<InviteSetting[] | null>(null)

  const rows = invites ?? settings.invites

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const trimmed = label.trim()
    state.ask<InviteCreated>(
      'invite-create',
      'POST',
      '/api/settings/invites',
      trimmed === '' ? {} : { label: trimmed },
      (created) => {
        setJustCreated(created)
        setInvites([created.invite, ...rows])
        setLabel('')
      },
    )
  }

  const revoke = (id: string): void => {
    state.save('invite-revoke', 'POST', `/api/settings/invites/${id}/revoke`, undefined, (updated) => {
      setInvites(updated.invites)
    })
  }

  return (
    <Panel
      title={t('settings:members.title')}
      hint={t('settings:members.hint')}
      notice={owner ? null : <p className="panel__meta muted">{t('settings:viewerOnly')}</p>}
    >
      <form className="invites-form" onSubmit={submit}>
        <div className="field">
          <label className="field__label" htmlFor="invites-create-label">
            {t('settings:members.createLabel')}
          </label>
          <input
            id="invites-create-label"
            className="field__input"
            type="text"
            autoComplete="off"
            maxLength={120}
            placeholder={t('settings:members.createPlaceholder')}
            value={label}
            disabled={locked}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>

        <Issue message={state.issue('label')} />

        <button type="submit" className="button button--primary" disabled={locked}>
          {state.pending === 'invite-create' ? t('shell.loading') : t('settings:members.createButton')}
        </button>
      </form>

      {justCreated === null ? null : (
        <div className="notice notice--info" role="status">
          <p>{t('settings:members.codeShownOnce')}</p>
          <p className="invite__code">{justCreated.code}</p>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="muted">{t('settings:members.empty')}</p>
      ) : (
        <ul className="invites">
          {rows.map((invite) => {
            const status = statusOf(invite)
            const terminal = status === 'redeemed' || status === 'revoked' || status === 'expired'
            return (
              <li className="invite" key={invite.id}>
                <div className="invite__meta">
                  <span>{invite.label ?? t('settings:members.unlabeled')}</span>
                  <StatusBadge status={status} />
                </div>
                <p className="invite__reads muted">
                  {t('settings:members.createdReads', { when: formatDateTime(invite.createdAt) })}
                </p>
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={locked || terminal}
                  onClick={() => revoke(invite.id)}
                >
                  {t('settings:members.revoke')}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
