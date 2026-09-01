/**
 * Belgian currency formatting separates the symbol with a NARROW NO-BREAK SPACE
 * (U+202F) or NO-BREAK SPACE (U+00A0), not an ordinary space. Assertions that
 * compare against a typed literal must normalise, or they fail on two strings
 * that are visually identical — which costs an hour every time.
 */
export function norm(value: string): string {
  return value.replace(/[   ]/g, ' ')
}
