/**
 * The monthly digest delivery preference (#52): off, a downloadable PDF, or an
 * emailed one, plus a link to the latest stored PDF once one exists.
 *
 * Recipients are a flat array of plain strings rather than `HouseholdPanel`'s
 * three-field rows, so `edit`/`remove`/`add` here are simpler than the household
 * roster's. Same "whole preference replaced wholesale" contract as `household`:
 * a save always sends `mode`/`recipientEmails`/`locale` together, never a diff.
 *
 * The download link is a plain `<a>`, not an `apiGet`: it is a binary response,
 * not JSON, and the browser's own same-origin cookie already authenticates the
 * navigation the way it authenticates every other request on this page.
 */
import { useState, type ReactNode } from 'react'
import { useT, type TFunction } from '../i18n.ts'
import type { Settings } from '../shared.ts'
import { Issue, Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

/** The server's own cap — `MAX_DIGEST_RECIPIENTS` in `domain/digest/preference.ts`. */
const MAX_RECIPIENTS = 5

type DigestMode = Settings['digest']['mode']
const DIGEST_MODES: readonly DigestMode[] = ['off', 'pdf', 'email']

/** Same fallback Language.tsx uses: an operator's locale list, not a fixed pair. */
const localeLabel = (code: string, t: TFunction): string =>
  t(`settings:language.${code}`, { defaultValue: code })

export function DigestPanel({ settings, state, owner }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const { digest } = settings
  const locked = !owner || state.busy

  const [modeDraft, setModeDraft] = useState<DigestMode | null>(null)
  const mode = modeDraft ?? digest.mode

  const [recipientsDraft, setRecipientsDraft] = useState<string[] | null>(null)
  const recipients = recipientsDraft ?? digest.recipientEmails

  const [localeDraft, setLocaleDraft] = useState<string | null>(null)
  const localeText = localeDraft ?? digest.locale ?? ''

  const touched = modeDraft !== null || recipientsDraft !== null || localeDraft !== null

  const submit = (): void => {
    const trimmedRecipients = recipients.map((email) => email.trim()).filter((email) => email !== '')
    const trimmedLocale = localeText.trim()
    state.save(
      'digest',
      'PATCH',
      '/api/settings/digest',
      {
        mode,
        recipientEmails: trimmedRecipients,
        ...(trimmedLocale === '' ? {} : { locale: trimmedLocale }),
      },
      () => {
        setModeDraft(null)
        setRecipientsDraft(null)
        setLocaleDraft(null)
      },
    )
  }

  return (
    <Panel
      title={t('settings:digest.title')}
      hint={t('settings:digest.hint')}
      notice={owner ? null : <p className="panel__meta muted">{t('settings:viewerOnly')}</p>}
    >
      <form
        className="digest-form"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor="digest-mode">
            {t('settings:digest.mode.label')}
          </label>
          <select
            id="digest-mode"
            className="field__input"
            value={mode}
            disabled={locked}
            onChange={(event) => setModeDraft(event.target.value as DigestMode)}
          >
            {DIGEST_MODES.map((option) => (
              <option key={option} value={option}>
                {t(`settings:digest.mode.${option}`)}
              </option>
            ))}
          </select>
          <Issue message={state.issue('mode')} />
        </div>

        {mode === 'email' ? (
          <div className="field">
            <span className="field__label">{t('settings:digest.recipients.label')}</span>
            {owner ? (
              <>
                <ul className="digest__recipients">
                  {recipients.map((email, index) => (
                    <li key={index} className="digest__recipient">
                      <input
                        className="field__input"
                        type="email"
                        autoComplete="off"
                        placeholder={t('settings:digest.recipients.placeholder')}
                        value={email}
                        disabled={locked}
                        onChange={(event) =>
                          setRecipientsDraft(
                            recipients.map((existing, at) => (at === index ? event.target.value : existing)),
                          )
                        }
                      />
                      <button
                        type="button"
                        className="button button--quiet"
                        disabled={locked}
                        onClick={() => setRecipientsDraft(recipients.filter((_, at) => at !== index))}
                      >
                        {t('settings:digest.recipients.remove')}
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={locked || recipients.length >= MAX_RECIPIENTS}
                  onClick={() => setRecipientsDraft([...recipients, ''])}
                >
                  {t('settings:digest.recipients.add')}
                </button>
                <p className="panel__meta muted">{t('settings:digest.recipients.hint')}</p>
                <Issue message={state.issue('recipientEmails')} />
              </>
            ) : (
              // A viewer cannot change these and did not choose to be in the list, so the
              // addresses themselves are owner-only (#573) — the count is not a secret.
              <p className="panel__meta muted">
                {t('settings:digest.recipients.masked', { count: digest.recipientCount })}
              </p>
            )}
          </div>
        ) : null}

        <div className="field">
          <label className="field__label" htmlFor="digest-locale">
            {t('settings:digest.locale.label')}
          </label>
          <select
            id="digest-locale"
            className="field__input"
            value={localeText}
            disabled={locked}
            onChange={(event) => setLocaleDraft(event.target.value)}
          >
            <option value="">{t('settings:digest.locale.auto')}</option>
            {settings.locales.supported.map((code) => (
              <option key={code} value={code}>
                {localeLabel(code, t)}
              </option>
            ))}
          </select>
          <p className="panel__meta muted">{t('settings:digest.locale.hint')}</p>
          <Issue message={state.issue('locale')} />
        </div>

        <button type="submit" className="button button--primary" disabled={locked || !touched}>
          {state.pending === 'digest' ? t('shell.loading') : t('settings:digest.save')}
        </button>
      </form>

      {digest.hasPdf ? (
        <p className="panel__meta">
          <a href="/api/settings/digest/pdf">{t('settings:digest.download')}</a>
        </p>
      ) : mode === 'pdf' ? (
        <p className="muted">{t('settings:digest.none')}</p>
      ) : null}
    </Panel>
  )
}
