/**
 * Correcting the average household without editing a file on disk (#290).
 *
 * The benchmark file carries the two numbers that make a *level* comparison possible: what
 * the average Belgian household spends per month, and how big that household is on the
 * equivalence scale. Both are derived from a 7 MB spreadsheet Statbel republishes once a
 * year, and neither is on a page anybody would think to check. So they go stale, and the
 * only way to correct them was `BENCHMARK_PATH` — a volume mount and a restart, which a
 * container install cannot do from the settings screen it is already looking at.
 *
 * Four decisions:
 *
 *  - **Both numbers or neither.** The file schema's own rule, for its own reason: a total
 *    without a size cannot be scaled to your household, and a size without a total has
 *    nothing to scale. So the override is one object, and clearing it clears both.
 *  - **The status drops to `transcribed`, always.** The shipped block says `confirmed`
 *    because somebody opened the spreadsheet; a typed correction has no such claim behind
 *    it, and inheriting the file's clean bill of health would put the app's confidence
 *    behind a number it has never seen. The caveat machinery already names
 *    `reference_household` as the unconfirmed block, so restoring the caveat is the whole
 *    of what this costs.
 *  - **`last_verified` is stamped where it is stored, not sent.** A client that could
 *    choose the date could make a figure look permanently fresh, which is the one thing
 *    `verifiedDateSchema` refuses a future date in order to prevent. Stamping it at the
 *    write means the date says what it should: the day somebody typed this.
 *  - **A citation is required, not generated.** Nothing here fabricates provenance prose:
 *    a sentence this module invented would be an English string printed into a Dutch page,
 *    and worse, it would look like a source. It also cannot be borrowed from the file,
 *    because the file may carry no reference block at all — a custom `BENCHMARK_PATH`, or
 *    a copy with it deleted — and that is precisely the case where an override matters
 *    most. So the owner says where the figure came from, and the form offers the file's own
 *    citation as the starting point.
 *
 * `source_url` and `notes` are deliberately dropped rather than carried over. Both describe
 * how the *file's* figure was derived, and pointing them at a number somebody has since
 * replaced would make the wrong claim more convincingly than saying nothing.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/index.ts";
import { settings } from "../../db/schema.ts";
import { logger } from "../../logger.ts";
import { verifiedDateSchema } from "../verified-date.ts";
import type { Benchmark } from "./model.ts";

const log = logger.child({ module: "benchmark/reference" });

export const REFERENCE_OVERRIDE_KEY = "benchmark.reference";

/**
 * A hand-typed replacement for the file's `reference_household`.
 *
 * The two numeric bounds are the file schema's, not looser ones: `equivalent_adults_bp` is
 * at least 10 000 because the scale gives the first person 1,0 and a household has one,
 * and at most 200 000 because twenty equivalent adults is not a household. A form that
 * accepted a size of zero would divide by nothing on the next comparison.
 */
export const referenceOverrideSchema = z
  .object({
    meanMonthlyCents: z.int().positive(),
    equivalentAdultsBp: z.int().min(10_000).max(200_000),
    citation: z.string().trim().min(8).max(200),
    /** The day it was typed, stamped by `saveReferenceOverride`. */
    savedOn: verifiedDateSchema,
  })
  .strict();

export type ReferenceOverride = z.infer<typeof referenceOverrideSchema>;

/** What a caller may set: everything but the date, which is not theirs to choose. */
export type ReferenceOverridePatch = Omit<ReferenceOverride, "savedOn">;

/**
 * The stored override, or null.
 *
 * Reading degrades and writing throws, the same contract as `loadHousehold` for the same
 * reason: an override nobody can parse should cost the level comparison and leave the file's
 * figure standing, not take down the page that would let somebody fix it.
 */
export function loadReferenceOverride(db: Db): ReferenceOverride | null {
  const row = db
    .select({ valueJson: settings.valueJson })
    .from(settings)
    .where(eq(settings.key, REFERENCE_OVERRIDE_KEY))
    .get();

  if (!row) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(row.valueJson);
  } catch (error) {
    log.warn(
      { err: error },
      "stored reference override is not JSON; using the file figure",
    );
    return null;
  }

  const parsed = referenceOverrideSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn(
      { issues: parsed.error.issues },
      "stored reference override does not validate; using the file figure",
    );
    return null;
  }
  return parsed.data;
}

/** Validates and stores an override, stamping the day it was stored. */
export function saveReferenceOverride(
  db: Db,
  patch: ReferenceOverridePatch,
  today: Date = new Date(),
): ReferenceOverride {
  const next = referenceOverrideSchema.parse({
    ...patch,
    savedOn: today.toISOString().slice(0, 10),
  });
  const valueJson = JSON.stringify(next);

  db.insert(settings)
    .values({ key: REFERENCE_OVERRIDE_KEY, valueJson })
    .onConflictDoUpdate({
      target: settings.key,
      set: { valueJson, updatedAt: new Date() },
    })
    .run();

  return next;
}

/** Removes the override, so the file's figure applies again. */
export function clearReferenceOverride(db: Db): void {
  db.delete(settings).where(eq(settings.key, REFERENCE_OVERRIDE_KEY)).run();
}

/**
 * The benchmark as it should be read, with any override applied.
 *
 * Returns the same object when there is nothing to apply, so the common path allocates
 * nothing and an identity check still means what it looks like. A null benchmark stays
 * null: an override is a correction to a configured file, not a way to conjure a
 * comparison out of one that does not exist — the shares and the scale would still be
 * missing, and there is nothing to correct.
 */
// Overloaded so a caller that has already established it holds a file — the settings
// route, inside its own null check — does not have to re-establish it afterwards.
export function applyReferenceOverride(
  benchmark: Benchmark,
  override: ReferenceOverride | null,
): Benchmark;
export function applyReferenceOverride(
  benchmark: Benchmark | null,
  override: ReferenceOverride | null,
): Benchmark | null;
export function applyReferenceOverride(
  benchmark: Benchmark | null,
  override: ReferenceOverride | null,
): Benchmark | null {
  if (benchmark === null || override === null) return benchmark;
  return {
    ...benchmark,
    referenceHousehold: {
      mean_monthly_cents: override.meanMonthlyCents,
      equivalent_adults_bp: override.equivalentAdultsBp,
      citation: override.citation,
      last_verified: override.savedOn,
      status: "transcribed",
    },
  };
}
