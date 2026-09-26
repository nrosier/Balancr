/**
 * The monthly digest's `email` mode (#52).
 *
 * One SMTP relay, configured deployment-wide (`SMTP_*` in `config.ts`) — unlike
 * Actual/Ghostfolio/Gemini there is no per-tenant credential, because a
 * self-hosted advisor has exactly one mail relay to send through, not one per
 * household. `config.smtpConfigured` is the off-switch; `jobs/digest.ts` checks
 * it before calling this, and before building the PDF at all.
 *
 * Raw `node:net`/`node:tls` traffic, like the egress-wrapper note on `SMTP_HOST`
 * in `config.ts` says — outside `egress.ts`'s `fetch`-only allowlist, the same
 * way `ACTUAL_SERVER_URL` is: an operator-typed relay, not attacker-controlled.
 */
import nodemailer, { type Transporter } from 'nodemailer'
import { config } from '../../config.ts'
import { formatMonth } from '../../i18n/format.ts'
import { t } from '../../i18n/index.ts'

let transport: Transporter | undefined
let transportOverride: Transporter | undefined

function transporter(): Transporter {
  if (transportOverride !== undefined) return transportOverride
  if (transport === undefined) {
    transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      requireTLS: config.SMTP_REQUIRE_TLS,
      auth:
        config.SMTP_USER === undefined
          ? undefined
          : { user: config.SMTP_USER, pass: config.SMTP_PASS },
    })
  }
  return transport
}

/** Test seam: swap the transport, or drop it (`null`) so a config change takes effect. */
export function setMailTransport(next: Transporter | null): void {
  transportOverride = next ?? undefined
  if (next === null) transport = undefined
}

/**
 * Mails the digest PDF to every configured recipient in one message.
 *
 * Callers must check `config.smtpConfigured` first — this throws rather than
 * silently no-op-ing on a missing `SMTP_FROM`, since a caller that reaches here
 * without checking has a bug worth surfacing, not a state to degrade from.
 *
 * Recipients go in `bcc` rather than `to` (#584): a joint-custody or
 * shared-accountant recipient list is exactly the case where one recipient
 * hasn't chosen to have their address shown to the others.
 */
export async function sendDigestEmail(
  recipients: readonly string[],
  pdfBytes: Buffer,
  period: string,
  locale: string,
): Promise<void> {
  if (config.SMTP_FROM === undefined) {
    throw new Error('sendDigestEmail called with SMTP_FROM unset')
  }
  const month = formatMonth(period, locale)
  await transporter().sendMail({
    from: config.SMTP_FROM,
    to: config.SMTP_FROM,
    bcc: [...recipients],
    subject: t(locale, 'settings:digest.email.subject', { month }),
    text: t(locale, 'settings:digest.email.body', { month }),
    attachments: [
      {
        filename: `${t(locale, 'settings:digest.email.filenamePrefix')}-${period}.pdf`,
        content: pdfBytes,
      },
    ],
  })
}
