/**
 * The digest email transport's TLS default (S2, 2026-09-26 review).
 *
 * Nodemailer's own default for `secure: false` is "upgrade via STARTTLS if the
 * relay offers it, otherwise send in plaintext" — and nothing in the log, job
 * detail, or UI distinguishes that fallback from a successful encrypted send.
 * `config.SMTP_REQUIRE_TLS` (default `true`) is meant to close that: this
 * asserts the value actually reaches `nodemailer.createTransport`, not just
 * that the config field itself parses.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const createTransport = vi.hoisted(() => vi.fn().mockReturnValue({ sendMail: vi.fn().mockResolvedValue({}) }))

vi.mock('nodemailer', () => ({ default: { createTransport } }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  createTransport.mockClear()
})

async function loadEmailWith(env: Record<string, string>) {
  vi.resetModules()
  vi.stubEnv('SMTP_HOST', 'smtp.example.test')
  vi.stubEnv('SMTP_FROM', 'digest@example.test')
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  await (await import('../../src/i18n/index.ts')).initI18n()
  return import('../../src/domain/digest/email.ts')
}

describe('the digest SMTP transport (#580)', () => {
  it('requires STARTTLS by default, refusing to fall back to plaintext', async () => {
    const email = await loadEmailWith({})

    await email.sendDigestEmail(['a@example.test'], Buffer.from('%PDF-'), '2026-04', 'en')

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: true }))
  })

  it('allows an explicit opt-out for a loopback relay', async () => {
    const email = await loadEmailWith({ SMTP_REQUIRE_TLS: 'false' })

    await email.sendDigestEmail(['a@example.test'], Buffer.from('%PDF-'), '2026-04', 'en')

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: false }))
  })
})

describe('digest recipients (#584)', () => {
  it('bccs every recipient rather than putting them all in a shared To header', async () => {
    const email = await loadEmailWith({})

    await email.sendDigestEmail(['a@example.test', 'b@example.test'], Buffer.from('%PDF-'), '2026-04', 'en')

    const sendMail = createTransport.mock.results.at(-1)!.value.sendMail as ReturnType<typeof vi.fn>
    const message = sendMail.mock.calls[0]![0] as { to: unknown; bcc: unknown }
    expect(message.to).toBe('digest@example.test')
    expect(message.bcc).toEqual(['a@example.test', 'b@example.test'])
  })
})
