/**
 * ISIN validation (#40).
 *
 * An ISIN is twelve characters — two-letter country prefix, nine alphanumerics of
 * national identifier, and one check digit that is a function of the other eleven.
 * That last character is why this file exists: it turns a mistyped instrument from a
 * silent wrong answer into a refusal at load time.
 *
 * The failure it prevents is specific. A fund universe is typed by hand from a KID,
 * and a transposed pair in `IE00B4L5Y983` produces a string that looks exactly as
 * plausible as the real one. Without the check digit the universe accepts it, advice
 * proposes it, and the order lands on whatever instrument happens to own that ISIN —
 * or on nothing, which is the good case. Roughly nine in ten single-character typos
 * and every transposition of unequal digits fail the check digit, so this is cheap
 * insurance on the one field in the file that must be exactly right.
 *
 * What it cannot do is confirm that an ISIN belongs to the fund named beside it. A
 * valid ISIN for a different instrument passes here and always will, which is why
 * every entry also carries a `source` and a `last_verified` date — see `schema.ts`.
 */

/** Twelve characters: two letters, nine alphanumerics, one digit. */
const SHAPE = /^[A-Z]{2}[A-Z0-9]{9}\d$/

/**
 * Uppercased with spaces and separators removed, or `null` when nothing usable is left.
 *
 * ISINs are quoted with spaces (`IE00 B4L5 Y983`) on some factsheets and lowercased in
 * plenty of spreadsheets, and both mean the same instrument. Normalising here rather
 * than asking every caller to remember is what makes `lookup` and the schema agree
 * about whether two spellings are the same key.
 */
export function normaliseIsin(value: string): string | null {
  const compact = value.replace(/[\s.-]/g, '').toUpperCase()
  return compact === '' ? null : compact
}

/**
 * The check digit the first eleven characters imply.
 *
 * Letters expand to two digits (`A` → 10 … `Z` → 35) and the result runs through Luhn
 * from the right. Returns `null` when the input is not eleven usable characters, so a
 * caller cannot mistake "unparseable" for "check digit zero".
 */
export function isinCheckDigit(body: string): number | null {
  if (!/^[A-Z0-9]{11}$/.test(body)) return null

  let digits = ''
  for (const char of body) {
    digits += char >= 'A' ? String(char.charCodeAt(0) - 55) : char
  }

  // Luhn, doubling every second digit counting from the rightmost. The check digit is
  // not part of `digits`, so the rightmost expanded digit is the one that doubles.
  let sum = 0
  let double = true
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    // `digits` is all ASCII digits by construction, so the parse cannot fail.
    let value = digits.charCodeAt(index) - 48
    if (double) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    double = !double
  }

  return (10 - (sum % 10)) % 10
}

/** Whether `value` is a well-formed ISIN whose check digit agrees. */
export function isValidIsin(value: string): boolean {
  const isin = normaliseIsin(value)
  if (isin === null || !SHAPE.test(isin)) return false
  const body = isin.slice(0, 11)
  const stated = isin.charCodeAt(11) - 48
  return isinCheckDigit(body) === stated
}

/**
 * Why one ISIN was refused, in a sentence, or `null` when it is valid.
 *
 * Separate from `isValidIsin` because the two have different jobs: a predicate for
 * code, and a message for the person editing the file, who needs to know whether they
 * typed eleven characters or got the last one wrong.
 */
export function isinProblem(value: string): string | null {
  const isin = normaliseIsin(value)
  if (isin === null) return 'is empty'
  if (isin.length !== 12) return `is ${isin.length} characters, not 12`
  if (!SHAPE.test(isin)) {
    return 'is not two letters, nine alphanumerics and a digit'
  }
  const expected = isinCheckDigit(isin.slice(0, 11))
  const stated = isin.charCodeAt(11) - 48
  if (expected !== stated) {
    return `ends in ${stated} but its check digit is ${expected ?? '?'} — one character is wrong`
  }
  return null
}
