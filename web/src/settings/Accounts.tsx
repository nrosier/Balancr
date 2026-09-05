/**
 * Which accounts exist, what each one is, and which ones are the same money.
 *
 * This panel is the fix for the one error in the whole application that makes every
 * figure look better than it is. An off-budget "Investments" account in Actual and the
 * positions behind it in Ghostfolio are the same euros; counted twice, net worth is
 * flattering and nothing on screen says so. So the server offers `dedupe` — pairs it
 * suspects — and linking them keeps exactly one side counting. Linking is never
 * automatic: only the person who set both tools up knows whether the Ghostfolio
 * account really mirrors that Actual one.
 *
 * Two rows for one linked pair used to render as two independent list items, each with
 * its own badge and buttons — which is what actually caused #245: nothing on screen
 * said the two were already the same account, so unchecking "count toward net worth"
 * on what looked like a duplicate zeroed out real money instead of a real duplicate.
 * A link is now one block — one name pair, one net-worth toggle, one Unlink button —
 * because it is one pot of money and has exactly one on/off state. An account with no
 * equivalent on the other side still renders as its own row.
 *
 * Every control writes immediately rather than collecting into a form with a save
 * button. Each is a single independent judgement — this is a credit card, that one is
 * not part of net worth — and the response is the whole settings payload, so a row
 * that changes because another row changed arrives without this panel having to work
 * out which.
 *
 * A list of rows rather than a table: several columns of controls do not survive a
 * 375px screen, and the columns here have nothing to align across rows anyway.
 */
