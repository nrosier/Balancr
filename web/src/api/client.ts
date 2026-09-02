/**
 * The fetch wrapper, and the two things it exists to get right.
 *
 * **Errors arrive in one envelope.** The server answers every failure as
 * `{error: {code, message, requestId, issues?}}` (see `src/server/errors.ts`), and
 * the `requestId` is the only way to find the real cause in the log — the message is
 * deliberately generic for anything the server did not choose to disclose. So it is
 * carried on the thrown error and shown in the UI, rather than dropped here.
 * `issues` appears only on a rejected request body and names the fields the form
 * itself sent, which is what lets a settings form point at the number it got wrong.
 *
 * **A session that expired is not an error to report.** A 401 means the cookie is
 * gone or the session was revoked, and the right answer is the sign-in screen, not a
 * red box on a dashboard of empty charts. Callers check `error.code` for that.
 */
import type { Budget, Insights, Overview, Portfolio } from '../shared.ts'

export type { Budget, Insights, Overview, Portfolio }

/** The codes the server promises to use. Mirrors `ERROR_CODES`. */
export type ApiErrorCode =
  | 'bad_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'internal_error'
  | 'unavailable'
  /** Not from the server: the request never arrived, or the answer was not JSON. */
  | 'network_error'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** One rejected field, by the name this client sent. Mirrors `FieldIssue`. */
export interface ApiFieldIssue {
  path: string
  message: string
}

export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  readonly requestId: string | null
  /** Empty unless the server rejected a body field by field. */
  readonly issues: ApiFieldIssue[]

  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    requestId: string | null,
    issues: ApiFieldIssue[] = [],
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.requestId = requestId
    this.issues = issues
  }
}

/**
 * The `issues` array, keeping only entries that are actually shaped like one.
 *
 * The envelope is ours, but this runs on whatever came back — a proxy's error page,
 * a truncated body — and a form that trusted the shape would render `undefined`
 * next to a field.
 */
function toFieldIssues(value: unknown): ApiFieldIssue[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry['path'] === 'string' && typeof entry['message'] === 'string'
      ? [{ path: entry['path'], message: entry['message'] }]
      : [],
  )
}

/**
 * Reads the error envelope, tolerating its absence.
 *
 * A 502 from a reverse proxy that never reached Balancr returns an HTML page, and a
 * client that assumed JSON would throw a parse error over the top of the real
 * failure — leaving the user with `Unexpected token <` instead of a status.
 */
async function toApiError(response: Response): Promise<ApiError> {
  let code: ApiErrorCode = 'internal_error'
  let message = `The request failed (${String(response.status)}).`
  let requestId: string | null = null
  let issues: ApiFieldIssue[] = []

  try {
    const parsed: unknown = await response.json()
    if (isRecord(parsed) && isRecord(parsed['error'])) {
      const envelope = parsed['error']
      if (typeof envelope['code'] === 'string') code = envelope['code'] as ApiErrorCode
      if (typeof envelope['message'] === 'string') message = envelope['message']
      if (typeof envelope['requestId'] === 'string') requestId = envelope['requestId']
      issues = toFieldIssues(envelope['issues'])
    }
  } catch {
    // Not our envelope. The status is still the truth.
  }

  return new ApiError(code, message, response.status, requestId, issues)
}

/**
 * The CSRF token, read back out of the cookie the server set.
 *
 * Double-submit: the cookie is readable by script on purpose (`csrf.ts` sets it
 * without `httpOnly`) precisely so it can be echoed in a header, which a
 * cross-origin form cannot do. Reading it per request rather than caching it matters
 * — the server rotates it, and a stale copy fails every mutation until reload.
 */
export function csrfToken(cookieName: string): string | null {
  const prefix = `${cookieName}=`
  for (const part of document.cookie.split('; ')) {
    if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length))
  }
  return null
}

export interface CsrfConfig {
  cookie: string
  header: string
}

async function request(path: string, init: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(path, {
      // The session cookie is `SameSite=Lax` and same-origin; `same-origin` here is
      // the credentials mode that says so rather than relying on the default.
      credentials: 'same-origin',
      ...init,
    })
  } catch {
    throw new ApiError('network_error', 'Balancr could not be reached.', 0, null)
  }

  if (!response.ok) throw await toApiError(response)
  if (response.status === 204) return null

  try {
    return await response.json()
  } catch {
    throw new ApiError('network_error', 'The response was not readable.', response.status, null)
  }
}

/** A read. Every `/api/*` route is a GET; nothing here needs a CSRF token. */
export async function apiGet<T>(path: string): Promise<T> {
  return (await request(path, {
    method: 'GET',
    headers: { accept: 'application/json' },
  })) as T
}

/**
 * A mutation. `POST /auth/logout` is the only one in `0.5.1`; the rest arrive with
 * the settings page (#33), and the token plumbing lives here so that when they do,
 * no screen has to remember the header.
 *
 * `content-type` is set only when there is a body. Fastify rejects a POST that
 * announces JSON and then sends nothing (`FST_ERR_CTP_EMPTY_JSON_BODY`), so a
 * bodyless mutation must not announce it — logout would otherwise 400.
 */
export async function apiSend<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  csrf: CsrfConfig,
): Promise<T> {
  const token = csrfToken(csrf.cookie)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (token !== null) headers[csrf.header] = token
  if (body !== undefined) headers['content-type'] = 'application/json'

  return (await request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as T
}
