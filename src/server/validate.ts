/**
 * Request bodies, and why parsing one needs a helper at all.
 *
 * A `ZodError` thrown out of a handler is an unhandled exception: `errorHandler`
 * has no reason to treat it as anything but a bug and answers 500. That is exactly
 * backwards for a settings form — a threshold outside its range is the client's
 * mistake and has to come back as a 400 the form can show next to the field.
 *
 * The field paths are returned to the client, unlike Fastify's own schema validation
 * (see `errors.ts`, where a validation path is logged rather than sent). The
 * difference is what the paths name: these schemas describe the *request body the
 * client just built*, so `baseline.halfLifeMonths` is the client's own field name,
 * not an internal one. Nothing is disclosed that the sender did not send.
 */
import { z } from 'zod'
import { invalidBody, type FieldIssue } from './errors.ts'

/**
 * A `ZodError` as a flat list of field paths.
 *
 * Flat rather than `z.treeifyError`'s nested shape, and one entry per issue rather
 * than `z.prettifyError`'s single block of text: a form needs to put a message next
 * to a field, and both of the alternatives make that the client's parsing problem.
 *
 * An issue with no path — a cross-field rule that names the object itself — keeps an
 * empty path rather than being dropped. It is still the reason the request failed.
 */
export function fieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
  }))
}

/** Parses a request body, or throws a 400 naming the fields that were wrong. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (parsed.success) return parsed.data
  throw invalidBody('The request body was not valid.', fieldIssues(parsed.error))
}
