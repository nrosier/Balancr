/**
 * The names a risk profile is written in, in a module a browser can import (#41).
 *
 * Four asset classes and three preset ids, split out of `profile.ts` for one reason:
 * that file reaches the database. It imports Drizzle, the schema, the logger and — one
 * import further down — `config`, because loading a profile is a `SELECT`. The settings
 * screen needs the *order* of the four bands it draws and the three presets it offers,
 * and importing them from there would pull all of that into the bundle.
 *
 * So the vocabulary lives here — no zod, no `node:` anything, nothing that reads a file
 * or a row — and `web/src/shared.ts` re-exports it, the same arrangement `domain/ai/
 * codes.ts` has with the finding vocabulary. Anything that needs to *validate* against
 * these arrays imports `profile.ts`, which builds the schemas out of them.
 *
 * Order is load-bearing in both arrays, which is why they are arrays. The classes read
 * from the core outward — equities, bonds, then the two satellites — and the presets from
 * least risk to most, so a picker rendered by iterating them needs no sort and cannot
 * offer "growth, defensive, balanced" on one screen and something else on another.
 */

/**
 * The asset classes a band may name, in the spelling Ghostfolio uses.
 *
 * Ghostfolio's own labels rather than a vocabulary of our own, so that a slice of the
 * allocation and a band are keyed by the same string with nothing translating between
 * them. `LIQUIDITY` is deliberately not here: bands are shares of the *invested* value,
 * and a cash balance a bank sync wrote into Ghostfolio is not a decision about risk —
 * counting it would move every drift figure when a salary lands.
 *
 * A class Ghostfolio introduces later shows up as unmapped drift rather than as an
 * error — `drift.ts` reports it, and until somebody adds a band for it there is no
 * target it could be measured against.
 */
export const BAND_CLASSES = ['EQUITY', 'FIXED_INCOME', 'REAL_ESTATE', 'COMMODITY'] as const
export type BandClass = (typeof BAND_CLASSES)[number]

/**
 * The presets by name, and then every profile a user can be on.
 *
 * `PROFILE_IDS` is derived rather than written twice: the settings page offers a picker
 * over the presets and a fourth entry for `custom`, and a fourth preset added to
 * `PROFILE_PRESETS` has to appear in both without anybody remembering to.
 */
export const PRESET_IDS = ['defensive', 'balanced', 'growth'] as const
export type PresetId = (typeof PRESET_IDS)[number]

export const PROFILE_IDS = [...PRESET_IDS, 'custom'] as const
export type ProfileId = (typeof PROFILE_IDS)[number]
