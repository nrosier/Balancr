/**
 * Reading a hand-edited YAML file, and failing usefully when it is wrong.
 *
 * Two of Balancr's inputs are files a person writes in an editor rather than settings a
 * form produces: the fund universe (#40) and the Belgian tax rules (#42). Both are read
 * fresh per use so an edit needs no restart, both are validated by a Zod schema, and
 * both fail in the same three ways — the path points at nothing, the YAML does not
 * parse, or it parses into something the schema refuses.
 *
 * This is those three failures, said once. It matters that the messages are identical in
 * shape because they are read in the same situation by the same person: the path is
 * named every time (the most common mistake is an env var pointing somewhere other than
 * the file being edited), a YAML error carries the line and column (the alternative,
 * "invalid YAML" against eighty entries, is not a message), and a schema failure is
 * prettified rather than dumped as a Zod issue tree.
 *
 * It returns a result rather than throwing so each caller keeps its own error type: a
 * broken fund list and a broken tax table are different problems with different
 * consequences, and the code that catches them should be able to say which it caught.
 */
import { readFileSync } from 'node:fs'
import { parse as parseYaml, YAMLParseError } from 'yaml'
import { z } from 'zod'

export type YamlFileResult<T> =
  /** Parsed and valid. */
  | { readonly kind: 'ok'; readonly value: T }
  /** No file at that path — a fact, not necessarily a mistake. */
  | { readonly kind: 'absent' }
  /** A file that cannot be used, with a sentence naming the path and the reason. */
  | { readonly kind: 'problem'; readonly message: string }

/**
 * Reads `path`, parses it as YAML, and validates it against `schema`.
 *
 * `describe` is the file's name in prose — "fund universe", "tax rules" — and appears in
 * every message, because a deployment reads more than one of these and the path alone
 * does not always say which one broke.
 *
 * An empty file yields `emptyValue` when one is given, and a schema failure otherwise.
 * Emptying a file is a deliberate act with an obvious intent ("no funds"), and only the
 * caller knows whether that intent is expressible.
 */
export function readYamlFile<T>(
  path: string,
  schema: z.ZodType<T>,
  describe: string,
  options: { emptyValue?: T } = {},
): YamlFileResult<T> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return {
      kind: 'problem',
      message: `cannot read the ${describe} at ${path}: ${reason(error)}`,
    }
  }

  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (error) {
    // A YAML error knows the line and column; passing that through is the difference
    // between a fixable message and "invalid YAML" against a file of eighty entries.
    const where =
      error instanceof YAMLParseError && error.linePos !== undefined
        ? ` at line ${error.linePos[0].line}, column ${error.linePos[0].col}`
        : ''
    return { kind: 'problem', message: `${path} is not valid YAML${where}: ${reason(error)}` }
  }

  // An empty file parses to null. Whether that is expressible is the caller's call.
  if ((raw === null || raw === undefined) && options.emptyValue !== undefined) {
    return { kind: 'ok', value: options.emptyValue }
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    return {
      kind: 'problem',
      message: `${path} is not a valid ${describe}:\n${z.prettifyError(parsed.error)}`,
    }
  }
  return { kind: 'ok', value: parsed.data }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
