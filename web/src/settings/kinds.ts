/**
 * The account kinds the mapping panel offers, and why they are written out here.
 *
 * The kinds are defined once, in `accountSettingSchema` — and that definition is Zod,
 * which imports `config`, which reads `process.env`. `shared.ts` takes every response
 * shape from that file as a *type* for exactly this reason: a value import would put
 * the server's environment validation into the browser bundle for the sake of six
 * strings.
 *
 * Deriving the list from the accounts on screen would be worse than repeating it. A
 * deployment whose Actual budget holds only current accounts would offer no other kind,
 * so nobody could ever mark one a credit card — and getting that wrong is not cosmetic,
 * because `credit` is what stops a card payment from being counted as spend.
 *
 * `test/unit/web-contract.test.ts` asserts this list against the schema's own enum. It
 * lives on the server side of the split because that is the side that can import Zod;
 * a `web/` test cannot, which is the whole reason this file exists.
 *
 * Its own module rather than a constant in `Accounts.tsx` for the same reason: a `.tsx`
 * file cannot be imported by a test running in the Node project, and a contract
 * assertion that cannot run is not one.
 */
export const ACCOUNT_KINDS = [
  'checking',
  'savings',
  'credit',
  'investment',
  'cash',
  'other',
] as const

export type AccountKind = (typeof ACCOUNT_KINDS)[number]
