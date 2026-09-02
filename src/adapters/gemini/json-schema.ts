/**
 * Gemini's JSON-schema dialect, and the filter that keeps Balancr inside it.
 *
 * `responseJsonSchema` is not draft-7. It accepts a documented subset of keywords
 * and rejects the entire request — `400 INVALID_ARGUMENT`, naming nothing — the
 * moment it meets one outside that subset. Zod emits correct draft-7, and correct
 * draft-7 includes four keywords Gemini has never accepted: `$schema`, `default`,
 * `minLength` and `maxLength`. That mismatch is why every structured analysis call
 * failed while the free-text narrative call in the same pass succeeded ([#96]).
 *
 * So the schema is emitted as draft-7 and narrowed here. An allowlist rather than
 * a denylist of those four: the failure costs a whole run and reports no keyword,
 * so the next Zod version emitting a fifth must not be able to break it.
 *
 * Nothing is lost by dropping them. `minLength` and `maxLength` are re-checked by
 * `parseAnalysisResponse` against the same Zod schema the wire schema was
 * generated from — and that check, not the model's cooperation, is what decides
 * whether a response is used. `default` has no meaning in a response contract,
 * and `$schema` is metadata about the dialect being narrowed away.
 *
 * **That was only half of it.** Removing those four was not enough: the request was
 * still rejected, and the cause turned out to be a keyword Gemini does accept.
 * `maxItems: 48` on the findings array is refused on both `gemini-3.7-flash` and
 * `gemini-3.1-pro-preview`; the same schema at `maxItems: 24` is accepted, and at
 * 12. Array bounds are evidently multiplied into an internal complexity budget —
 * measured against a one-field item, the ceiling sits near `maxItems: 170`, and it
 * falls steeply as the item gains fields, which is how a cap of 48 on a four-field
 * item ends up over the line. The budget is undocumented and the rejection names
 * nothing, so any cap chosen here would be a guess that a single new finding code
 * could invalidate.
 *
 * Hence the rule this file enforces: **the wire schema carries shape and
 * vocabulary; quantities are enforced locally.** Array bounds are dropped and
 * `analysisInstruction` states the limits in prose instead, where no provider
 * budget can reject them and where exceeding one costs a re-rank rather than the
 * whole run. Scalar bounds (`minimum`, `maximum`) stay: they are cheap, they do
 * not multiply, and they were verified to pass.
 *
 * [#96]: https://github.com/nrosier/Balancr/issues/96
 */

/**
 * The keywords `responseJsonSchema` accepts.
 *
 * Copied from the SDK's own documentation of the field
 * (`node_modules/@google/genai/dist/genai.d.ts`, `GenerateContentConfig`), which
 * is the only authoritative list — the public docs describe `responseSchema`, a
 * different and narrower field. `propertyOrdering` is Gemini's own extension.
 */
export const GEMINI_SCHEMA_KEYWORDS: readonly string[] = [
  '$id',
  '$defs',
  '$ref',
  '$anchor',
  'type',
  'format',
  'title',
  'description',
  'enum',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'anyOf',
  'oneOf',
  'properties',
  'additionalProperties',
  'required',
  'propertyOrdering',
]

const ALLOWED = new Set(GEMINI_SCHEMA_KEYWORDS)

/**
 * Keywords Gemini accepts but Balancr does not send.
 *
 * Separate from the allowlist because the reason is different: these are legal,
 * and they still break the request. `maxItems` and `minItems` are multiplied into
 * an opaque schema-complexity budget, so a cap large enough to be worth stating
 * is large enough to be refused. Zod keeps enforcing them on the way back in.
 */
const OMITTED = new Set(['minItems', 'maxItems'])

/** Keywords whose value is a map of *names* to subschemas. */
const NAMED_SUBSCHEMAS = new Set(['properties', '$defs'])

/** Keywords whose value is a list of subschemas. */
const SUBSCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'prefixItems'])

/** Keywords whose value is a single subschema, or `true`/`false`. */
const SUBSCHEMAS = new Set(['items', 'additionalProperties'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Strips every keyword Gemini does not accept, plus the two it accepts but chokes
 * on, recursively.
 *
 * Position-aware rather than a blind key sweep, because `properties` and `$defs`
 * are keyed by *names* the author chose: a category field legitimately called
 * `default` must survive, while a `default` keyword sitting beside it must not.
 * `enum` and `required` values are data and are copied untouched — an enum whose
 * members happen to spell schema keywords is still just a list of strings.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return schema

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (!ALLOWED.has(key) || OMITTED.has(key)) continue

    if (NAMED_SUBSCHEMAS.has(key) && isRecord(value)) {
      const inner: Record<string, unknown> = {}
      for (const [name, sub] of Object.entries(value)) inner[name] = toGeminiSchema(sub)
      out[key] = inner
    } else if (SUBSCHEMA_LISTS.has(key) && Array.isArray(value)) {
      out[key] = value.map(toGeminiSchema)
    } else if (SUBSCHEMAS.has(key)) {
      out[key] = Array.isArray(value) ? value.map(toGeminiSchema) : toGeminiSchema(value)
    } else {
      out[key] = value
    }
  }
  return out
}
