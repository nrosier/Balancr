/**
 * `account_map`: the table that decides what net worth is made of.
 *
 * Every account either system knows about gets a row here, and three of its
 * columns are judgement calls only a human can make — `kind` (is this liquid?),
 * `include_in_net_worth`, and the `dedupe_group` / `is_source_of_truth` pair that
 * stops an Actual investment mirror and the same Ghostfolio positions being
 * counted twice. So the sync has one hard rule: **it may create rows and update
 * names, and it may never overwrite a decision.** A rename in Actual must not
 * silently undo the mapping that keeps net worth honest.
 *
 * New rows get a defensive default rather than a guess:
 *
 *  - **Ghostfolio** accounts are `investment` — that is what Ghostfolio is for.
 *  - **On-budget Actual** accounts are `checking`. Actual has no account-type
 *    field to read, but an on-budget account is one the bills are paid from, and
 *    every plausible answer (checking, savings, cash) is liquid either way.
 *  - **Off-budget Actual** accounts are `other`: neither liquid nor invested.
 *    This is the honest default, since an off-budget account is as likely to be a
 *    mortgage as a broker, and `other` counts toward the total without pretending
 *    to be an emergency fund.
 */
import { eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { accountMap } from '../../db/schema.ts'
import type { AccountKind } from '../../db/schema.ts'
import type { Transaction } from '../audit.ts'

export type AccountSource = 'actual' | 'ghostfolio'

/** An account as one of the source systems currently reports it. */
export interface AccountSighting {
  source: AccountSource
  externalId: string
  name: string
  /** Actual only: off-budget accounts are excluded from budget figures. */
  offBudget?: boolean
  closed?: boolean
  /**
   * Ghostfolio only: whether the account holds anything other than cash, per
   * `classify.ts`. Absent when the instance did not answer.
   *
   * Passed in so the *insert* is already right. The same rule runs again over
   * existing rows through `applyDerivedFields`, and the alternative — insert every
   * Ghostfolio account as `investment` and correct it a moment later — would have
   * a window in which a bank balance was labelled invested, plus two spellings of
   * one rule to keep in step.
   */
  holdsInvestments?: boolean
}

export type AccountMapRow = typeof accountMap.$inferSelect

export interface AccountSyncResult {
  created: number
  /** Rows whose name changed. Nothing else is ever updated. */
  renamed: number
  /** Rows in the table that neither source reported this pass. */
  missing: AccountMapRow[]
}

/** The default `kind` for a newly sighted account. See the header for why. */
export function defaultKind(sighting: AccountSighting): AccountKind {
  if (sighting.source === 'ghostfolio') {
    // Undefined means the instance did not report the evidence, and `investment` is
    // the safe answer there: a Ghostfolio account wrongly called invested is a
    // mislabelled row, while one wrongly called cash is a candidate for being
    // grouped away as a duplicate — and money missing from net worth has no symptom.
    return sighting.holdsInvestments === false ? 'cash' : 'investment'
  }
  return sighting.offBudget ? 'other' : 'checking'
}

/**
 * Creates rows for new accounts and refreshes names. Decisions are untouched.
 *
 * `missing` is reported rather than deleted: a Ghostfolio outage that returns an
 * empty account list must not drop the mapping, and a deleted account's snapshot
 * history is still worth keeping. The settings page can offer the removal.
 */
export function syncAccountMap(
  db: Db,
  sightings: readonly AccountSighting[],
): AccountSyncResult {
  const result: AccountSyncResult = { created: 0, renamed: 0, missing: [] }

  db.transaction((tx) => {
    const existing = tx.select().from(accountMap).all()
    const bySource = new Map(existing.map((row) => [`${row.source}:${row.externalId}`, row]))
    const seen = new Set<string>()

    for (const sighting of sightings) {
      const key = `${sighting.source}:${sighting.externalId}`
      seen.add(key)
      const row = bySource.get(key)

      if (!row) {
        tx.insert(accountMap)
          .values({
            source: sighting.source,
            externalId: sighting.externalId,
            name: sighting.name,
            kind: defaultKind(sighting),
          })
          .run()
        result.created += 1
        continue
      }

      if (row.name !== sighting.name) {
        tx.update(accountMap)
          .set({ name: sighting.name })
          .where(eq(accountMap.id, row.id))
          .run()
        result.renamed += 1
      }
    }

    result.missing = existing.filter(
      (row) => !seen.has(`${row.source}:${row.externalId}`),
    )
  })

  return result
}

export function loadAccountMap(db: Db): AccountMapRow[] {
  return db.select().from(accountMap).all()
}

/** Rows for the given source, keyed by the id that source uses. */
export function accountMapBySource(
  rows: readonly AccountMapRow[],
  source: AccountSource,
): Map<string, AccountMapRow> {
  return new Map(
    rows.filter((row) => row.source === source).map((row) => [row.externalId, row]),
  )
}

/** What a suggestion rests on, so a reader can audit it instead of trusting it. */
export type MirrorSignal =
  /** Normalised names are equal. */
  | 'name'
  /** One normalised name contains the other, whole words only. */
  | 'nameContains'
  /** Same currency and the values agree to within `BALANCE_TOLERANCE`. */
  | 'balance'
  /** Same currency. Never evidence on its own — everything here is EUR. */
  | 'currency'

/** Ranking weights. Only the order matters; the numbers are spaced to make it readable. */
const SIGNAL_WEIGHT: Record<MirrorSignal, number> = {
  name: 100,
  balance: 50,
  nameContains: 25,
  currency: 1,
}

/**
 * How far two balances may drift and still be called the same money.
 *
 * A euro, or a tenth of a percent of the larger side, whichever is more generous.
 * The absolute floor is there because a synced pair agrees exactly and the only
 * expected disagreement is a rounding step; the relative term is there because a
 * six-figure account converted through a rate can differ by more than a euro
 * without either figure being wrong.
 */
function balanceTolerance(a: number, b: number): number {
  return Math.max(100, Math.round(Math.max(Math.abs(a), Math.abs(b)) / 1000))
}

/** The account kinds an Actual row may have to be a plausible mirror of a Ghostfolio one. */
const MIRRORABLE: Partial<Record<AccountKind, ReadonlySet<AccountKind>>> = {
  // A Ghostfolio account holding no positions is a copy of a bank balance, so its twin
  // is a bank account — including `checking`, which the old filter excluded and which is
  // the direction that actually happens when a syncing tool writes banks into Ghostfolio.
  cash: new Set<AccountKind>(['checking', 'savings', 'cash', 'other']),
  // A portfolio can only mirror something holding positions. `other` is in because it is
  // the off-budget default, so a real investment mirror may not have been labelled yet.
  investment: new Set<AccountKind>(['investment', 'other']),
}

export interface AccountBalance {
  accountMapId: string
  valueCents: number
  currency: string
}

export interface DedupeCandidate {
  ghostfolio: AccountMapRow
  /** The single best-scoring Actual row. There is never a second suggestion. */
  actual: AccountMapRow
  /** Strongest first, and never empty: a candidate with no signal is not emitted. */
  signals: MirrorSignal[]
}

/** Whole-word containment, so "cash" does not match "cashflow". */
function containsWords(haystack: string, needle: string): boolean {
  if (needle === '' || haystack === needle) return false
  return ` ${haystack} `.includes(` ${needle} `)
}

function signalsFor(
  ghostfolio: AccountMapRow,
  actual: AccountMapRow,
  balances: ReadonlyMap<string, AccountBalance>,
): MirrorSignal[] {
  const signals: MirrorSignal[] = []

  const gName = normaliseAccountName(ghostfolio.name)
  const aName = normaliseAccountName(actual.name)
  if (gName !== '' && gName === aName) signals.push('name')
  else if (containsWords(gName, aName) || containsWords(aName, gName)) {
    signals.push('nameContains')
  }

  const gBal = balances.get(ghostfolio.id)
  const aBal = balances.get(actual.id)
  if (gBal !== undefined && aBal !== undefined && gBal.currency === aBal.currency) {
    signals.push('currency')
    // Zero is the most common balance in any dataset — a dormant account, an account
    // opened and never used, an account whose snapshot has not run. Two of them
    // agreeing at zero is a coincidence, not evidence, and treating it as evidence
    // would pair every empty account with every other one.
    const sameMoney =
      gBal.valueCents !== 0 &&
      aBal.valueCents !== 0 &&
      Math.abs(gBal.valueCents - aBal.valueCents) <=
        balanceTolerance(gBal.valueCents, aBal.valueCents)
    // Signed, deliberately: a credit card at −800 and a savings account at +800 are not
    // the same money, and comparing magnitudes would say they were.
    if (sameMoney) signals.push('balance')
  }

  return signals.sort((a, b) => SIGNAL_WEIGHT[b] - SIGNAL_WEIGHT[a])
}

function score(signals: readonly MirrorSignal[]): number {
  return signals.reduce((total, signal) => total + SIGNAL_WEIGHT[signal], 0)
}

/**
 * The one Actual account each Ghostfolio account is most likely a copy of.
 *
 * This exists because the default mapping double counts, and double counting is
 * wrong in the flattering direction: net worth comes out too high and looks
 * plausible. Nothing here changes a figure — it is the prompt that gets a human to
 * make the call, surfaced in the setup panel.
 *
 * What it is not, any more, is a cross join. The previous version handed every
 * Ghostfolio account the *same* list of Actual accounts and compared nothing, so a
 * brokerage account was offered against meal vouchers and a savings account, and the
 * output grew as the product of the two sides. That defended itself as a loose
 * heuristic, but a comparison that consults none of the data cannot be loose or
 * strict — it asserts nothing. Worse, an Actual account became a suspect by being
 * classified accurately, so describing accounts correctly made the panel noisier.
 *
 * So: like with like by derived `kind`, at most one suggestion per Ghostfolio
 * account, every suggestion carrying the evidence it rests on, and nothing at all
 * when nothing matches. A name or a balance must agree — currency alone is not
 * evidence when every account is in euros.
 *
 * Recall still beats precision here, which is why containment counts and why the
 * tolerance is generous: a missed suggestion leaves net worth wrong for months,
 * while a wrong one now costs one click that is remembered (`dismissMirror`). That
 * trade only became payable once dismissal was storable — before it, the sole way to
 * silence a false suggestion was to group two unrelated accounts, which drops real
 * money out of net worth.
 */
export function dedupeCandidates(
  rows: readonly AccountMapRow[],
  balances: readonly AccountBalance[] = [],
): DedupeCandidate[] {
  const byId = new Map(balances.map((balance) => [balance.accountMapId, balance]))
  const ungrouped = rows.filter((row) => row.dedupeGroup === null)
  // An Actual account that does not count toward net worth cannot be half of a double
  // count, so proposing a group for it would be noise under a heading that says
  // "possibly counted twice".
  const mirrors = ungrouped.filter((row) => row.source === 'actual' && row.includeInNetWorth)
  if (mirrors.length === 0) return []

  const candidates: DedupeCandidate[] = []
  for (const ghostfolio of ungrouped) {
    if (ghostfolio.source !== 'ghostfolio' || !ghostfolio.includeInNetWorth) continue
    // A dismissal is a decided `dedupeGroup` on the Ghostfolio row: someone has said
    // this account mirrors nothing. Offering it again after the next sync renamed it is
    // the defect that made the old panel impossible to clear.
    if (decidedFields(ghostfolio).has('dedupeGroup')) continue

    const allowed = MIRRORABLE[ghostfolio.kind]
    if (allowed === undefined) continue

    let best: DedupeCandidate | null = null
    let bestScore = 0
    for (const actual of mirrors) {
      if (!allowed.has(actual.kind)) continue
      const signals = signalsFor(ghostfolio, actual, byId)
      if (!signals.some((signal) => signal !== 'currency')) continue

      const total = score(signals)
      // Ties break on name then id rather than emitting nothing. The human is in the
      // loop and the evidence is on screen, so showing the weaker of two equal matches
      // is recoverable; showing neither hides a double count that has no other symptom.
      if (
        best === null ||
        total > bestScore ||
        (total === bestScore &&
          (actual.name < best.actual.name ||
            (actual.name === best.actual.name && actual.id < best.actual.id)))
      ) {
        best = { ghostfolio, actual, signals }
        bestScore = total
      }
    }
    if (best !== null) candidates.push(best)
  }

  return candidates.sort((a, b) => a.ghostfolio.name.localeCompare(b.ghostfolio.name))
}

/** Marks rows as belonging to one group, with `sourceOfTruthId` the one that counts. */
export function setDedupeGroup(
  db: Db,
  group: string,
  accountMapIds: readonly string[],
  sourceOfTruthId: string,
): void {
  if (!accountMapIds.includes(sourceOfTruthId)) {
    // Refused rather than repaired: a group with no source of truth counts as
    // nothing at all, and net worth being too low has no visible symptom.
    throw new Error(
      `source of truth ${sourceOfTruthId} is not among the accounts being grouped`,
    )
  }
  db.transaction((tx) => {
    tx.update(accountMap)
      .set({ dedupeGroup: group, isSourceOfTruth: false })
      .where(inArray(accountMap.id, [...accountMapIds]))
      .run()
    tx.update(accountMap)
      .set({ isSourceOfTruth: true })
      .where(eq(accountMap.id, sourceOfTruthId))
      .run()
    // Grouping two accounts is a judgement about which of them is real, so a
    // matcher that later disagrees has to leave it alone — including the dismissal
    // in #131, which is a decision that two accounts are *not* the same and is worth
    // exactly as much as the decision that they are.
    markDecided(tx, accountMapIds, ['dedupeGroup', 'isSourceOfTruth'])
  })
}

/**
 * Records that these fields on these rows are now a person's answer.
 *
 * Read-modify-write per row rather than one bulk `UPDATE`, because the value is a
 * set and the rows do not start from the same one. Rows whose set is unchanged are
 * skipped, so re-grouping an already-grouped account writes nothing.
 */
function markDecided(
  tx: Transaction,
  ids: readonly string[],
  fields: readonly DecidableField[],
): void {
  if (ids.length === 0) return

  for (const row of tx.select().from(accountMap).where(inArray(accountMap.id, [...ids])).all()) {
    const decided = decidedFields(row)
    const before = decided.size
    for (const field of fields) decided.add(field)
    if (decided.size === before) continue
    tx.update(accountMap)
      .set({ decidedFields: encodeDecidedFields(decided) })
      .where(eq(accountMap.id, row.id))
      .run()
  }
}

/** One account as the settings screen may change it. */
export interface AccountMapPatch {
  kind?: AccountKind
  includeInNetWorth?: boolean
}

/**
 * Changes what an account contributes, and nothing about what it is.
 *
 * `source`, `externalId` and `name` are the source system's to own — they are
 * refreshed by `syncAccountMap` on every pass, so an edit here would be silently
 * reverted. What is editable is exactly the two judgements Balancr cannot derive:
 * what kind of account this is, and whether its balance is part of net worth.
 *
 * Returns null for an unknown id rather than throwing, so the route can answer
 * 404 rather than 500.
 */
export function updateAccountMap(
  db: Db,
  id: string,
  patch: AccountMapPatch,
): AccountMapRow | null {
  const changes = {
    ...(patch.kind === undefined ? {} : { kind: patch.kind }),
    ...(patch.includeInNetWorth === undefined
      ? {}
      : { includeInNetWorth: patch.includeInNetWorth }),
  }
  // An empty patch is a read: `set({})` is invalid SQL, and a PATCH with nothing
  // in it is a client bug that should not become a 500.
  if (Object.keys(changes).length === 0) {
    return db.select().from(accountMap).where(eq(accountMap.id, id)).all()[0] ?? null
  }

  return db.transaction((tx) => {
    const row = tx.select().from(accountMap).where(eq(accountMap.id, id)).all()[0]
    if (row === undefined) return null

    // The fields this patch names are now decided, and stay decided even if the
    // value happens to equal what a rule would have produced. The point is not that
    // the answer differs — it is that a person answered, and answering "yes, this is
    // a current account" has to survive a rule that later disagrees.
    const decided = decidedFields(row)
    for (const field of Object.keys(changes)) {
      if (isDecidableField(field)) decided.add(field)
    }

    return (
      tx
        .update(accountMap)
        .set({ ...changes, decidedFields: encodeDecidedFields(decided) })
        .where(eq(accountMap.id, id))
        .returning()
        .all()[0] ?? null
    )
  })
}

// ---------------------------------------------------------------------------
//  Provenance: which answers came from a person
// ---------------------------------------------------------------------------

/**
 * The fields a person can decide, and a rule can therefore not overwrite.
 *
 * Every one of these is a judgement Balancr cannot derive with certainty, which is
 * exactly why both a person and a rule might want to write it — and why the two
 * have to be told apart. `source`, `externalId` and `name` are absent because they
 * belong to the source system and are refreshed on every pass.
 */
export const DECIDABLE_FIELDS = [
  'kind',
  'includeInNetWorth',
  'dedupeGroup',
  'isSourceOfTruth',
] as const

export type DecidableField = (typeof DECIDABLE_FIELDS)[number]

function isDecidableField(field: string): field is DecidableField {
  return (DECIDABLE_FIELDS as readonly string[]).includes(field)
}

/**
 * The fields a person has decided on this row.
 *
 * Tolerant on the way in on purpose. The column holds JSON written by an earlier
 * version of this code and by a migration, so a null, an empty string, a
 * non-array, or an array with an unknown name in it are all possible — and every
 * one of them means the same useful thing here: treat what we cannot read as
 * undecided. The alternative is throwing while loading the settings page, which
 * would make an unreadable provenance record worse than no provenance record.
 *
 * Erring towards undecided is also the safe direction: it risks a rule overwriting
 * something a person chose, which they can see and set again, rather than freezing
 * a row against every future improvement with no way to tell why.
 */
export function decidedFields(row: Pick<AccountMapRow, 'decidedFields'>): Set<DecidableField> {
  const out = new Set<DecidableField>()
  if (row.decidedFields === null || row.decidedFields === '') return out

  let parsed: unknown
  try {
    parsed = JSON.parse(row.decidedFields)
  } catch {
    return out
  }
  if (!Array.isArray(parsed)) return out

  for (const entry of parsed) {
    if (typeof entry === 'string' && isDecidableField(entry)) out.add(entry)
  }
  return out
}

/** The stored form: sorted, so two equal sets compare equal as text too. */
export function encodeDecidedFields(fields: ReadonlySet<DecidableField>): string {
  return JSON.stringify([...fields].sort())
}

/**
 * Writes derived values, skipping every field a person has decided.
 *
 * This is the function a classifier calls, and the whole reason `decided_fields`
 * exists. `syncAccountMap` may never overwrite a decision and only runs
 * `defaultKind` on insert, so before this there was no path at all by which a
 * better rule could reach an account that already existed — and adding one that
 * wrote unconditionally would have erased the manual exclusions that are the only
 * thing currently keeping net worth right.
 *
 * `classifiedAt` is stamped whenever the classifier ran, including when it changed
 * nothing, because "the rule has seen this row and had nothing to add" and "the
 * rule has never looked" are different states and only the timestamp can tell them
 * apart.
 */
export function applyDerivedFields(
  db: Db,
  id: string,
  derived: AccountMapPatch,
  now = new Date(),
): AccountMapRow | null {
  return db.transaction((tx) => {
    const row = tx.select().from(accountMap).where(eq(accountMap.id, id)).all()[0]
    if (row === undefined) return null

    const decided = decidedFields(row)
    const changes = {
      ...(derived.kind === undefined || decided.has('kind') ? {} : { kind: derived.kind }),
      ...(derived.includeInNetWorth === undefined || decided.has('includeInNetWorth')
        ? {}
        : { includeInNetWorth: derived.includeInNetWorth }),
    }

    return (
      tx
        .update(accountMap)
        .set({ ...changes, classifiedAt: now })
        .where(eq(accountMap.id, id))
        .returning()
        .all()[0] ?? null
    )
  })
}

/**
 * A Ghostfolio cash account and the Actual account it appears to mirror.
 *
 * `actualId` is the source of truth in every pair, because Actual is where the
 * account gets reconciled and reconciliation is what makes a balance trustworthy.
 * Ghostfolio's copy of it is whatever the syncing tool last wrote.
 */
export interface DerivedMirror {
  ghostfolioId: string
  actualId: string
  /** The normalised name both sides matched on, for the log line and the panel. */
  matchedOn: string
}

/**
 * Names reduced to what two tools can be expected to agree on.
 *
 * Diacritics are folded and punctuation collapsed because one tool's "Argenta —
 * zichtrekening" is the other's "Argenta zichtrekening", and a match missed on a
 * dash leaves the money counted twice. Nothing stronger than case and punctuation
 * is stripped: dropping a word would start matching accounts that differ only by
 * the word dropped, and a false match removes real money from net worth.
 */
export function normaliseAccountName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * Pairs each Ghostfolio cash account with its Actual twin, where there is exactly one.
 *
 * Pure, so the matching rule is testable without a database. It is deliberately
 * unwilling: a pair is emitted only when one Actual row and one Ghostfolio cash row
 * share a normalised name and neither is already grouped. Two accounts called
 * "Savings" produce no pair at all, because grouping the wrong two drops real money
 * out of net worth — and a total that is too low looks exactly like a total that was
 * always that size. A missed match leaves the double count in place, which at least
 * announces itself as a number that is too big.
 *
 * Ghostfolio cash with no Actual twin is left alone and keeps counting. Excluding it
 * would be correct on this deployment and silently wrong on one where a bank exists
 * in Ghostfolio only.
 */
export function deriveMirrors(rows: readonly AccountMapRow[]): DerivedMirror[] {
  const ungrouped = rows.filter((row) => row.dedupeGroup === null)
  const byName = new Map<string, { actual: AccountMapRow[]; ghostfolio: AccountMapRow[] }>()
  for (const row of ungrouped) {
    // Only cash mirrors are matched. A Ghostfolio account that holds positions is a
    // portfolio, and the Actual account with the same name is a different question
    // — the one #131 is about, where the balances agree because both are synced.
    if (row.source === 'ghostfolio' && row.kind !== 'cash') continue
    const key = normaliseAccountName(row.name)
    if (key === '') continue
    const bucket = byName.get(key) ?? { actual: [], ghostfolio: [] }
    bucket[row.source].push(row)
    byName.set(key, bucket)
  }

  const mirrors: DerivedMirror[] = []
  for (const [key, { actual, ghostfolio }] of byName) {
    const [onlyActual] = actual
    const [onlyGhostfolio] = ghostfolio
    if (actual.length !== 1 || ghostfolio.length !== 1) continue
    if (onlyActual === undefined || onlyGhostfolio === undefined) continue
    mirrors.push({
      ghostfolioId: onlyGhostfolio.id,
      actualId: onlyActual.id,
      matchedOn: key,
    })
  }
  return mirrors.sort((a, b) => a.matchedOn.localeCompare(b.matchedOn))
}

/**
 * Groups one derived pair, or refuses and says nothing happened.
 *
 * Atomic over the pair rather than per field, which is the whole reason this is not
 * two `applyDerivedFields` calls: writing `dedupeGroup` to one row of a pair and
 * skipping the other because a person had decided it would leave a group of one, and
 * a group of one whose source of truth sits outside it counts for nothing. Net worth
 * would then be missing an account with nothing on screen to say which.
 *
 * The group is *derived*, so neither row is marked decided and a better rule may
 * revise it — but a person ungrouping either row decides `dedupeGroup` on it, and
 * this then leaves the pair alone for ever. That is the stored dismissal: "these two
 * are not the same account" is an answer worth exactly as much as its opposite.
 */
export function applyDerivedMirror(
  db: Db,
  mirror: DerivedMirror,
  now = new Date(),
): string | null {
  return db.transaction((tx) => {
    const pair = tx
      .select()
      .from(accountMap)
      .where(inArray(accountMap.id, [mirror.ghostfolioId, mirror.actualId]))
      .all()
    if (pair.length !== 2) return null
    // Already grouped by anyone, for any reason, is left alone: the existing group is
    // either this same conclusion or a better-informed one.
    if (pair.some((row) => row.dedupeGroup !== null)) return null
    if (pair.some((row) => decidedFields(row).has('dedupeGroup'))) return null

    const group = crypto.randomUUID()
    tx.update(accountMap)
      .set({ dedupeGroup: group, isSourceOfTruth: false, classifiedAt: now })
      .where(eq(accountMap.id, mirror.ghostfolioId))
      .run()
    tx.update(accountMap)
      .set({ dedupeGroup: group, isSourceOfTruth: true, classifiedAt: now })
      .where(eq(accountMap.id, mirror.actualId))
      .run()
    return group
  })
}

/**
 * Makes one account the one that counts, for its whole group.
 *
 * Exclusive by construction: every other row in the same `dedupeGroup` is set
 * false in the same transaction. Two rows marked as the truth for one pot of
 * money would double count it, which is the exact failure `dedupeGroup` exists to
 * prevent — and it fails in the flattering direction, so nothing on the screen
 * would look wrong.
 *
 * An ungrouped row is simply set true and affects nobody, because an account that
 * mirrors nothing is its own source of truth.
 */
export function setSourceOfTruth(db: Db, id: string): AccountMapRow | null {
  const row = db.select().from(accountMap).where(eq(accountMap.id, id)).all()[0]
  if (row === undefined) return null

  return db.transaction((tx) => {
    if (row.dedupeGroup !== null) {
      const group = tx
        .select()
        .from(accountMap)
        .where(eq(accountMap.dedupeGroup, row.dedupeGroup))
        .all()
      tx.update(accountMap)
        .set({ isSourceOfTruth: false })
        .where(eq(accountMap.dedupeGroup, row.dedupeGroup))
        .run()
      // The whole group, not just the row named: choosing one source of truth is
      // simultaneously a decision that the others are not, and a rule that flipped
      // the losers back would undo half of one answer.
      markDecided(tx, group.map((member) => member.id), ['isSourceOfTruth'])
    }
    return (
      tx.update(accountMap)
        .set({ isSourceOfTruth: true })
        .where(eq(accountMap.id, id))
        .returning()
        .all()[0] ?? null
    )
  })
}

/**
 * Groups accounts that hold the same money, generating the group's name.
 *
 * The name is a uuid rather than something readable, because the only thing that
 * reads it is the query that joins the group back together, and a name derived
 * from an account would go stale the moment that account was renamed upstream.
 */
export function groupAccounts(
  db: Db,
  accountMapIds: readonly string[],
  sourceOfTruthId: string,
): string {
  const group = crypto.randomUUID()
  setDedupeGroup(db, group, accountMapIds, sourceOfTruthId)
  return group
}

/**
 * Takes an account back out of its group.
 *
 * It becomes its own source of truth again — a row that is in no group and counts
 * for nothing is invisible money, and the failure would be a net worth quietly
 * missing an account with nothing on screen to say so.
 */
/**
 * Records that a Ghostfolio account is a copy of nothing, so the matcher stops asking.
 *
 * The stored dismissal #131 needs, and it needs no table of its own: "these two are
 * not the same money" is a decision about `dedupeGroup`, and `decided_fields` already
 * holds decisions about `dedupeGroup`. Marking it decided leaves the group `null` — the
 * account keeps counting for itself, which is the whole point — while both the derived
 * matcher and the suggestion list skip the row from then on.
 *
 * Keyed on the account rather than the pair, and that is deliberate rather than lazy.
 * A pair-keyed dismissal is identified by two names, so the next sync that renames
 * either side produces a pair that has never been dismissed and the suggestion returns
 * — which is precisely the failure being fixed. The cost is that dismissing one
 * suggestion dismisses any future one for the same Ghostfolio account; acceptable,
 * because at most one is ever offered, and because the derived matcher in
 * `deriveMirrors` has already grouped the pairs that are unambiguous.
 */
export function dismissMirror(db: Db, id: string): AccountMapRow | null {
  return db.transaction((tx) => {
    const row = tx.select().from(accountMap).where(eq(accountMap.id, id)).all()[0] ?? null
    if (row === null || row.dedupeGroup !== null) return null
    markDecided(tx, [id], ['dedupeGroup'])
    return tx.select().from(accountMap).where(eq(accountMap.id, id)).all()[0] ?? null
  })
}

export function ungroupAccount(db: Db, id: string): AccountMapRow | null {
  return db.transaction((tx) => {
    const row =
      tx
        .update(accountMap)
        .set({ dedupeGroup: null, isSourceOfTruth: true })
        .where(eq(accountMap.id, id))
        .returning()
        .all()[0] ?? null
    if (row === null) return null
    // Ungrouping is as much a decision as grouping was — it says these two accounts
    // are not one — so a matcher must not simply re-propose what was just undone.
    markDecided(tx, [id], ['dedupeGroup', 'isSourceOfTruth'])
    return tx.select().from(accountMap).where(eq(accountMap.id, id)).all()[0] ?? null
  })
}
