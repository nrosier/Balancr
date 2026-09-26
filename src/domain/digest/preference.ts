/**
 * Whether, and how, a tenant wants the monthly digest (#52).
 *
 * `off` by default: a digest generates a PDF and, in `email` mode, sends it through
 * whatever SMTP relay is configured, so nothing here should start happening to a
 * household that never asked for it.
 *
 * `locale` is left `undefined` by default on purpose rather than resolved and
 * stored here — a stored value would go stale the moment the owner switched their
 * account language, and `resolveDigestLocale` below resolves it fresh at render time
 * from the owner's own `locale` when this is unset.
 *
 * In `settings`, like the household composition and the risk profile: a fact about
 * this deployment's preferences, not a computed one.
 */
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { settings, users } from '../../db/schema.ts'
import { logger } from '../../logger.ts'
import { narrativeLocales } from '../ai/narrative.ts'

const log = logger.child({ module: 'digest/preference' })

export const DIGEST_KEY = 'digest.preference'

/** How many recipients a digest may be mailed to. Plenty for a household. */
export const MAX_DIGEST_RECIPIENTS = 5

export const digestPreferenceSchema = z
  .object({
    mode: z.enum(['off', 'pdf', 'email']).default('off'),
    /**
     * Who receives the digest in `email` mode. An array, not a single address: more
     * than one person in a household can want the PDF, and storing a list costs
     * nothing extra over a JSON blob.
     */
    recipientEmails: z.array(z.email()).max(MAX_DIGEST_RECIPIENTS).default([]),
    /** Overrides the owner's account locale for this digest, or unset to follow it. */
    locale: z.string().min(2).optional(),
  })
  .strict()
  .prefault({})
  .superRefine((value, ctx) => {
    if (value.mode === 'email' && value.recipientEmails.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['recipientEmails'],
        message: 'at least one recipient email is required when mode is "email"',
      })
    }
  })

export type DigestPreference = z.infer<typeof digestPreferenceSchema>
export type DigestPreferencePatch = z.input<typeof digestPreferenceSchema>

export const DEFAULT_DIGEST_PREFERENCE: DigestPreference = digestPreferenceSchema.parse({})

/**
 * The stored preference, or the default (off) with the reason logged.
 *
 * Same contract as `loadHousehold`: reading degrades, writing throws. A preference
 * row nobody can parse should turn the digest off, not break the settings page.
 */
export function loadDigestPreference(db: Db, tenantId: string): DigestPreference {
  const row = db
    .select({ valueJson: settings.valueJson })
    .from(settings)
    .where(and(eq(settings.tenantId, tenantId), eq(settings.key, DIGEST_KEY)))
    .get()

  if (!row) return DEFAULT_DIGEST_PREFERENCE

  let raw: unknown
  try {
    raw = JSON.parse(row.valueJson)
  } catch (error) {
    log.error(
      { err: error, key: DIGEST_KEY },
      'the stored digest preference is not JSON; treating the digest as off',
    )
    return DEFAULT_DIGEST_PREFERENCE
  }

  const parsed = digestPreferenceSchema.safeParse(raw)
  if (!parsed.success) {
    log.error(
      { key: DIGEST_KEY, issues: z.prettifyError(parsed.error) },
      'the stored digest preference is invalid; treating the digest as off',
    )
    return DEFAULT_DIGEST_PREFERENCE
  }
  return parsed.data
}

/** Validates and stores a digest preference, replacing it wholesale. */
export function saveDigestPreference(
  db: Db,
  tenantId: string,
  patch: DigestPreferencePatch,
): DigestPreference {
  const next = digestPreferenceSchema.parse(patch ?? {})
  const valueJson = JSON.stringify(next)

  db.insert(settings)
    .values({ tenantId, key: DIGEST_KEY, valueJson })
    .onConflictDoUpdate({
      target: [settings.tenantId, settings.key],
      set: { valueJson, updatedAt: new Date() },
    })
    .run()

  return next
}

/**
 * The language a digest is rendered in, for a tenant that has not overridden it.
 *
 * A cron job has no request context and therefore no `Accept-Language`, no session
 * — none of the ways an ordinary request learns which language to answer in. The
 * oldest owner account is the closest thing this tenant has to "whoever set this
 * up", so their UI locale is the preferred default — but only when a narrative
 * actually exists in it for `period`. Nothing in the nightly pipeline writes a
 * narrative in anything but `config.DEFAULT_LOCALE`; a translation into another
 * language is a paid, manual click from the dashboard (`translateNarrative`). An
 * owner whose account locale differs from `DEFAULT_LOCALE` and who has never made
 * that click would otherwise get a silent `no_narrative` every month for a reason
 * invisible from here — so this falls back to `DEFAULT_LOCALE`, which is always
 * the one language the pipeline itself keeps supplied, rather than a preference
 * nobody chose and that this tenant cannot act on from the digest settings alone.
 *
 * Resolved fresh on every render rather than stored on the preference row, so a
 * digest always follows the owner's *current* language — see the file header.
 */
export function resolveDigestLocale(
  db: Db,
  tenantId: string,
  period: string,
  preference: DigestPreference,
): string {
  if (preference.locale !== undefined) return preference.locale

  const owner = db
    .select({ locale: users.locale })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, 'owner')))
    .orderBy(asc(users.createdAt))
    .limit(1)
    .get()
  const ownerLocale = owner?.locale ?? config.DEFAULT_LOCALE

  if (ownerLocale === config.DEFAULT_LOCALE) return ownerLocale
  return narrativeLocales(db, tenantId, period).includes(ownerLocale) ? ownerLocale : config.DEFAULT_LOCALE
}
