/**
 * A hash of the exact payload a Gemini call sends (or would send), so a later
 * attempt can tell whether anything has actually changed since a past one
 * without re-reading it byte for byte (#160).
 */
import { createHash } from 'node:crypto'

export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}
