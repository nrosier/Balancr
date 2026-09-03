/**
 * Whether the file holding every secret can be read by anyone else.
 *
 * `.env` carries the Actual password, the Ghostfolio token, the Gemini key, the session
 * secret and the backup passphrase — the whole set, in plain text, on disk. #39 asks for
 * it at `0600` and documented; documented is the README's job, and this is the part that
 * notices when reality drifted from the document. It drifts easily: a file created by a
 * text editor, copied from `.env.example`, or restored from a tarball comes out `0644` on
 * most systems, and nothing about the running app looks different afterwards.
 *
 * A warning, never a refusal. The mode of a file is not a reason to leave someone without
 * their budget page, and on a single-user host a group-readable `.env` may be a considered
 * choice. But it is said once at every start, with the mode and the fix in the line, so
 * the fix is a copy-paste rather than a search.
 *
 * Nothing is reported when the file is absent, which is the normal case in a container:
 * compose reads `.env` on the host and passes the values as environment variables, so
 * there is no such file inside the image to have a mode at all.
 */
import { statSync } from 'node:fs'

/** The default: the only env file any of the npm scripts or compose actually reads. */
export const ENV_FILE = '.env'

export interface LooseEnvFile {
  path: string
  /** The permission bits, as they would be typed into `chmod` — `644`, not `33188`. */
  mode: string
  /** Anyone in the file's group can read it. */
  group: boolean
  /** Anyone on the host can read it. */
  world: boolean
}

/**
 * The finding for one path, or nothing when there is none.
 *
 * Group and world are reported separately because they are different sentences: a
 * group-readable file may be shared with a deploy user on purpose, a world-readable one
 * on a multi-user host is not a choice anybody makes deliberately. Both are surfaced
 * rather than collapsed into "bad mode".
 *
 * Write bits count as well as read bits — a `.env` someone else can rewrite is a `.env`
 * that can point Balancr at their Ghostfolio.
 */
export function looseEnvFile(path: string = ENV_FILE): LooseEnvFile | undefined {
  let bits: number
  try {
    bits = statSync(path).mode & 0o777
  } catch {
    return undefined
  }
  const group = (bits & 0o070) !== 0
  const world = (bits & 0o007) !== 0
  if (!group && !world) return undefined
  return { path, mode: bits.toString(8).padStart(3, '0'), group, world }
}

/**
 * The line to log, kept beside the check so the wording lives with the rule it explains.
 *
 * It names the actual command, because "tighten the permissions" is advice and
 * `chmod 600 .env` is a fix.
 */
export function looseEnvFileMessage(finding: LooseEnvFile): string {
  const who = finding.world ? 'every user on this host' : "this file's group"
  return (
    `${finding.path} is mode ${finding.mode}, so ${who} can read your Actual password, ` +
    `Ghostfolio token, Gemini key and backup passphrase. Run: chmod 600 ${finding.path}`
  )
}
