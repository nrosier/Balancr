/**
 * The `pdf` mode's stored digest (#52).
 *
 * One row per tenant, overwritten every month — there is never more than one
 * stored PDF, matching the "download the latest digest" use case this exists for.
 * No retention job is needed because there is nothing to retain beyond the latest.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { digestPdfs } from '../../db/schema.ts'

export interface StoredDigestPdf {
  readonly period: string
  readonly pdfBytes: Buffer
  readonly createdAt: Date
}

/** Replaces this tenant's stored digest wholesale, whatever period it was for. */
export function saveDigestPdf(db: Db, tenantId: string, period: string, pdfBytes: Buffer): void {
  db.insert(digestPdfs)
    .values({ tenantId, period, pdfBytes })
    .onConflictDoUpdate({
      target: [digestPdfs.tenantId],
      set: { period, pdfBytes, createdAt: new Date() },
    })
    .run()
}

/** This tenant's stored digest, or `null` if none has been generated yet. */
export function loadDigestPdf(db: Db, tenantId: string): StoredDigestPdf | null {
  const row = db
    .select({ period: digestPdfs.period, pdfBytes: digestPdfs.pdfBytes, createdAt: digestPdfs.createdAt })
    .from(digestPdfs)
    .where(eq(digestPdfs.tenantId, tenantId))
    .get()
  return row ?? null
}
