/**
 * A line diff, for showing an edited prompt against the active one.
 *
 * Small on purpose. The alternative — a diff library — brings word-level
 * heuristics and patch formats for a screen that shows two versions of a prompt
 * side by side, and a prompt is a few dozen lines. The whole thing is one LCS
 * table.
 *
 * O(n·m) in lines, which is why `diffLines` refuses above `MAX_LINES` rather
 * than quietly allocating a hundred million cells: a prompt that long is a
 * mistake worth reporting, not a diff worth rendering.
 */

/** Above this, a "prompt" is something else and the table is too big. */
export const MAX_LINES = 2_000

export type DiffOp = 'same' | 'add' | 'del'

export interface DiffLine {
  op: DiffOp
  text: string
  /** 1-based line number in the old text, or null for an addition. */
  oldLine: number | null
  /** 1-based line number in the new text, or null for a deletion. */
  newLine: number | null
}

export interface DiffStat {
  added: number
  removed: number
  /** True when the two texts are identical, including trailing whitespace. */
  identical: boolean
}

export interface Diff {
  lines: DiffLine[]
  stat: DiffStat
}

/**
 * Splits into lines without inventing one.
 *
 * `''.split('\n')` is `['']`, which would make an empty prompt look like a
 * one-line prompt containing nothing — a distinction that matters when the diff
 * is what someone reads before activating a version.
 */
function toLines(text: string): string[] {
  if (text === '') return []
  return text.replace(/\r\n?/g, '\n').split('\n')
}

/**
 * Old text → new text, as a sequence of kept, added and removed lines.
 *
 * A changed line shows as a deletion followed by an addition. That is honest for
 * a prompt: pairing them into a "modified" line would need a similarity
 * threshold, and a reviewer about to activate a system prompt is better served
 * by seeing both texts than by a guess about which edit was intended.
 */
export function diffLines(before: string, after: string): Diff {
  const a = toLines(before)
  const b = toLines(after)

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    throw new Error(
      `refusing to diff ${Math.max(a.length, b.length)} lines (limit ${MAX_LINES})`,
    )
  }

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  // Built backwards so the walk forward can pick the branch that keeps the most
  // lines, which is what makes the output stable rather than greedy.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = lcs[i] as number[]
      const next = lcs[i + 1] as number[]
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number)
    }
  }

  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ op: 'same', text: a[i] as string, oldLine: i + 1, newLine: j + 1 })
      i += 1
      j += 1
      continue
    }
    // Deletion first on a tie, so a replaced line reads "was / now" rather than
    // "now / was". Arbitrary, but it has to be decided somewhere or the order
    // depends on the table.
    const keepByDeleting = (lcs[i + 1] as number[])[j] as number
    const keepByAdding = (lcs[i] as number[])[j + 1] as number
    if (keepByDeleting >= keepByAdding) {
      lines.push({ op: 'del', text: a[i] as string, oldLine: i + 1, newLine: null })
      removed += 1
      i += 1
    } else {
      lines.push({ op: 'add', text: b[j] as string, oldLine: null, newLine: j + 1 })
      added += 1
      j += 1
    }
  }
  while (i < a.length) {
    lines.push({ op: 'del', text: a[i] as string, oldLine: i + 1, newLine: null })
    removed += 1
    i += 1
  }
  while (j < b.length) {
    lines.push({ op: 'add', text: b[j] as string, oldLine: null, newLine: j + 1 })
    added += 1
    j += 1
  }

  return { lines, stat: { added, removed, identical: added === 0 && removed === 0 } }
}

/**
 * The diff as unified text, for a log line or a CLI.
 *
 * No hunk headers and no context trimming: the whole prompt is the context, and
 * a `@@` header would imply a patch this is not meant to be applied as.
 */
export function formatDiff(diff: Diff): string {
  return diff.lines
    .map((line) => `${line.op === 'add' ? '+' : line.op === 'del' ? '-' : ' '}${line.text}`)
    .join('\n')
}
