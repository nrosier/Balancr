/**
 * The screen a brand-new OIDC identity lands on (#373).
 *
 * `App` renders this instead of `<SignIn>` when `/auth/session` reports a
 * `pending` identity — Authentik has already vouched for this person, but no
 * `users` row exists yet, so there is no tenant to sign them into. Two modes,
 * toggled locally rather than routed: "create a new household" (becomes that
 * tenant's owner) or "redeem an invite code" (becomes a viewer of whoever's
 * tenant issued it). Styled like `SignIn.tsx` and reuses its stylesheet — this
 * is the same kind of screen, one step later in the same flow.
 *
 * A wrong, expired, revoked or already-used invite code all come back as the
 * same generic failure from the server, on purpose (distinguishing them would
 * confirm a guess to whoever is guessing) — shown verbatim, like every other
 * auth failure in this app.
 */
import { useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, type CsrfConfig } from '../api/client.ts'
import mark from '../assets/favicon.svg'
import { useT } from '../i18n.ts'
import { createTenant, redeemInvite } from './session.ts'
import './signin.css'

export interface OnboardingProps {
  pending: { email: string | null; displayName: string | null }
  csrf: CsrfConfig
  /**
   * Called once the server has issued a session. Carries nothing, same as
   * `SignIn`'s `onSignedIn` — `App` re-asks `/auth/session` rather than
   * assembling a session object out of a half-answer.
   */
  onProvisioned: () => void
}

type Mode = 'create' | 'redeem'

export function Onboarding({ pending, csrf, onProvisioned }: OnboardingProps): ReactNode {
  const { t } = useT()
  const [mode, setMode] = useState<Mode>('create')
  const [label, setLabel] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  const who = pending.displayName ?? pending.email

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const request = mode === 'create' ? createTenant(label, csrf) : redeemInvite(code, csrf)
    void request
      .then(() => {
        onProvisioned()
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError('internal_error', t('error.generic'), 0, null),
        )
        setBusy(false)
      })
  }

  return (
    <div className="signin">
      <div className="signin__card">
        <p className="signin__brand">
          <img className="signin__mark" src={mark} alt="" width={28} height={28} />
          {t('app.name')}
        </p>
        <p className="signin__lede">
          {who === null ? t('auth.onboarding.lede') : t('auth.onboarding.ledeNamed', { who })}
        </p>

        <div className="signin__or" role="tablist" aria-label={t('auth.onboarding.modeLabel')}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'create'}
            className={`button ${mode === 'create' ? 'button--primary' : 'button--quiet'}`}
            disabled={busy}
            onClick={() => setMode('create')}
          >
            {t('auth.onboarding.createTab')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'redeem'}
            className={`button ${mode === 'redeem' ? 'button--primary' : 'button--quiet'}`}
            disabled={busy}
            onClick={() => setMode('redeem')}
          >
            {t('auth.onboarding.redeemTab')}
          </button>
        </div>

        <form className="signin__form" onSubmit={submit}>
          {mode === 'create' ? (
            <div className="field">
              <label className="field__label" htmlFor="onboarding-label">
                {t('auth.onboarding.householdLabel')}
              </label>
              <input
                id="onboarding-label"
                className="field__input"
                type="text"
                name="label"
                autoComplete="off"
                required
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
          ) : (
            <div className="field">
              <label className="field__label" htmlFor="onboarding-code">
                {t('auth.onboarding.codeLabel')}
              </label>
              <input
                id="onboarding-code"
                className="field__input field__input--code"
                type="text"
                name="code"
                autoComplete="off"
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
          )}

          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? t('auth.onboarding.submitting') : t('auth.onboarding.submit')}
          </button>
        </form>

        {error === null ? null : (
          <div className="notice notice--error signin__error" role="alert">
            {error.message}
            {error.requestId === null ? null : <p className="notice__meta">{error.requestId}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
