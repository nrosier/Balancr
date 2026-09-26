/**
 * The `pdf` mode's stored digest (#52).
 *
 * One row per tenant, overwritten every month — there is never more than one
 * stored PDF, matching the "download the latest digest" use case this exists for.
 * No retention job is needed because there is nothing to retain beyond the latest.
 */
import { eq, sql } from 'drizzle-orm'
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

/** Whether this tenant has a stored digest, without reading its bytes. */
export function hasDigestPdf(db: Db, tenantId: string): boolean {
  const row = db
    .select({ one: sql<number>`1` })
    .from(digestPdfs)
    .where(eq(digestPdfs.tenantId, tenantId))
    .get()
  return row !== undefined
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

/**
 * Drops this tenant's stored digest, e.g. once the preference no longer calls for
 * one (#572) — otherwise the last PDF generated under `pdf` mode stays downloadable
 * forever after switching to `email` or `off`.
 */
export function deleteDigestPdf(db: Db, tenantId: string): void {
  db.delete(digestPdfs).where(eq(digestPdfs.tenantId, tenantId)).run()
}
