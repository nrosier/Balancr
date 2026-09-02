/**
 * Fails the build if `dist/web` would violate the Content-Security-Policy.
 *
 * The policy in `src/server/security.ts` permits no external origin and has no
 * `'unsafe-inline'`. Nothing in the toolchain enforces that: a stray `<style>` in
 * `index.html`, a font Vite decided to inline as a `data:` URI, or a stylesheet
 * pointing at `fonts.googleapis.com` all build cleanly and then fail in the browser —
 * silently, because a blocked resource is a console message and a slightly wrong page,
 * not an error anyone is told about. This is the check that turns that into a red CI
 * run.
 *
 * It reads the *output*, not the source, which is the point. `assetsInlineLimit: 0`
 * being deleted from `vite.config.ts` is not a syntax error and no test would notice;
 * the inlined font in the emitted CSS is what proves it happened.
 *
 * Scope, stated honestly: this checks the HTML entry document and every emitted
 * stylesheet, which is where an external origin or an inline block can actually get
 * in. It does not attempt to prove that no JavaScript anywhere in the bundle contains
 * a URL — `http://www.w3.org/2000/svg` appears in every SVG library and a licence
 * header names a repository, so a scan of the JavaScript would be all false positives
 * and would be silenced within a week. `connect-src 'self'` is what enforces that at
 * runtime, and it cannot be argued with.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// A directory may be passed, which is how `test/unit/web-assets.test.ts` points it at
// fixtures. A guard nothing exercises is a guard nobody knows is broken.
const root =
  process.argv[2] === undefined
    ? fileURLToPath(new URL('../dist/web/', import.meta.url))
    : resolve(process.argv[2])
const problems = []

/** Every file under `dir`, recursively, as absolute paths. */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

const fail = (file, message) => problems.push(`${relative(root, file)}: ${message}`)

let files
try {
  files = walk(root)
} catch {
  console.error(`check-web-assets: ${root} does not exist — run \`npm run build:web\` first.`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
//  The entry document
// ---------------------------------------------------------------------------

const indexPath = join(root, 'index.html')
if (!files.includes(indexPath)) {
  console.error('check-web-assets: no index.html in the bundle.')
  process.exit(1)
}
// Comments are stripped before anything is matched. `index.html` carries a comment
// explaining why it has no inline script or style — and it says the words "<script>"
// and "<style>", so scanning the raw file finds the documentation and reports the
// thing it documents the absence of. Markup inside a comment is inert, so removing it
// loses nothing.
const html = readFileSync(indexPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '')

// A `<script>` with no `src` is code in the document, which `script-src 'self'`
// refuses. `[^>]*` cannot cross the tag, so `<script src=…>` is not matched.
for (const tag of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>/gi)) {
  fail(indexPath, `inline <script> at offset ${String(tag.index)}`)
}
if (/<style[\s>]/i.test(html)) fail(indexPath, 'inline <style> element')

// Every reference must be same-origin. `//example.com/x` is protocol-relative and
// external, which is why the test is not simply "starts with a slash".
for (const match of html.matchAll(/\s(?:src|href)=["']([^"']*)["']/gi)) {
  const target = match[1] ?? ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) {
    fail(indexPath, `external reference ${match[0].trim()}`)
  }
}

// ---------------------------------------------------------------------------
//  The stylesheets
// ---------------------------------------------------------------------------

for (const file of files.filter((path) => path.endsWith('.css'))) {
  const css = readFileSync(file, 'utf8')
  for (const match of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
    const target = (match[1] ?? '').trim()
    if (target.startsWith('data:')) {
      // The specific case that matters: `font-src 'self'` refuses a `data:` font, and
      // Vite inlines small assets by default. See `assetsInlineLimit` in vite.config.
      fail(file, `inlined data: URI in url() — ${target.slice(0, 32)}…`)
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) {
      fail(file, `external url(${target})`)
    }
  }
  if (/@import\s+(?:url\()?['"]?(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(css)) {
    fail(file, 'external @import')
  }
}

// ---------------------------------------------------------------------------
//  The font really is a file
// ---------------------------------------------------------------------------

// A positive assertion rather than another prohibition: if the variable font were
// inlined or dropped, every check above could still pass while the UI fell back to a
// system font. One emitted `.woff2` is the proof that it did not.
if (!files.some((path) => path.endsWith('.woff2'))) {
  problems.push('no .woff2 in the bundle — the variable font was not emitted as a file')
}

if (problems.length > 0) {
  console.error('check-web-assets: the bundle violates the content-security-policy\n')
  for (const problem of problems) console.error(`  ✗ ${problem}`)
  console.error(`\n${String(problems.length)} problem(s). See src/server/security.ts.`)
  process.exit(1)
}

console.log(`check-web-assets ok — ${String(files.length)} files, no external origin, nothing inline`)
