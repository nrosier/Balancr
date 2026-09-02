/**
 * Text going into a chart tooltip.
 *
 * ECharts renders a tooltip `formatter`'s return value as HTML, and the strings this
 * application puts in one include **category and account names that came from Actual**,
 * which came from a bank feed. That is the same untrusted text the AI layer refuses to
 * send to Gemini, and it has no business being parsed as markup here either.
 *
 * The Content-Security-Policy already stops the damage — it has no `'unsafe-inline'`,
 * so an injected `onerror` handler never runs, and `innerHTML` never executes a
 * `<script>` in any browser. This is the layer that stops the *display* from breaking:
 * a category called `Rent <shared>` should print its own name rather than losing half
 * of it to a tag nobody wrote.
 *
 * `&` first, or the escaping escapes itself.
 */
const REPLACEMENTS: readonly [RegExp, string][] = [
  [/&/g, '&amp;'],
  [/</g, '&lt;'],
  [/>/g, '&gt;'],
  [/"/g, '&quot;'],
  [/'/g, '&#39;'],
]

export function escapeText(value: string): string {
  let escaped = value
  for (const [pattern, entity] of REPLACEMENTS) escaped = escaped.replace(pattern, entity)
  return escaped
}

/** A tooltip row: a name and the figure beside it, both already text. */
export function tooltipRow(name: string, value: string): string {
  return `${escapeText(name)}<br><strong>${escapeText(value)}</strong>`
}
