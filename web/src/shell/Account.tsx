/**
 * Who is signed in, and the way out.
 *
 * The name is narrowed by CSS rather than removed here, so the markup does not depend
 * on a viewport measurement taken in JavaScript. It truncates to an ellipsis at 12
 * characters on a phone, which is a deliberate loss: the header is chrome, the full
 * identity is on the settings page, and a `title` on a plain `span` is unreachable by
 * keyboard and by touch, so it would only look like a fix.
 *
 * Sign-out is deliberately not optimistic. The server has to accept the POST — it
 * is what deletes the session row — and pretending otherwise would leave a browser
 * showing the sign-in screen while the session it just "ended" stayed valid for
 * anyone holding the cookie.
 */
import { useState, type ReactNode } from 'react'
import type { CsrfConfig } from '../api/client.ts'
import { accountLabel, signOut, type SessionUserResponse } from '../auth/session.ts'
import { useT } from '../i18n.ts'
import { IconSignOut } from './icons.tsx'

export interface AccountProps {
  user: SessionUserResponse
  csrf: CsrfConfig
  /** Called once the server has confirmed the session is gone. */
  onSignedOut: () => void
}

export function Account({ user, csrf, onSignedOut }: AccountProps): ReactNode {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const label = accountLabel(user)

  const submit = (): void => {
    setBusy(true)
    void signOut(csrf)
      .then(onSignedOut)
      .catch(() => {
        // A failed logout leaves the session alive, so the honest thing is to stay
        // on the page with the button usable again rather than to fake a sign-out.
        setBusy(false)
      })
  }

  return (
    <div className="account">
      {label === null ? null : <span className="account__name">{label}</span>}
      <button
        type="button"
        className="button button--quiet button--icon"
        aria-label={t('auth.signOut')}
        title={t('auth.signOut')}
        disabled={busy}
        onClick={submit}
      >
        <IconSignOut />
      </button>
    </div>
  )
}
