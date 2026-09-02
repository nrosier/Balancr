/**
 * The renderer that puts model-written text on a page.
 *
 * Two kinds of assertion, and only the first kind is load-bearing: whatever the
 * input, the output contains no tag outside `ALLOWED_TAGS` and no attribute at
 * all. The formatting tests exist so that holding that line does not quietly cost
 * the narrative its paragraphs.
 */
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_TAGS,
  escapeHtml,
  isBlankMarkdown,
  renderMarkdown,
} from '../../src/util/markdown.ts'

/** Every tag name the html actually contains. */
const tagsIn = (html: string): string[] => [
  ...new Set([...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map((match) => match[1] as string)),
]

describe('escapeHtml', () => {
  it('escapes every character that could start markup', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    )
  })
})

describe('renderMarkdown as a sanitiser', () => {
  it('escapes a script tag rather than emitting one', () => {
    const html = renderMarkdown('Spending rose <script>alert(1)</script> in March.')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
    expect(tagsIn(html)).toEqual(['p'])
  })

  it('emits no attribute, for any tag, ever', () => {
    // The property that makes this safe without an attribute allowlist: no branch
    // in the renderer writes one, so `href`/`onerror`/`style` cannot appear.
    const html = renderMarkdown(
      '### <img src=x onerror="alert(1)">\n\n- [click](javascript:alert(1))\n\n`<b style="x">`',
    )
    expect(html).not.toMatch(/<[a-zA-Z][a-zA-Z0-9-]*\s/)
  })

  it('keeps every tag it emits inside the allowlist, on hostile input', () => {
    const nasty = [
      '# Heading <iframe src=evil>',
      '',
      '> quoted <svg/onload=1>',
      '',
      '1. **bold <object>** and _em <embed>_',
      '2. `code <link>`',
      '',
      '[label](http://evil.example) ![alt](http://evil.example/x.png)',
    ].join('\n')
    for (const tag of tagsIn(renderMarkdown(nasty))) {
      expect(ALLOWED_TAGS).toContain(tag)
    }
  })

  it('drops a link target and keeps its label', () => {
    const html = renderMarkdown('See [the report](https://evil.example/steal) for detail.')
    expect(html).toBe('<p>See the report for detail.</p>')
  })

  it('reduces an image to its alt text', () => {
    expect(renderMarkdown('![a chart](https://evil.example/x.png)')).toBe('<p>a chart</p>')
  })

  it('strips control characters instead of passing them through', () => {
    const nul = String.fromCharCode(0)
    const esc = String.fromCharCode(27)
    expect(renderMarkdown(`Groceries ${nul}rose again${esc}[31m.`)).toBe(
      '<p>Groceries rose again[31m.</p>',
    )
  })

  it('cannot be made to forge the code-span placeholder', () => {
    // The placeholder contains `<`, which escaping has already removed from the
    // input by the time it is inserted.
    expect(renderMarkdown('<code-hold:0> and `real`')).toBe(
      '<p>&lt;code-hold:0&gt; and <code>real</code></p>',
    )
  })
})

describe('renderMarkdown formatting', () => {
  it('joins wrapped lines into one paragraph and splits on a blank line', () => {
    expect(renderMarkdown('One line\nand its wrap.\n\nA second thought.')).toBe(
      '<p>One line and its wrap.</p>\n<p>A second thought.</p>',
    )
  })

  it('renders every heading level as h3', () => {
    expect(renderMarkdown('# One\n## Two\n###### Six')).toBe(
      '<h3>One</h3>\n<h3>Two</h3>\n<h3>Six</h3>',
    )
  })

  it('separates a heading from the paragraph on the next line', () => {
    expect(renderMarkdown('### March\nSpending was flat.')).toBe(
      '<h3>March</h3>\n<p>Spending was flat.</p>',
    )
  })

  it('renders a bulleted list, whatever the marker', () => {
    expect(renderMarkdown('- one\n* two\n+ three')).toBe(
      '<ul><li>one</li><li>two</li><li>three</li></ul>',
    )
  })

  it('renders an ordered list', () => {
    expect(renderMarkdown('1. one\n2) two')).toBe('<ol><li>one</li><li>two</li></ol>')
  })

  it('keeps two lists apart when a blank line separates them', () => {
    expect(renderMarkdown('- a\n\n- b')).toBe('<ul><li>a</li></ul>\n<ul><li>b</li></ul>')
  })

  it('switches list type without a blank line', () => {
    expect(renderMarkdown('- a\n1. b')).toBe('<ul><li>a</li></ul>\n<ol><li>b</li></ol>')
  })

  it('appends a wrapped line to the item above it', () => {
    expect(renderMarkdown('- an item that\n  runs on')).toBe(
      '<ul><li>an item that runs on</li></ul>',
    )
  })

  it('renders emphasis, strong and code', () => {
    expect(renderMarkdown('**bold**, *italic*, _also italic_, `code`')).toBe(
      '<p><strong>bold</strong>, <em>italic</em>, <em>also italic</em>, <code>code</code></p>',
    )
  })

  it('does not read emphasis inside a code span', () => {
    expect(renderMarkdown('`**not bold**`')).toBe('<p><code>**not bold**</code></p>')
  })

  it('leaves snake_case_words alone', () => {
    expect(renderMarkdown('the over_available signal')).toBe('<p>the over_available signal</p>')
  })

  it('leaves an unmatched marker as text', () => {
    expect(renderMarkdown('2 * 3 and a stray _')).toBe('<p>2 * 3 and a stray _</p>')
  })

  it('strips a quote marker rather than rendering a blockquote', () => {
    expect(renderMarkdown('> an aside')).toBe('<p>an aside</p>')
  })

  it('handles CRLF the way it handles LF', () => {
    expect(renderMarkdown('one\r\n\r\ntwo')).toBe('<p>one</p>\n<p>two</p>')
  })

  it('escapes an ampersand in ordinary prose', () => {
    expect(renderMarkdown('AT&T and "quotes"')).toBe('<p>AT&amp;T and &quot;quotes&quot;</p>')
  })

  it('returns an empty string for empty input', () => {
    expect(renderMarkdown('   \n\n  ')).toBe('')
  })
})

describe('isBlankMarkdown', () => {
  it('is true for whitespace, which is what an empty model answer looks like', () => {
    expect(isBlankMarkdown('  \n\n \t ')).toBe(true)
  })

  it('is false for a stray marker, because a marker with nothing after it is text', () => {
    expect(isBlankMarkdown('###')).toBe(false)
  })

  it('is false as soon as there is a sentence', () => {
    expect(isBlankMarkdown('# A month')).toBe(false)
  })
})
