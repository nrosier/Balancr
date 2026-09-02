/**
 * The sign-in screen.
 *
 * What it offers is decided by the server, not here: `/auth/session` reports
 * `methods`, and `methods.local` means "a password would be entertained from this
 * connection" — a judgement about the TCP peer address that a browser cannot make.
 * Drawing a password form that is guaranteed to 404 would be worse than drawing
 * none, so the form appears only when the server says it would work.
 *
 * The OIDC path is a real navigation, not a fetch: the code flow needs the browser
 * to visit Authentik and come back, and `return_to` carries the page the user was
 * trying to reach. The server validates that value (`safeReturnTo`) rather than
 * trusting it, because an open redirect is exactly what an unchecked one would be.
 *
 * Failures are shown verbatim from the error envelope. The server chooses one
 * message for every way a login can fail, on purpose — distinguishing "no such
 * account" from "wrong password" confirms a guess to whoever is guessing — so there
 * is nothing to interpret here. The `requestId` is shown because it is the only way
 * the operator can find the real reason in the log.
 */
import { useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, type CsrfConfig } from '../api/client.ts'
import mark from '../assets/favicon.svg'
import { useT } from '../i18n.ts'
import { localSignIn } from './session.ts'
import './signin.css'

export interface SignInProps {
  methods: { oidc: boolean; local: boolean }
  csrf: CsrfConfig
  /**
   * Called once the server has issued a session. Deliberately carries nothing: the
   * login response is a subset of `/auth/session`, and `App` re-asks rather than
   * assembling a session object out of two half-answers.
   */
  onSignedIn: () => void
}

/** Where to come back to once the provider is done with us. */
function returnTo(): string {
  return `${window.location.pathname}${window.location.search}`
}

export function SignIn({ methods, csrf, onSignedIn }: SignInProps): ReactNode {
  const { t } = useT()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    void localSignIn({ email, password, totp }, csrf)
      .then(() => {
        onSignedIn()
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
        <p className="signin__lede">{t('app.tagline')}</p>

        {methods.oidc ? (
          <a
            className="button button--primary signin__oidc"
            href={`/auth/login?return_to=${encodeURIComponent(returnTo())}`}
          >
            {t('auth.signInOidc')}
          </a>
        ) : null}

        {methods.oidc && methods.local ? <p className="signin__or">{t('auth.or')}</p> : null}

        {methods.local ? (
          <form className="signin__form" onSubmit={submit}>
            <div className="field">
              <label className="field__label" htmlFor="signin-email">
                {t('auth.email')}
              </label>
              <input
                id="signin-email"
                className="field__input"
                type="email"
                name="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value)
                }}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="signin-password">
                {t('auth.password')}
              </label>
              <input
                id="signin-password"
                className="field__input"
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value)
                }}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="signin-totp">
                {t('auth.totp')}
              </label>
              <input
                id="signin-totp"
                className="field__input field__input--code"
                type="text"
                name="totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={totp}
                onChange={(event) => {
                  setTotp(event.target.value)
                }}
              />
            </div>

            <button type="submit" className="button button--primary" disabled={busy}>
              {busy ? t('auth.signingIn') : t('auth.signIn')}
            </button>
          </form>
        ) : null}

        {!methods.oidc && !methods.local ? (
          <p className="notice">{t('auth.noMethods')}</p>
        ) : null}

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
