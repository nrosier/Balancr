/**
 * The `.env` permission check (#39).
 *
 * The file holds every secret this process has in plain text, and #39 asks for it at
 * `0600`. What makes the check worth writing is that the wrong mode is invisible from
 * inside the app — a `0644` `.env` works exactly as well as a `0600` one — so the only
 * way it gets noticed is if something looks.
 *
 * Real files in a temp directory rather than a mocked `statSync`: the thing under test
 * is the reading of permission bits, and a mock would assert that this file agrees with
 * itself about what `0o640` means.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { looseEnvFile, looseEnvFileMessage } from '../../src/env-file.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'balancr-env-file-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A `.env` at the given mode, and its path. */
function envAt(mode: number): string {
  const path = join(dir, '.env')
  writeFileSync(path, 'SESSION_SECRET=x\n')
  chmodSync(path, mode)
  return path
}

describe('looseEnvFile', () => {
  it('says nothing about a file at 0600', () => {
    expect(looseEnvFile(envAt(0o600))).toBeUndefined()
  })

  it('says nothing about 0400, which is tighter still', () => {
    expect(looseEnvFile(envAt(0o400))).toBeUndefined()
  })

  /**
   * The normal case in a container: compose reads `.env` on the host and passes the
   * values as environment variables, so there is no such file inside the image. A
   * warning there would be noise on every single start.
   */
  it('says nothing when the file does not exist', () => {
    expect(looseEnvFile(join(dir, 'nope'))).toBeUndefined()
  })

  it('reports a group-readable file as group, not world', () => {
    expect(looseEnvFile(envAt(0o640))).toEqual({
      path: join(dir, '.env'),
      mode: '640',
      group: true,
      world: false,
    })
  })

  it('reports the mode a human would type into chmod', () => {
    // Not the raw st_mode, which is 33188 for this file and means nothing to anyone.
    expect(looseEnvFile(envAt(0o644))?.mode).toBe('644')
  })

  it('reports world-readable, the case nobody chooses deliberately', () => {
    const finding = looseEnvFile(envAt(0o644))
    expect(finding?.world).toBe(true)
    expect(finding?.group).toBe(true)
  })

  /** A `.env` someone else can rewrite is a `.env` that can point Balancr elsewhere. */
  it('counts a write bit with no read bit', () => {
    const finding = looseEnvFile(envAt(0o602))
    expect(finding?.mode).toBe('602')
    expect(finding?.world).toBe(true)
  })
})

describe('looseEnvFileMessage', () => {
  it('carries the command that fixes it', () => {
    const finding = looseEnvFile(envAt(0o644))
    expect(finding).toBeDefined()
    const message = looseEnvFileMessage(finding as NonNullable<typeof finding>)
    expect(message).toContain('chmod 600')
    expect(message).toContain('every user on this host')
  })

  it('does not overstate a group-readable file as world-readable', () => {
    const finding = looseEnvFile(envAt(0o640))
    const message = looseEnvFileMessage(finding as NonNullable<typeof finding>)
    expect(message).toContain("this file's group")
    expect(message).not.toContain('every user')
  })
})
