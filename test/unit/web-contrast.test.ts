/**
 * The contrast guard, tested against fixtures — and the real palette, tested for real.
 *
 * `scripts/check-contrast.ts` derives its pairs from the stylesheets, which is what
 * keeps it honest as components are added, and also what makes it able to quietly stop
 * finding anything: a parser that no longer recognises how a rule is written reports
 * success forever. That is the same failure the script exists to prevent, one level up.
 *
 * So each case below writes one small stylesheet and asserts the exit code, running the
 * real script as a subprocess because the exit code *is* the contract — it is what CI
 * reacts to. The last case runs it over the application's own stylesheets, so a token
 * repainted under the floor fails `npm test` rather than waiting for the gate.
 */
import { execFileSync } from 'node:child_process'
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../../scripts/check-contrast.ts', import.meta.url))
const repo = fileURLToPath(new URL('../..', import.meta.url))

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Writes `styles.css` into a throwaway directory and returns the directory. */
function sheet(css: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'balancr-contrast-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'styles.css'), css, 'utf8')
  return dir
}

const options: ExecFileSyncOptionsWithStringEncoding = {
  encoding: 'utf8',
  cwd: repo,
  stdio: ['ignore', 'pipe', 'pipe'],
}

/** Runs the check over one directory. Returns the exit code and everything it printed. */
function run(dir?: string): { code: number; output: string } {
  const args = ['tsx', script, ...(dir === undefined ? [] : [dir])]
  try {
    return { code: 0, output: execFileSync('npx', args, options) }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

describe('the contrast guard', () => {
  it('accepts a pair that clears the floor', () => {
    const css = '.ok { color: var(--text); background: var(--surface-card); }'
    const { code, output } = run(sheet(css))
    expect(output).toContain('contrast ok')
    expect(code).toBe(0)
  })

  it('fails a stated pair under the floor, and says by how much', () => {
    // A border colour is not a text colour. Someone will try it.
    const css = '.bad { color: var(--border); background: var(--surface-card); }'
    const { code, output } = run(sheet(css))
    expect(code).toBe(1)
    expect(output).toContain('--border on --surface-card')
    expect(output).toContain('needs 4.5')
  })

  it('measures a rule that sets only a colour against every canvas', () => {
    // The failure this catches is the real one: a grey that clears the white card and
    // fails the slightly darker page behind it. Naming no background must not mean
    // naming no requirement.
    const { code, output } = run(sheet('.inherited { color: var(--border); }'))
    expect(code).toBe(1)
    expect(output).toContain('--surface-page')
    expect(output).toContain('inherited')
  })

  it('exempts a foreground that is only ever painted on its own ground', () => {
    // `--accent-text` is white; requiring it against a white card would demand the
    // impossible of a pair that never renders.
    const { code } = run(sheet('.inverse { color: var(--accent-text); }'))
    expect(code).toBe(0)
  })

  it('skips a colour it cannot resolve rather than guessing at one', () => {
    // A literal, a gradient and `inherit` have no single value to measure. Passing them
    // over is the honest behaviour; the token discipline is what keeps it from mattering.
    const { code } = run(sheet('.literal { color: #999999; background: transparent; }'))
    expect(code).toBe(0)
  })

  it('holds for the application it guards, in both themes', () => {
    const { code, output } = run()
    expect(output).toContain('contrast ok')
    expect(code).toBe(0)
  })
})
