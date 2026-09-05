/**
 * Which accounts exist, what each one is, and which one counts when two hold the same
 * money.
 *
 * This panel is the fix for the one error in the whole application that makes every
 * figure look better than it is. An off-budget "Investments" account in Actual and the
 * positions behind it in Ghostfolio are the same euros; counted twice, net worth is
 * flattering and nothing on screen says so. So the server offers `dedupe` — pairs it
 * suspects — and the only resolution it accepts is a group with exactly one source of
 * truth. The suggestion is never applied automatically: only the person who set both
 * tools up knows whether the Ghostfolio account really mirrors that Actual one.
 *
 * Every control writes immediately rather than collecting into a form with a save
 * button. Each is a single independent judgement — this is a credit card, that one is
 * not part of net worth — and the response is the whole settings payload, so a row
 * that changes because another row changed (marking one account the truth clears the
 * flag on its group) arrives without this panel having to work out which.
 *
 * A list of rows rather than a table: five columns of controls do not survive a 375px
 * screen, and the columns here have nothing to align across rows anyway.
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
                          {t('settings:accounts.dedupe.useThis', { name: nameOf(truthId) })}
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
            {accounts.map((account) => (
              <Row
                key={account.id}
                account={account}
                busy={state.busy}
                owner={owner}
                onPatch={patch}
                onTruth={(id) => {
                  state.save(
                    `truth:${id}`,
                    'POST',
                    `/api/settings/accounts/${id}/source-of-truth`,
                    undefined,
                  )
                }}
                onUngroup={(id) => {
                  state.save(
                    `ungroup:${id}`,
                    'POST',
                    `/api/settings/accounts/${id}/ungroup`,
                    undefined,
                  )
                }}
              />
            ))}
          </ul>
        </>
      )}
    </Panel>
  )
}

interface RowProps {
  account: AccountSetting
  busy: boolean
  owner: boolean
  onPatch: (id: string, body: Record<string, unknown>) => void
  onTruth: (id: string) => void
  onUngroup: (id: string) => void
}

function Row({ account, busy, owner, onPatch, onTruth, onUngroup }: RowProps): ReactNode {
  const { t } = useT()
  const {
    id,
    dedupeGroup,
    includeInNetWorth,
    isSourceOfTruth,
    kind,
    name,
    netWorthExclusionReason,
    source,
  } = account
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

      {/*
        #245: `includeInNetWorth` on and a resolved-looking group can still add up to
        "not counted" — the reason lives in the dedupe decision, not in any one field
        on this row. Said here rather than left to a warn-level log line nobody but
        the server reads.
      */}
      {netWorthExclusionReason === null ? null : (
        <p className="notice notice--warn">
          {t(`settings:accounts.excluded.${netWorthExclusionReason}`)}
        </p>
      )}

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

      <div className="account__group">
        <span className="field__label">{t('settings:accounts.group')}</span>
        {dedupeGroup === null ? (
          <span className="muted">{t('settings:accounts.onItsOwn')}</span>
        ) : (
          <>
            {isSourceOfTruth ? (
              <span className="badge badge--truth">{t('settings:accounts.sourceOfTruth')}</span>
            ) : (
              <button
                type="button"
                className="button button--quiet"
                disabled={locked}
                onClick={() => onTruth(id)}
              >
                {t('settings:accounts.useAsTruth')}
              </button>
            )}
            <button
              type="button"
              className="button button--quiet"
              disabled={locked}
              onClick={() => onUngroup(id)}
            >
              {t('settings:accounts.ungroup')}
            </button>
          </>
        )}
      </div>
    </li>
  )
}
