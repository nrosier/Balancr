/**
 * The diff is what someone reads before activating a system prompt, so the
 * properties that matter are about honesty rather than minimality: no line is
 * invented, no line is lost, and applying the result to the old text reproduces
 * the new one exactly.
 */
import { describe, expect, it } from 'vitest'
import { diffLines, formatDiff, MAX_LINES } from '../../src/util/diff.ts'

/** The additions and kept lines, in order, are exactly the new text. */
const rebuild = (diff: ReturnType<typeof diffLines>): string =>
  diff.lines
    .filter((line) => line.op !== 'del')
    .map((line) => line.text)
    .join('\n')

describe('diffLines', () => {
  it('reports identical texts as identical', () => {
    const diff = diffLines('one\ntwo', 'one\ntwo')
    expect(diff.stat).toEqual({ added: 0, removed: 0, identical: true })
    expect(diff.lines.every((line) => line.op === 'same')).toBe(true)
  })

  it('shows an inserted line as one addition', () => {
    const diff = diffLines('one\nthree', 'one\ntwo\nthree')
    expect(diff.stat).toEqual({ added: 1, removed: 0, identical: false })
    expect(diff.lines.map((line) => line.op)).toEqual(['same', 'add', 'same'])
    expect(rebuild(diff)).toBe('one\ntwo\nthree')
  })

  it('shows a deleted line as one deletion', () => {
    const diff = diffLines('one\ntwo\nthree', 'one\nthree')
    expect(diff.stat).toEqual({ added: 0, removed: 1, identical: false })
    expect(rebuild(diff)).toBe('one\nthree')
  })

  it('shows a changed line as a deletion then an addition', () => {
    const diff = diffLines('keep\nold\nkeep2', 'keep\nnew\nkeep2')
    expect(diff.lines.map((line) => line.op)).toEqual(['same', 'del', 'add', 'same'])
    expect(diff.stat).toEqual({ added: 1, removed: 1, identical: false })
  })

  it('numbers lines on the side they exist', () => {
    const diff = diffLines('a\nb', 'a\nc')
    const del = diff.lines.find((line) => line.op === 'del')
    const add = diff.lines.find((line) => line.op === 'add')
    expect(del).toMatchObject({ text: 'b', oldLine: 2, newLine: null })
    expect(add).toMatchObject({ text: 'c', oldLine: null, newLine: 2 })
  })

  it('keeps the common lines rather than rewriting the whole text', () => {
    const before = ['1. never invent a number', '2. prioritise', '3. be brief'].join('\n')
    const after = ['1. never invent a number', '2. prioritise ruthlessly', '3. be brief'].join('\n')
    const diff = diffLines(before, after)
    expect(diff.stat).toEqual({ added: 1, removed: 1, identical: false })
    expect(rebuild(diff)).toBe(after)
  })

  it('treats an empty text as no lines, not as one blank line', () => {
    expect(diffLines('', '').lines).toEqual([])
    expect(diffLines('', 'a').stat).toEqual({ added: 1, removed: 0, identical: false })
    expect(diffLines('a', '').stat).toEqual({ added: 0, removed: 1, identical: false })
  })

  it('normalises CRLF, so a Windows paste is not a whole-file rewrite', () => {
    expect(diffLines('a\r\nb', 'a\nb').stat.identical).toBe(true)
  })

  it('reconstructs the new text for a wholesale replacement', () => {
    const diff = diffLines('a\nb\nc', 'x\ny')
    expect(rebuild(diff)).toBe('x\ny')
    expect(diff.stat).toEqual({ added: 2, removed: 3, identical: false })
  })

  it('refuses a text longer than the LCS table is worth allocating', () => {
    const huge = Array.from({ length: MAX_LINES + 1 }, (_, i) => `line ${i}`).join('\n')
    expect(() => diffLines(huge, 'a')).toThrow(/refusing to diff/)
  })
})

describe('formatDiff', () => {
  it('prefixes each line the way a unified diff does', () => {
    const diff = diffLines('keep\nold', 'keep\nnew')
    expect(formatDiff(diff)).toBe(' keep\n-old\n+new')
  })
})
