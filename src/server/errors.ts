/**
 * What the client is told when something goes wrong.
 *
 * Fastify's default error response echoes the thrown error's message. For a
 * validation error that is harmless; for an unexpected one it is a leak, because
 * the messages this application can throw include SQLite constraint text with
 * column names, `better-sqlite3` file paths, and upstream failures that name the
 * internal host and port of Actual or Ghostfolio. None of that belongs in a
 * response body on an internet-facing deployment.
 *
 * So the rule here is inverted from the default: a message reaches the client
 * only when the code deliberately chose it (`HttpError`). Everything else becomes
 * one flat sentence, and the detail goes to the log where it is useful.
 *
 * Every response carries the request id, which is what makes that trade
 * workable: "something went wrong, id abc123" is enough for the owner to find the
 * real error in the log without it being readable by anyone who reaches the
 * endpoint.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * The error codes a client may branch on.
 *
 * A closed set for the same reason the finding codes are: a client that switches
 * on a string needs the set to be stable, and an ad-hoc code invented at a call
 * site is one nothing renders.
 */
export const ERROR_CODES = [
  'bad_request',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'internal_error',
  'unavailable',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ErrorBody {
  error: {
    code: ErrorCode
    /** Safe to show a person: chosen by the code that threw, never an exception. */
    message: string
    /** Correlates with the log line that holds the real cause. */
    requestId: string
  }
}

/**
 * An error whose message is deliberate and may be shown.
 *
 * `details` is logged and never serialised — it exists so a throw site can record
 * why without having to decide whether the why is safe to publish.
 */
export class HttpError extends Error {
  readonly statusCode: number
  readonly code: ErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'HttpError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>): HttpError =>
  new HttpError(400, 'bad_request', message, details)

export const unauthenticated = (message = 'Sign in to continue.'): HttpError =>
  new HttpError(401, 'unauthenticated', message)

export const forbidden = (message = 'Not allowed.'): HttpError =>
  new HttpError(403, 'forbidden', message)

export const notFound = (message = 'Not found.'): HttpError =>
  new HttpError(404, 'not_found', message)

export const conflict = (message: string): HttpError => new HttpError(409, 'conflict', message)

const body = (code: ErrorCode, message: string, requestId: string): ErrorBody => ({
  error: { code, message, requestId },
})

/**
 * Maps a status code to a code and a sentence for errors that did not choose one.
 *
 * Fastify and its plugins throw plain errors carrying a `statusCode` — a 429 from
 * the rate limiter, a 400 from schema validation. Those statuses are trustworthy;
 * the messages attached to them are not necessarily ours, so they are replaced.
 */
function fromStatus(statusCode: number): { code: ErrorCode; message: string } {
  if (statusCode === 400) return { code: 'bad_request', message: 'The request was not valid.' }
  if (statusCode === 401) return { code: 'unauthenticated', message: 'Sign in to continue.' }
  if (statusCode === 403) return { code: 'forbidden', message: 'Not allowed.' }
  if (statusCode === 404) return { code: 'not_found', message: 'Not found.' }
  if (statusCode === 409) {
    return { code: 'conflict', message: 'That conflicts with the current state.' }
  }
  if (statusCode === 429) {
    return { code: 'rate_limited', message: 'Too many requests. Try again shortly.' }
  }
  if (statusCode === 503) return { code: 'unavailable', message: 'Temporarily unavailable.' }
  return { code: 'internal_error', message: 'Something went wrong.' }
}

/**
 * The single error responder.
 *
 * A 5xx is logged at error with the exception attached; a 4xx at info, because a
 * bad request is the client's problem and a log that treats it as the server's
 * fills with other people's typos. `validation` is logged rather than returned for
 * the reason above: a schema path names an internal field.
 */
export function errorHandler(
  error: FastifyError | HttpError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof HttpError) {
    request.log.info(
      { code: error.code, statusCode: error.statusCode, details: error.details },
      error.message,
    )
    void reply.status(error.statusCode).send(body(error.code, error.message, request.id))
    return
  }

  const statusCode =
    typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600
      ? error.statusCode
      : 500
  const mapped = fromStatus(statusCode)

  if (statusCode >= 500) {
    request.log.error({ err: error, statusCode }, 'request failed')
  } else {
    request.log.info(
      { err: error.message, statusCode, validation: error.validation },
      'request rejected',
    )
  }

  void reply.status(statusCode).send(body(mapped.code, mapped.message, request.id))
}

/** A missing route answers in the same envelope as everything else. */
export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  request.log.info({ url: request.url, method: request.method }, 'no route')
  void reply.status(404).send(body('not_found', 'Not found.', request.id))
}

/**
 * `notFound` is a parameter because the SPA has to widen it: an unknown path that a
 * browser is navigating to must be answered with `index.html`, not with this
 * envelope. Fastify permits exactly one not-found handler per prefix and throws on
 * the second, so the two cannot simply both be registered — `spaNotFoundHandler`
 * wraps this one and is passed in here.
 */
export function registerErrorHandling(
  app: FastifyInstance,
  notFound: (request: FastifyRequest, reply: FastifyReply) => void = notFoundHandler,
): void {
  app.setErrorHandler(errorHandler)
  app.setNotFoundHandler(notFound)
}
