/**
 * A very small Markdown renderer, for exactly one input: model-written prose.
 *
 * The monthly narrative is the only free text in Balancr, and it arrives from a
 * language model that was handed data originating in a bank feed. So this is a
 * sanitiser first and a renderer second, and it is written rather than installed
 * for two reasons: the app ships no CDN and no runtime download, and a general
 * Markdown library plus a general HTML sanitiser is a large amount of behaviour
 * to reason about for a page that shows six paragraphs.
 *
 * The safety argument is the ordering. Every character of input is HTML-escaped
 * *before* a single tag is produced, so there is no path by which input becomes
 * markup: the tags in the output are only ever the ones this file writes, and
 * `ALLOWED_TAGS` is therefore the complete list of what can appear. Nothing here
 * parses or emits an attribute, which is what removes the whole `href`/`onerror`
 * class of problem rather than filtering it.
 *
 * Link syntax collapses to its label. A narrative has no business linking
 * anywhere — the prompt forbids URLs and product names — and a model that
 * produces one is either hallucinating a source or repeating something out of the
 * data. Either way the label is the part worth reading.
 */

/**
 * Every tag this module can emit. Exported so a test can assert the output
 * contains nothing else, which is the property that makes the renderer safe
 * rather than the individual regexes.
 */
export const ALLOWED_TAGS: readonly string[] = ['h3', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'code']

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** The one function every other line of this file depends on running first. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] as string)
}

const TAB = 9
const NEWLINE = 10
const SPACE = 32
const DELETE = 127

/**
 * Control characters, stripped before anything else looks at the text.
 *
 * Tab and newline survive because they carry block structure; the rest have no
 * meaning in a narrative, and every one of them is a way to make two strings that
 * read alike compare differently. Written as codepoint arithmetic rather than as a
 * character class so that the source of a sanitiser contains no control character
 * of its own.
 */
function stripControl(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? SPACE
    if (code === TAB || code === NEWLINE || (code >= SPACE && code !== DELETE)) out += char
  }
  return out
}

const HEADING = /^#{1,6}\s+(.+)$/
const BULLET = /^[-*+]\s+(.+)$/
const ORDERED = /^\d{1,3}[.)]\s+(.+)$/
const QUOTE = /^>\s?(.*)$/

/**
 * The placeholder that stands in for a code span while emphasis is applied.
 *
 * It contains `<`, which is what makes it safe: escaping has already turned every
 * `<` in the input into `&lt;`, so this marker cannot be forged by the text being
 * rendered.
 */
const hold = (index: number): string => `<code-hold:${index}>`
const HELD = /<code-hold:(\d+)>/g

/**
 * Inline markup on one already-joined block of text.
 *
 * Code spans are lifted out first and put back last, so `` `**not bold**` ``
 * stays literal — the usual reason a hand-rolled renderer gets emphasis wrong.
 */
function inline(text: string): string {
  const held: string[] = []
  let out = escapeHtml(text).replace(/`([^`\n]+)`/g, (_match, code: string) => {
    held.push(code)
    return hold(held.length - 1)
  })

  // Images before links: `![alt](src)` is link syntax with a prefix, so the link
  // rule would otherwise leave a stray `!`.
  out = out.replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
  out = out.replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')

  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
  // The leading group keeps `**bold**` from being re-read as `*` + `*bold*`, and
  // the `_` rule requires a non-word boundary so `snake_case_words` survives.
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')

  return out.replace(HELD, (_match, index: string) => `<code>${held[Number(index)] ?? ''}</code>`)
}

type BlockKind = 'p' | 'ul' | 'ol'

/**
 * One rendered block. A heading holds a single line; the others hold their lines,
 * which for a paragraph are joined with a space and for a list are one per item.
 */
type Token = { kind: 'h3'; text: string } | { kind: BlockKind; parts: string[] }

/**
 * Lines → blocks.
 *
 * Line-driven rather than blank-line-delimited, because a model writes a heading
 * and its paragraph on consecutive lines about as often as it leaves a blank line
 * between them, and the second reading should not produce an `<h3>` containing the
 * whole month.
 */
function tokenize(lines: readonly string[]): Token[] {
  const tokens: Token[] = []
  // What the previous non-blank line opened. A blank line closes it, which is what
  // separates two adjacent paragraphs or two adjacent lists.
  let open: BlockKind | null = null

  for (const raw of lines) {
    // A quote marker is stripped rather than rendered: the narrative has nobody to
    // quote, and `> ` is how a model indents an aside.
    const line = raw.trim().replace(QUOTE, '$1').trim()
    if (line === '') {
      open = null
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      tokens.push({ kind: 'h3', text: heading[1] as string })
      open = null
      continue
    }

    const bullet = BULLET.exec(line)
    const ordered = bullet === null ? ORDERED.exec(line) : null
    const kind: BlockKind = bullet !== null ? 'ul' : ordered !== null ? 'ol' : 'p'
    const part = (bullet?.[1] ?? ordered?.[1] ?? line) as string

    const last = tokens[tokens.length - 1]
    if (last === undefined || last.kind === 'h3' || open === null) {
      tokens.push({ kind, parts: [part] })
      open = kind
      continue
    }

    // A wrapped line inside a list belongs to the item above it, not to a new
    // paragraph wedged between the items.
    if (kind === 'p' && open !== 'p') {
      const index = last.parts.length - 1
      last.parts[index] = `${last.parts[index] as string} ${part}`
      continue
    }

    if (open === kind) {
      last.parts.push(part)
      continue
    }

    tokens.push({ kind, parts: [part] })
    open = kind
  }

  return tokens
}

function renderToken(token: Token): string {
  if (token.kind === 'h3') return `<h3>${inline(token.text)}</h3>`
  if (token.kind === 'p') {
    const text = inline(token.parts.join(' ').trim())
    return text === '' ? '' : `<p>${text}</p>`
  }
  const items = token.parts.map((part) => `<li>${inline(part)}</li>`).join('')
  return `<${token.kind}>${items}</${token.kind}>`
}

/**
 * Markdown → HTML.
 *
 * Every heading level renders as `<h3>`. The narrative sits inside a page that
 * already owns its own `<h1>` and `<h2>`, so a model reaching for `#` is making a
 * layout decision it has no way to make correctly.
 */
export function renderMarkdown(source: string): string {
  return tokenize(stripControl(source.replace(/\r\n?/g, '\n')).split('\n'))
    .map(renderToken)
    .filter((html) => html !== '')
    .join('\n')
}

/** True when the text carries no content once markup and whitespace are removed. */
export function isBlankMarkdown(source: string): boolean {
  return renderMarkdown(source).replace(/<[^>]*>/g, '').trim() === ''
}
