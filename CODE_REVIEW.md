# Code Review

## Verdict

The application has strong single-tenant security, but it is **not safe for mutually untrusted multi-tenant use yet**. The code quality is generally high, with excellent validation, documentation, and tests, but several tenant filters were missed.

## Findings

### 1. Critical — cross-tenant category disclosure and modification

[`src/domain/benchmark/mapping.ts`](src/domain/benchmark/mapping.ts) reads every tenant's categories and spending without a `tenantId`. Its writers update solely by category ID. The authenticated settings routes in [`src/server/routes/settings.ts`](src/server/routes/settings.ts) call these functions directly.

An in-memory regression check confirmed that tenant A can read tenant B's category and modify it. This exposes category names and spending and permits changing custody, AI visibility, nature, and COICOP settings.

Pass `tenantId` through every mapping function and constrain every query and update by it.

### 2. High — AI prompts are global across tenants

The prompt table in [`src/db/schema.ts`](src/db/schema.ts) has no tenant column. Prompt resolution and activation in [`src/domain/ai/prompts.ts`](src/domain/ai/prompts.ts) are consequently global.

Any tenant owner can change the system prompt used for every household through [`src/server/routes/settings.ts`](src/server/routes/settings.ts). This allows cross-tenant manipulation of advice and AI spending.

Add `tenantId` to prompts and their unique indexes, scope every prompt operation to it, seed defaults per tenant, and add two-tenant route tests.

### 3. Medium — AI spending and budget enforcement are not tenant-scoped

Although `ai_spend_monthly` groups by tenant, `loadSpendMonth` and `loadSpendHistory` in [`src/domain/ai/budget.ts`](src/domain/ai/budget.ts) filter only by month.

Another tenant's usage can appear in settings and may incorrectly exhaust or restore a household's AI allowance. Both functions should require `tenantId` and filter the view by tenant and month.

### 4. Medium — egress protection has bypasses

The wrapper in [`src/egress.ts`](src/egress.ts) validates only the initial URL and then gives it to automatically redirecting `fetch`. Redirect destinations are therefore not checked by the wrapper.

The forked Actual connection test in [`src/adapters/actual/test-connection.ts`](src/adapters/actual/test-connection.ts) does not install the egress guard at all.

Use manual redirect handling with validation at every hop and install equivalent protection inside workers. Network-level egress restrictions should remain the authoritative boundary.

### 5. Medium reliability — restore is not rollback-safe after moving the live database

[`src/backup/restore.ts`](src/backup/restore.ts) moves the database and sidecars before installing the replacement. A failure during those renames or the final rename can leave the live path absent or partially moved, despite the CLI claiming nothing changed. Existing same-second pre-restore names may also be overwritten.

Preflight destination names, use collision-resistant backup names, and roll moved files back if any later rename fails.

### 6. Low — audit tenant metadata is currently discarded

`audit_log` in [`src/db/schema.ts`](src/db/schema.ts) has a `tenantId`, but `recordAudit` and `loadAuditTrail` in [`src/domain/audit.ts`](src/domain/audit.ts) neither write nor filter it.

There is no current HTTP audit endpoint, but this creates incorrect records and a future isolation hazard. Make `tenantId` mandatory for every audit entry and query.

## Quality assessment

Overall quality is above average. Notable strengths include:

- deny-by-default authentication;
- CSRF protection and secure cookie handling;
- a restrictive Content Security Policy;
- strict Zod validation and deliberate error envelopes;
- encrypted credentials and authenticated encrypted backups;
- parameterized database access;
- careful AI redaction and output rendering;
- extensive automated tests and unusually clear design commentary;
- a hardened non-root, read-only container configuration.

The main maintainability problem is scale combined with manual tenant filtering. Files such as `src/server/routes/settings.ts` exceed 1,800 lines, and tenant isolation depends on remembering a `tenantId` predicate in every query.

Introduce tenant-bound repositories or services so an unscoped query is difficult to express. A representative-test strategy is insufficient for a security boundary: the category mapping and AI budget paths were omitted despite broad tenant-isolation coverage.

## Recommended improvements

1. Fix the category mapping read/write leak before enabling multiple tenants.
2. Make prompts, AI spending, and audit records tenant-scoped.
3. Add two-tenant HTTP tests for every settings reader and writer.
4. Re-enable the stale skipped isolation test in `test/unit/settings-invites.test.ts`.
5. Fail CI on skipped tests and add linting.
6. Add dependency and container-image scanning to CI; the Harbor scan is currently disabled.
7. Pin CI actions and images by commit or digest and enable build provenance.
8. Split the 1.32 MB frontend bundle by route and lazy-load ECharts.
9. Harden backup restore with rollback behavior and failure-injection tests.
10. Treat the application-level egress wrapper as defence in depth and enforce the actual boundary at the network layer.

## Verification performed

- 3,338 tests passed; 1 test was skipped.
- Type checking passed.
- The production build passed.
- i18n parity, badge, web-asset, and contrast checks passed.
- `npm audit --omit=dev`: 0 known production vulnerabilities.
- Gitleaks scanned 359 commits and found no leaks.
- A contained in-memory check reproduced both the cross-tenant category read and write.

## Overall assessment

For a single household, this is a thoughtfully secured application with high-quality engineering practices. For multi-tenant operation, the category mapping defect is a release-blocking security issue, and the prompt and AI-budget scoping defects should be fixed in the same hardening pass.
