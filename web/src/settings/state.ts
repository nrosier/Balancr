/**
 * One payload, five panels, and every write answering with the whole thing.
 *
 * `GET /api/settings` returns everything the page shows, and each write returns it
 * again — the server says why: activating a prompt changes which version is active
 * *and* what the editor should show, grouping two accounts changes both rows *and*
 * the double-counting warning. So there is nothing to reconcile here: the answer
 * replaces the state, and no panel patches its own copy of a field.
 *
 * **One request at a time.** Not a limitation but the point: two writes in flight
 * would settle in an order nothing controls, and the loser's answer — a complete
 * payload — would paint over the winner's. Every control is disabled while something
 * is pending, which also stops a dry run, the one request here that takes seconds and
 * costs money, from being pressed twice.
 *
 * `issue()` is the other half of `error`. A rejected body comes back with
 * `error.issues`, each naming one field of the request, and a threshold form has to
 * put "must not exceed baselineAlertBp" beside the input that caused it rather than
 * at the top of the page. Anything the server did not attribute to a field stays in
 * `error.message`, where the panel prints it once.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, apiGet, apiSend } from '../api/client.ts'
import { useCsrf } from '../api/csrf.tsx'
import { useResource, useSessionExpiry, type Resource } from '../api/resource.tsx'
import type { AiEstimate, Settings } from '../shared.ts'

/** The methods this page uses. `DELETE` is deliberately absent: nothing here deletes. */
export type WriteMethod = 'POST' | 'PATCH'

export interface SettingsState {
  /**
   * The payload and the three non-answers, for `DataState`. `data` is the last write's
   * response when there has been one, so the page never shows a stale figure it just
   * changed.
   */
  resource: Resource<Settings>
  /** The name the caller gave the request in flight, or null. */
  pending: string | null
  /** True while anything is in flight. What every control is disabled on. */
  busy: boolean
  /** How the last request failed. Cleared when the next one starts. */
  error: ApiError | null
  /** The message the server attached to one field of a rejected body. */
  issue: (path: string) => string | undefined
  /** A write whose answer is the whole settings payload. */
  save: (
    action: string,
    method: WriteMethod,
    path: string,
    body?: unknown,
    after?: (settings: Settings) => void,
  ) => void
  /** A request whose answer is something else — a diff, an estimate, a dry run. */
  ask: <T>(
    action: string,
    method: 'GET' | WriteMethod,
    path: string,
    body: unknown,
    onDone: (value: T) => void,
  ) => void
}

const failureOf = (cause: unknown): ApiError =>
  cause instanceof ApiError
    ? cause
    : new ApiError('network_error', 'Balancr could not be reached.', 0, null)

export function useSettings(): SettingsState {
  const csrf = useCsrf()
  const expired = useSessionExpiry()
  const read = useResource<Settings>('/api/settings')
  const [written, setWritten] = useState<Settings | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)

  // A ref rather than `pending` itself, so `run` keeps one identity for the life of
  // the page: a callback that changed on every request would make every panel a new
  // component to React on the way through.
  const busy = useRef(false)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )

  // A fresh read is authoritative. Nothing else refetches, so this fires only when
  // someone presses retry or refresh — and then what was written earlier is history.
  useEffect(() => setWritten(null), [read.data])

  const run = useCallback(
    <T,>(action: string, request: () => Promise<T>, onDone: (value: T) => void): void => {
      if (busy.current) return
      busy.current = true
      setPending(action)
      setError(null)

      void request()
        .then((value) => {
          if (!alive.current) return
          onDone(value)
        })
        .catch((cause: unknown) => {
          if (!alive.current) return
          const failure = failureOf(cause)
          // Same rule as a read: a vanished session is the application's problem,
          // not this form's. It is still shown, in case the re-ask says otherwise.
          if (failure.code === 'unauthenticated') expired()
          setError(failure)
        })
        .finally(() => {
          busy.current = false
          if (alive.current) setPending(null)
        })
    },
    [expired],
  )

  const save = useCallback<SettingsState['save']>(
    (action, method, path, body, after) => {
      run<Settings>(
        action,
        () => apiSend<Settings>(method, path, body, csrf),
        (settings) => {
          setWritten(settings)
          after?.(settings)
        },
      )
    },
    [csrf, run],
  )

  // Written generic rather than annotated `useCallback<SettingsState['ask']>`: the
  // annotation form binds `T` at the assignment and the body sees `unknown`, so the
  // caller's `AiDryRun` would arrive as an unchecked cast rather than as a type.
  const ask = useCallback(
    <T,>(
      action: string,
      method: 'GET' | WriteMethod,
      path: string,
      body: unknown,
      onDone: (value: T) => void,
    ): void => {
      run<T>(
        action,
        () => (method === 'GET' ? apiGet<T>(path) : apiSend<T>(method, path, body, csrf)),
        onDone,
      )
    },
    [csrf, run],
  )

  const issue = useCallback(
    (path: string): string | undefined =>
      error?.issues.find((candidate) => candidate.path === path)?.message,
    [error],
  )

  return {
    resource: { ...read, data: written ?? read.data },
    pending,
    busy: pending !== null,
    error,
    issue,
    save,
    ask,
  }
}

/**
 * What every panel on the page is handed.
 *
 * `owner` rather than each panel reading `settings.profile.role` itself, so the one
 * place that decides what a viewer may do is the page. Only the language control is
 * exempt: it changes what that reader sees and nothing anyone else does, which is why
 * the server lets a viewer make exactly that one write.
 *
 * `estimate` is here for the same reason, one level down: two panels offer a button that
 * spends money — the prompt editor's test run and the analysis on the AI spend panel —
 * and both have to print the price before it is pressed. Read twice it would be two
 * requests quoting two numbers that happen to agree; read once by the page it is one
 * fact, and the two controls cannot disagree about what a run costs.
 */
export interface SettingsPanelProps {
  settings: Settings
  state: SettingsState
  owner: boolean
  /** What an analysis of the latest aggregated month would cost. A `409` means none. */
  estimate: Resource<AiEstimate>
}