import type { ReactNode } from 'react'
import { useT } from '../i18n.ts'
import { formatList } from '../shared.ts'
import type { AccountSetting } from '../shared.ts'
import { ACCOUNT_KINDS } from './kinds.ts'
import { Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

export function AccountsPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
  const { t, language } = useT()
  const { accounts, dedupe } = settings

  const nameOf = (id: string): string =>
    accounts.find((account) => account.id === id)?.name ?? id

  const patch = (id: string, body: Record<string, unknown>): void => {
    state.save(`account:${id}`, 'PATCH', `/api/settings/accounts/${id}`, body)
  }

  return (
    <Panel
      title={t('settings:accounts.title')}
      hint={t('settings:accounts.hint')}
      notice={owner ? null : <p className="panel__meta muted">{t('settings:viewerOnly')}</p>}
    >
      {accounts.length === 0 ? (
        <p className="muted">{t('settings:accounts.none')}</p>
      ) : (
        <>
          {dedupe.length === 0 ? null : (
            <div className="notice notice--warn">
              <p className="notice__lead">{t('settings:accounts.dedupe.title')}</p>
              <p className="notice__hint">{t('settings:accounts.dedupe.hint')}</p>
              <ul className="dedupe">
                {dedupe.map((pair) => (
                  <li className="dedupe__pair" key={`${pair.ghostfolioId}:${pair.actualId}`}>
                    <p className="dedupe__text">
                      {t('settings:accounts.dedupe.pair', {
                        ghostfolio: nameOf(pair.ghostfolioId),
                        actual: nameOf(pair.actualId),
                      })}
                    </p>
                    {/*
                      The evidence, in words. A suggestion a person cannot audit gets
                      either accepted blindly or silenced destructively, and silencing
                      it used to mean grouping two unrelated accounts — which drops
                      real money out of net worth. Saying why is what makes the
                      dismissal an informed answer rather than an escape.
                    */}
                    <p className="dedupe__why">
                      {t('settings:accounts.dedupe.because', {
                        signals: formatList(
                          pair.signals.map((signal) =>
                            t(`settings:accounts.dedupe.signal.${signal}`),
                          ),
                          language,
                        ),
                      })}
                    </p>
                    <div className="dedupe__actions">
                      {[pair.ghostfolioId, pair.actualId].map((truthId) => (
                        <button
                          key={truthId}
                          type="button"
                          className="button button--quiet"
                          disabled={!owner || state.busy}
                          onClick={() => {
                            state.save(
                              `group:${truthId}`,
                              'POST',
                              '/api/settings/accounts/group',
                              {
                                accountMapIds: [pair.ghostfolioId, pair.actualId],
                                sourceOfTruthId: truthId,
                              },
                            )
                          }}
                        >
                          {t('settings:accounts.dedupe.link', { name: nameOf(truthId) })}
                        </button>
                      ))}
                      <button
                        type="button"
                        className="button button--quiet"
                        disabled={!owner || state.busy}
                        title={t('settings:accounts.dedupe.notMirroredHint')}
                        onClick={() => {
                          state.save(
                            `dismiss:${pair.ghostfolioId}`,
                            'POST',
                            `/api/settings/accounts/${pair.ghostfolioId}/not-mirrored`,
                            {},
                          )
                        }}
                      >
                        {t('settings:accounts.dedupe.notMirrored')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ul className="accounts">
            {(() => {
              const seenGroups = new Set<string>()
              return accounts.flatMap((account) => {
                if (account.dedupeGroup === null) {
                  return [
                    <SingleRow
                      key={account.id}
                      account={account}
                      busy={state.busy}
                      owner={owner}
                      onPatch={patch}
                    />,
                  ]
                }
                // One block per group: the first member seen renders the whole pair,
                // every later member with the same group is already on screen.
                if (seenGroups.has(account.dedupeGroup)) return []
                seenGroups.add(account.dedupeGroup)
                return [
                  <LinkedRow
                    key={account.dedupeGroup}
                    members={accounts.filter(
                      (candidate) => candidate.dedupeGroup === account.dedupeGroup,
                    )}
                    busy={state.busy}
                    owner={owner}
                    onPatch={patch}
                    onUnlink={(id) => {
                      state.save(
                        `ungroup:${id}`,
                        'POST',
                        `/api/settings/accounts/${id}/ungroup`,
                        undefined,
                      )
                    }}
                  />,
                ]
              })
            })()}
          </ul>
        </>
      )}
    </Panel>
  )
}

interface FieldsProps {
  id: string
  kind: AccountSetting['kind']
  includeInNetWorth: boolean
  locked: boolean
  onPatch: (id: string, body: Record<string, unknown>) => void
}

/** The two judgements every account (or linked pair) carries, shared by both row shapes. */
function AccountFields({ id, kind, includeInNetWorth, locked, onPatch }: FieldsProps): ReactNode {
  const { t } = useT()
  return (
    <div className="account__controls">
      <div className="field field--inline">
        <label className="field__label" htmlFor={`account-kind-${id}`}>
          {t('settings:accounts.kind')}
        </label>
        <select
          id={`account-kind-${id}`}
          className="field__input"
          value={kind}
          disabled={locked}
          onChange={(event) => onPatch(id, { kind: event.target.value })}
        >
          {ACCOUNT_KINDS.map((option) => (
            <option key={option} value={option}>
              {t(`accountKind.${option}`)}
            </option>
          ))}
        </select>
      </div>

      <label className="account__toggle" htmlFor={`account-networth-${id}`}>
        <input
          id={`account-networth-${id}`}
          type="checkbox"
          checked={includeInNetWorth}
          disabled={locked}
          onChange={(event) => onPatch(id, { includeInNetWorth: event.target.checked })}
        />
        {t('settings:accounts.includeInNetWorth')}
      </label>
    </div>
  )
}

interface SingleRowProps {
  account: AccountSetting
  busy: boolean
  owner: boolean
  onPatch: (id: string, body: Record<string, unknown>) => void
}

/** An account with no equivalent on the other side. */
function SingleRow({ account, busy, owner, onPatch }: SingleRowProps): ReactNode {
  const { t } = useT()
  const { id, includeInNetWorth, kind, name, netWorthExclusionReason, source } = account
  const locked = !owner || busy

  return (
    <li className="account">
      {/*
        A heading rather than a span: the controls below repeat their labels on every
        row, and a heading is what lets a screen reader tell which account's "Kind"
        it has landed on.
      */}
      <div className="account__head">
        <h3 className="account__name">{name}</h3>
        <span className="account__source muted">{t(`source.${source}`)}</span>
      </div>

      {netWorthExclusionReason === null ? null : (
        <p className="notice notice--warn">
          {t(`settings:accounts.excluded.${netWorthExclusionReason}`)}
        </p>
      )}

      <AccountFields
        id={id}
        kind={kind}
        includeInNetWorth={includeInNetWorth}
        locked={locked}
        onPatch={onPatch}
      />
    </li>
  )
}

interface LinkedRowProps {
  /** Every account in the group, source of truth included. Never empty. */
  members: AccountSetting[]
  busy: boolean
  owner: boolean
  onPatch: (id: string, body: Record<string, unknown>) => void
  onUnlink: (id: string) => void
}

/**
 * One block for a whole linked pair — the fix for #245.
 *
 * The source of truth's own fields are what net worth actually reads, so that is
 * what the Kind selector and the toggle act on; the other member(s) are shown as
 * plain text underneath, not as a second set of controls, because there is only one
 * pot of money here and one on/off state for it.
 */
function LinkedRow({ members, busy, owner, onPatch, onUnlink }: LinkedRowProps): ReactNode {
  const { t } = useT()
  const truth = members.find((member) => member.isSourceOfTruth) ?? members[0]
  if (truth === undefined) return null
  const others = members.filter((member) => member.id !== truth.id)
  const { id, includeInNetWorth, kind, name, netWorthExclusionReason, source } = truth
  const locked = !owner || busy

  return (
    <li className="account">
      <div className="account__head">
        <h3 className="account__name">{name}</h3>
        <span className="account__source muted">{t(`source.${source}`)}</span>
        <span className="badge badge--truth">{t('settings:accounts.linked.badge')}</span>
      </div>

      {others.map((other) => (
        <p className="account__linked muted" key={other.id}>
          {t('settings:accounts.linked.with', {
            name: other.name,
            source: t(`source.${other.source}`),
          })}
        </p>
      ))}

      {netWorthExclusionReason === null ? null : (
        <p className="notice notice--warn">
          {t(`settings:accounts.excluded.${netWorthExclusionReason}`)}
        </p>
      )}

      <AccountFields
        id={id}
        kind={kind}
        includeInNetWorth={includeInNetWorth}
        locked={locked}
        onPatch={onPatch}
      />

      <div className="account__group">
        <button
          type="button"
          className="button button--quiet"
          disabled={locked}
          onClick={() => onUnlink(id)}
        >
          {t('settings:accounts.linked.unlink')}
        </button>
      </div>
    </li>
  )
}
