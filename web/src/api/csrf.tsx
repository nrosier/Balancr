/**
 * The double-submit token, made reachable from a page that writes.
 *
 * `/bootstrap` names the cookie and the header the server will check, and until #33
 * only two components needed them — the sign-in form and the sign-out button — both
 * close enough to `App.tsx` to be handed the config as a prop. The settings page is
 * not: pages are rendered by the route table as `<route.Page />` and take no props,
 * on purpose, because a page that needed wiring would be a page the table has to
 * know something about.
 *
 * So the token config travels by context. `useCsrf` throws when there is none, the
 * way `useRouter` does, rather than falling back to the conventional cookie and
 * header names: a guessed name is a token the server will not accept, and the
 * failure it produces — every write answering "CSRF token mismatch." — looks like a
 * server problem rather than a missing provider.
 */
import { createContext, useContext, type ReactNode } from 'react'
import type { CsrfConfig } from './client.ts'

const CsrfContext = createContext<CsrfConfig | null>(null)

export interface CsrfProviderProps {
  csrf: CsrfConfig
  children: ReactNode
}

export function CsrfProvider({ csrf, children }: CsrfProviderProps): ReactNode {
  return <CsrfContext.Provider value={csrf}>{children}</CsrfContext.Provider>
}

export function useCsrf(): CsrfConfig {
  const csrf = useContext(CsrfContext)
  if (csrf === null) throw new Error('useCsrf() outside a CsrfProvider')
  return csrf
}
