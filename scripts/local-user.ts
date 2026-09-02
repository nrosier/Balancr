#!/usr/bin/env tsx
/**
 * `npm run auth:local -- --email you@example.com` — sets the break-glass password.
 *
 * This is a command-line tool rather than a settings screen for a reason that is
 * not laziness: the local password exists for when nobody can sign in, so it
 * cannot be set from behind a login. Running it on the host also means the TOTP
 * secret is printed to the operator's own terminal, and never into an HTTP
 * response that a reverse proxy might log.
 *
 * It writes to Balancr's own database and nothing else. Run it with the container
 * stopped, or accept that a running instance keeps serving while the password
 * changes — SQLite handles the concurrency, but a session minted a second earlier
 * stays valid either way, which is what `destroyUserSessions` would be for if this
 * were a compromise rather than a setup.
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { config } from '../src/config.ts'
import { closeDatabase, db } from '../src/db/index.ts'
import { provisionLocalCredential } from '../src/server/auth/provision.ts'

const write = (text: string): void => void stdout.write(text)
const bold = (text: string): string => `\x1b[1m${text}\x1b[0m`
const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`

/** `--email x --name "Y"` → `{ email: 'x', name: 'Y' }`. */
function parseArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined || !arg.startsWith('--')) continue
    const next = argv[i + 1]
    out[arg.slice(2)] = next === undefined || next.startsWith('--') ? 'true' : next
  }
  return out
}

/**
 * Reads a line without echoing it.
 *
 * `readline` has no hidden-input mode, so the muting is done by replacing the
 * output stream's write for the duration. Crude, and the reason it is acceptable
 * is that the alternative — a password on the command line — ends up in shell
 * history and in `ps` output for every user on the box.
 */
async function readSecret(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true })
  const muted = stdout as unknown as { write: unknown }
  const original = muted.write

  write(prompt)
  muted.write = (): boolean => true
  try {
    return await rl.question('')
  } finally {
    muted.write = original
    rl.close()
    write('\n')
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const email = args['email']

  if (email === undefined || email === 'true' || !email.includes('@')) {
    write('usage: npm run auth:local -- --email you@example.com [--name "Your Name"]\n')
    process.exitCode = 2
    return
  }

  if (!config.AUTH_LOCAL_ENABLED) {
    // Set anyway rather than refused: an operator locked out by a broken Authentik
    // will set the password first and flip the flag second, and refusing here would
    // mean editing `.env`, restarting, and only then discovering the next problem.
    write(
      dim(
        'note: AUTH_LOCAL_ENABLED is false, so the login route is not registered.\n' +
          '      Set it to true and restart before this credential can be used.\n\n',
      ),
    )
  }

  const password = await readSecret('New password: ')
  if (password.length < 12) {
    write('Refused: use at least 12 characters. It is the only thing between a\n')
    write('LAN foothold and your finances, and it is typed rarely.\n')
    process.exitCode = 2
    return
  }
  const again = await readSecret('Repeat password: ')
  if (again !== password) {
    write('Refused: those did not match.\n')
    process.exitCode = 2
    return
  }

  const name = args['name']
  const result = await provisionLocalCredential(db, {
    email,
    password,
    displayName: name === undefined || name === 'true' ? undefined : name,
  })

  write(`\n${bold(result.replaced ? 'Password replaced' : 'Local login created')}\n`)
  write(`  address   ${email}\n`)
  write(`  role      ${result.role}\n`)
  write(`  allowed   ${config.AUTH_LOCAL_ALLOWED_CIDRS.join(', ')}\n\n`)
  write(`${bold('Enrol this in your authenticator now.')} It is shown once.\n`)
  write(`  secret    ${result.totpSecret}\n`)
  write(`  uri       ${result.totpUri}\n\n`)
  write(
    dim(
      'The code is mandatory: there is no password-only local login. If you lose\n' +
        'the secret, run this again — it mints a new one along with the password.\n',
    ),
  )
}

try {
  await main()
} finally {
  closeDatabase()
}
