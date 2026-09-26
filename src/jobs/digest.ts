/**
 * The monthly digest job (#52): renders last month's narrative and key charts to
 * a PDF and either stores it for download or mails it, per the tenant's own
 * `digest.preference` (`domain/digest/preference.ts`).
 *
 * Runs on day `DIGEST_DAY` of the month — one day after `CATCHUP_NIGHTS` closes
 * (`jobs/ai.ts`) — so the digest always describes the narrative *after* the
 * catch-up re-analysis window, never a version the next night silently
 * supersedes.
 */
import { config } from '../config.ts'
import { buildDigestPdf } from '../domain/digest/pdf.ts'
import { loadDigestPreference, resolveDigestLocale } from '../domain/digest/preference.ts'
import { sendDigestEmail } from '../domain/digest/email.ts'
import { saveDigestPdf } from '../domain/digest/storage.ts'
import { CATCHUP_NIGHTS, narrativePeriod } from './ai.ts'
import type { Job, JobContext, JobDetail } from './runner.ts'

/**
 * One day after the catch-up window closes — see the file header. A local
 * constant, not new config: this is a fact about `CATCHUP_NIGHTS`, not an
 * operator-facing knob.
 */
export const DIGEST_DAY = CATCHUP_NIGHTS + 1

async function run({ db, tenantId, now, log }: JobContext): Promise<JobDetail> {
  const preference = loadDigestPreference(db, tenantId)
  if (preference.mode === 'off') {
    return { mode: 'off', sent: false, reason: null }
  }

  if (preference.mode === 'email' && !config.smtpConfigured) {
    log.warn('digest mode is "email" but no SMTP relay is configured; skipping')
    return { mode: 'email', sent: false, reason: 'smtp_not_configured' }
  }

  const period = narrativePeriod(now)
  const locale = resolveDigestLocale(db, tenantId, period, preference)
  const pdf = await buildDigestPdf(db, tenantId, period, locale)
  if (pdf === null) {
    log.info({ period }, 'no narrative stored for the digest period; skipping')
    return { mode: preference.mode, sent: false, reason: 'no_narrative' }
  }

  if (preference.mode === 'pdf') {
    saveDigestPdf(db, tenantId, period, pdf)
    return { mode: 'pdf', sent: true, reason: null }
  }

  // `email`, `recipientEmails` is guaranteed non-empty by `digestPreferenceSchema`'s
  // cross-field check whenever `mode === 'email'`.
  await sendDigestEmail(preference.recipientEmails, pdf, period, locale)
  return { mode: 'email', sent: true, reason: null }
}

export const digestJob: Job = {
  name: 'digest',
  schedule: { kind: 'monthly', day: DIGEST_DAY, hour: config.JOBS_NIGHTLY_HOUR },
  run,
}
