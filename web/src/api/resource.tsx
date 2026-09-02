/**
 * One GET, and the four answers a screen has to be able to draw.
 *
 * Every view from here on reads exactly one endpoint and has to cope with the same
 * four outcomes: nothing yet, a payload, a failure, and a session that has gone
 * away. Writing that out per page would be four copies of the same `useEffect`, and
 * the copies would diverge on the parts that are easy to get wrong rather than on
 * the parts that differ.
 *
 * Two of those parts are worth naming, because neither is obvious and both are
 * invisible when wrong.
 *
 * **A late answer must not overwrite a newer one.** Two requests in flight — a
 * reload pressed twice, or a path that changed — can settle in either order, and the
 * loser would paint stale data over fresh. The cleanup function flips `live`, so a
 * superseded request resolves into nothing.
 *
 * **A 401 is not this screen's error.** `client.ts` says so itself: the cookie is
 * gone or the session was revoked, and the answer is the sign-in screen rather than
 * a red box over empty charts. But the screen has no business deciding that either —
 * only `App.tsx` knows what to render instead — so the hook reports it upwards
 * through a context and lets the application re-ask `/auth/session`. The error is
 * *also* set, deliberately: if that re-ask comes back still-signed-in, the reader
 * must be looking at an explanation rather than at nothing.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { ApiError, apiGet } from './client.ts'

/** Told that the server no longer recognises the session. */
export type SessionExpired = () => void

/**
 * The default does nothing, rather than throwing the way `useRouter` does.
 *
 * `App.tsx` mounts the provider around the entire shell, so no page in the
 * application can be missing it — the case this default actually covers is a single
 * card rendered on its own in a test, where there is no session to re-ask and
 * reporting the error is the whole of the correct behaviour.
 */
const SessionExpiryContext = createContext<SessionExpired>(() => undefined)

export interface SessionExpiryProviderProps {
  onExpired: SessionExpired
  children: ReactNode
}

export function SessionExpiryProvider({
  onExpired,
  children,
}: SessionExpiryProviderProps): ReactNode {
  return <SessionExpiryContext.Provider value={onExpired}>{children}</SessionExpiryContext.Provider>
}

/**
 * The same reporting channel, for a request this hook did not make.
 *
 * A *write* can be told the session is gone exactly as a read can — the settings page
 * is the first screen that writes — and the answer has to be the same one: hand it to
 * `App.tsx` and let it re-ask `/auth/session`, rather than each page inventing its own
 * behaviour for a cookie that expired mid-form.
 */
export function useSessionExpiry(): SessionExpired {
  return useContext(SessionExpiryContext)
}

export interface Resource<T> {
  /** The last payload that arrived. Kept across a reload, so a refresh does not blank the page. */
  data: T | null
  error: ApiError | null
  /** True while a request is in flight — including a reload with data already on screen. */
  loading: boolean
  reload: () => void
}

export function useResource<T>(path: string): Resource<T> {
  const onExpired = useContext(SessionExpiryContext)
  const [attempt, setAttempt] = useState(0)
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(true)

  // Read through a ref so a provider that builds its callback inline does not make
  // every render a new dependency, and therefore a new request. The effect depends on
  // the path and the attempt counter, and on nothing else.
  const expired = useRef(onExpired)
  expired.current = onExpired

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)

    void apiGet<T>(path)
      .then((body) => {
        if (!live) return
        setData(body)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (!live) return
        const failure =
          cause instanceof ApiError
            ? cause
            : new ApiError('network_error', 'Balancr could not be reached.', 0, null)
        if (failure.code === 'unauthenticated') expired.current()
        setError(failure)
        setLoading(false)
      })

    return () => {
      live = false
    }
  }, [path, attempt])

  const reload = useCallback((): void => {
    setAttempt((n) => n + 1)
  }, [])

  return { data, error, loading, reload }
}
