/**
 * Who is signed in, and which language they read the interface in.
 *
 * One card, because the language *is* a property of the account rather than of the
 * browser, and that is the part worth being clear about: it is a column on the user
 * row because the nightly analysis has no browser — the narrative is generated in the
 * locale the account is set to, so a choice kept in `localStorage` would leave someone
 * reading a Dutch interface and receiving English findings. It is also the one write a
 * viewer is allowed to make, for the same reason: it changes what they see and nothing
 * anyone else does.
 *
 * **`setLanguage` runs on the server's answer, not on the click.** The response carries
 * the locale as it was stored, and switching i18next before it arrives would show a
 * language the account does not have if the write failed — and then leave it showing
 * that language, because nothing would switch it back.
 *
 * The hint says amounts stay Belgian in every language, and it is there because the
 * behaviour surprises people: `format.ts` is driven by `FORMAT_LOCALE`, not by the UI
 * language, so choosing English does not turn `1.234,56` into `1,234.56`. That is
 * deliberate — the figures have to keep matching the statements they are checked
 * against — but a control called "Language" that visibly changes nothing about the
 * numbers needs to say so.
 */
import type { ReactNode } from 'react'
import { setLanguage, useT, type TFunction } from '../i18n.ts'
import { Issue, Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

/**
 * The label for a locale, falling back to the code itself.
 *
 * `SUPPORTED_LOCALES` is an operator's list, not a fixed pair: a deployment that adds
 * `fr` would otherwise render the raw key `settings:language.fr` in the dropdown.
 */
const localeLabel = (code: string, t: TFunction): string =>
  t(`settings:language.${code}`, { defaultValue: code })

export function LanguagePanel({ settings, state }: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const { email, locale, role } = settings.profile

  const choose = (next: string): void => {
    if (next === locale) return
    state.save('locale', 'PATCH', '/api/settings/profile', { locale: next }, (saved) => {
      void setLanguage(saved.profile.locale)
    })
  }

  return (
    <Panel title={t('settings:profile.title')} hint={t('settings:language.hint')}>
      <p className="panel__meta muted">
        {email === null ? null : <>{t('settings:profile.signedInAs', { email })} · </>}
        {t(`settings:profile.role.${role}`)}
      </p>

      <div className="field">
        <label className="field__label" htmlFor="settings-locale">
          {t('settings:language.title')}
        </label>
        <select
          id="settings-locale"
          className="field__input"
          value={locale}
          disabled={state.busy}
          onChange={(event) => choose(event.target.value)}
        >
          {settings.locales.supported.map((code) => (
            <option key={code} value={code}>
              {localeLabel(code, t)}
            </option>
          ))}
        </select>
        <Issue message={state.issue('locale')} />
      </div>
    </Panel>
  )
}
