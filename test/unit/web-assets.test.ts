/**
 * The bundle guard, tested against fixtures.
 *
 * `scripts/check-web-assets.mjs` is the only thing standing between a build and a
 * Content-Security-Policy violation that ships. A guard nobody exercises is a guard
 * that quietly stops catching things — a regex that no longer matches Vite's output
 * format reports success forever, which is exactly the failure the script exists to
 * prevent, one level up.
 *
 * So each case below writes a small bundle that breaks one rule and asserts the script
 * fails on it, plus one clean bundle it must accept. It runs the real script as a
 * subprocess rather than importing it, because the exit code *is* the contract: that
 * is what `npm run build:web` reacts to.
 */
import { execFileSync } from 'node:child_process'
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../../scripts/check-web-assets.mjs', import.meta.url))

const CLEAN_HTML = [
  '<!doctype html>',
  '<html lang="en"><head>',
  '<link rel="icon" href="/assets/favicon-abc.svg">',
  '<script type="module" src="/assets/index-abc.js"></script>',
  '<link rel="stylesheet" href="/assets/index-abc.css">',
  '</head><body><div id="root"></div></body></html>',
].join('\n')

const CLEAN_CSS = "@font-face{font-family:X;src:url(/assets/inter-abc.woff2) format('woff2')}"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Bundle {
  html?: string
  css?: string
  /** Set false to leave the font out, which is itself a failure. */
  font?: boolean
}

function bundle({ html = CLEAN_HTML, css = CLEAN_CSS, font = true }: Bundle = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'balancr-assets-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'index.html'), html)
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'index-abc.css'), css)
  writeFileSync(join(dir, 'assets', 'index-abc.js'), 'export{}\n')
  if (font) writeFileSync(join(dir, 'assets', 'inter-abc.woff2'), 'not really a font')
  return dir
}

/** The script's exit status and combined output. */
function check(dir: string): { ok: boolean; output: string } {
  // `stdio` spelled out because `execFileSync` inherits stderr by default, and most of
  // these cases are supposed to fail — the run would print ten policy violations that
  // are the test passing, which is how a CI log becomes unreadable.
  const options: ExecFileSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }
  try {
    return { ok: true, output: execFileSync('node', [script, dir], options) }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string }
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

describe('a bundle that obeys the policy', () => {
  it('passes', () => {
    const result = check(bundle())
    expect(result.output).toContain('check-web-assets ok')
    expect(result.ok).toBe(true)
  })

  it('passes with the comment that names the tags it forbids', () => {
    // `web/index.html` carries a comment explaining why it has no inline script or
    // style — and the comment contains those words. Matching the raw file would report
    // the documentation as the violation it documents.
    const html = CLEAN_HTML.replace(
      '<head>',
      '<head><!-- no inline <script> and no inline <style> here -->',
    )
    expect(check(bundle({ html })).ok).toBe(true)
  })
})

describe('what it must refuse', () => {
  it('an inline script', () => {
    const html = CLEAN_HTML.replace('</head>', '<script>window.x=1</script></head>')
    const result = check(bundle({ html }))
    expect(result.ok).toBe(false)
    expect(result.output).toContain('inline <script>')
  })

  it('an inline style element', () => {
    const html = CLEAN_HTML.replace('</head>', '<style>body{margin:0}</style></head>')
    const result = check(bundle({ html }))
    expect(result.ok).toBe(false)
    expect(result.output).toContain('inline <style>')
  })

  it('a script from another origin', () => {
    const html = CLEAN_HTML.replace('/assets/index-abc.js', 'https://cdn.example.com/react.js')
    const result = check(bundle({ html }))
    expect(result.ok).toBe(false)
    expect(result.output).toContain('external reference')
  })

  it('a protocol-relative reference, which is external too', () => {
    const html = CLEAN_HTML.replace('/assets/index-abc.css', '//cdn.example.com/app.css')
    const result = check(bundle({ html }))
    expect(result.ok).toBe(false)
    expect(result.output).toContain('external reference')
  })

  it('a font inlined as a data: URI', () => {
    // What `assetsInlineLimit: 0` prevents. Deleting that line from vite.config.ts is
    // not a syntax error and no other test would notice.
    const css = "@font-face{font-family:X;src:url(data:font/woff2;base64,d09GMg==)}"
    const result = check(bundle({ css }))
    expect(result.ok).toBe(false)
    expect(result.output).toContain('inlined data: URI')
  })

  it('a stylesheet reaching for a remote font', () => {
    const css = '@font-face{font-family:X;src:url(https://fonts.gstatic.com/s/inter.woff2)}'
    const result = check(bundle({ css }))
    expect(result.ok).toBe(false)
    expect(result.output).toContain('external url(')
  })

  it('an external @import', () => {
    const css = `@import url('https://fonts.googleapis.com/css2?family=Inter');\n${CLEAN_CSS}`
    const result = check(bundle({ css }))
    expect(result.ok).toBe(false)
    expect(result.output).toContain('external @import')
  })

  it('a bundle with no font file at all', () => {
    // Every prohibition above can pass while the UI silently falls back to a system
    // font, so the guard also asserts the positive.
    const result = check(bundle({ font: false }))
    expect(result.ok).toBe(false)
    expect(result.output).toContain('no .woff2')
  })

  it('a directory that was never built', () => {
    const result = check(join(tmpdir(), 'balancr-assets-does-not-exist'))
    expect(result.ok).toBe(false)
    expect(result.output).toContain('does not exist')
  })

  it('a bundle with no index.html', () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancr-assets-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'stray.txt'), 'x')
    const result = check(dir)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('no index.html')
  })
})
