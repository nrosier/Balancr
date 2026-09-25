# Balancr code review

**Date:** 25 September 2026  
**Repository:** `https://github.com/nrosier/Balancr`  
**Reviewed commit:** `13ae2e651cf23cb02e8a3d58a83064e2c583da70` (`2.4.0`)  
**Assessment areas:** Code quality, consistency, and security  
**Authentication assumption:** The application is protected by OIDC with 2FA or local authentication with 2FA.

## Executive summary

The codebase is unusually disciplined for its size. No critical vulnerability, authentication bypass, obvious cross-tenant disclosure, SQL injection, exploitable XSS, committed secret, or known dependency vulnerability was found under the assumed authentication boundary.

The two most important current issues concern state isolation. An approved Actual write can race with a concurrent proposal decision and leave Actual changed while Balancr records only a rejection. Separately, a host permission described as scoped to one call is held in a process-global map and therefore becomes available to unrelated concurrent fetches for the lifetime of that call.

The connection-test routes also remain an intentional owner-controlled SSRF capability. This is acceptable when tenant owners are trusted network administrators, but needs an operator-controlled destination policy in a mutually untrusted multi-tenant deployment. The remaining findings concern tenant-isolation maintainability, non-atomic local-auth security state, supply-chain pinning, unused configuration, and one flaky test margin.

| ID | Severity | Area | Finding |
| --- | --- | --- | --- |
| F1 | Medium | Security / integrity | An Actual write can race with rejection and escape the durable audit trail |
| F2 | Medium | Security, defense in depth | A supposedly call-scoped egress permission is process-global |
| F3 | Conditional Medium | Security | Tenant owners can make the server contact arbitrary integration destinations |
| F4 | Medium | Quality / maintainability | Tenant isolation relies heavily on manual query predicate discipline |
| F5 | Low | Security | Local-auth counters and TOTP replay protection are non-atomic |
| F6 | Low | Security / consistency | Supply-chain pinning policy is inconsistent |
| F7 | Low | Quality / consistency | `SESSION_SECRET` is mandatory and documented but unused |
| F8 | Low | Quality / reliability | The full test suite has a fragile five-second contrast-test timeout |

## Findings

### F1 — An Actual write can race with rejection and escape the durable audit trail (Medium)

`applyProposal` performs the remote Actual mutation before opening its local database transaction. Another request can reject the proposal while that mutation is in flight. Balancr then reports the proposal as rejected even though Actual was modified.

The implementation now logs this case, but the warning does not prevent the inconsistent state. The audit trail contains only the rejection, and a process crash after the remote write but before the local transaction produces no warning at all.

Evidence:

- `src/domain/ai/proposals.ts:874-972` documents and implements the two-phase remote-write/local-commit sequence.
- `test/unit/ai-proposals.test.ts:643-660` demonstrates rejection during the remote write and confirms that only the rejection audit entry remains.
- `CHANGELOG.md:21-22` identifies the race as a known, accepted tradeoff.

**Recommendation:** Atomically claim the proposal with an `applying` state before remote I/O. Reject, adjust, supersede, and expiry operations should refuse a claimed proposal. Record the remote outcome durably and provide reconciliation for uncertain results after a timeout or process failure.

### F2 — A supposedly call-scoped egress permission is process-global (Medium, defense in depth)

`withScopedHost` says that a tenant-selected host is permitted only for one call, but its state is a module-global `Map`. While one scoped operation is active, every unrelated concurrent fetch in that process can access the same host.

Evidence:

- `src/egress.ts:195-240` stores active host allowances in the module-global `scopedAllowance` map.
- `src/egress.ts:378-383` lets every process fetch use any host present in that map.
- `test/unit/egress.test.ts:194-228` checks before/inside/after behavior and overlapping authorised calls, but not an unrelated concurrent async context.

Tenant-specific Actual worker processes reduce the exposure for normal Actual traffic, because each persistent worker belongs to one tenant. Ghostfolio and integration-test requests still open the global window in the main process.

This does not by itself redirect another tenant's credentials. It weakens the process egress boundary that is intended to constrain compromised or unexpected dependency behavior.

**Recommendation:** Store scoped hosts in `AsyncLocalStorage`, or use a request-bound fetch/dispatcher. Add a regression test proving that an unrelated concurrent fetch remains denied while the scoped task is allowed.

### F3 — Tenant owners can make the server contact arbitrary integration destinations (Conditional Medium)

Actual and Ghostfolio URLs may target arbitrary absolute URLs, including HTTP and private or LAN addresses. Connection tests then temporarily authorise and contact those destinations.

Evidence and mitigations:

- `src/server/routes/settings.ts:614-646` deliberately accepts absolute HTTP/LAN integration URLs and rejects embedded credentials.
- `src/server/routes/settings.ts:2030-2077` contacts the submitted Ghostfolio destination on fixed health and authentication paths.
- `src/server/routes/settings.ts:2204-2227` passes the submitted Actual destination to a forked connection-test worker.
- The routes require the tenant owner, receive the normal CSRF protection, and share a limit of 20 tests per hour (`src/server/rate-limit.ts:125-143`).
- Stored secrets are reused only when the candidate URL has the same origin as the stored integration URL.

This behavior is acceptable if every tenant owner is a trusted network administrator. Two-factor authentication does not remove the risk from a malicious tenant owner or a compromised owner session in a mutually untrusted multi-tenant deployment.

**Recommendation:** For untrusted multi-tenant deployments, add operator-controlled integration destination allowlists or an explicit private-address policy. Otherwise document that tenant owners are trusted to choose server-reachable network destinations.

### F4 — Tenant isolation relies heavily on manual query predicate discipline (Medium maintainability risk)

Tenant IDs are consistently threaded through the current domain calls, and the isolation tests are strong. Isolation nevertheless depends primarily on developers remembering `tenantId` in each query rather than on tenant-bound repository objects or composite database constraints.

The isolation suite explicitly covers representative functions rather than every export (`test/unit/tenant-isolation.test.ts:1-12`). This approach provides useful regression coverage but cannot establish that every new ID-based operation is scoped correctly.

Risk is concentrated in several very large production modules:

- `src/server/routes/settings.ts`: 2,931 lines
- `src/server/routes/api/schemas.ts`: 2,554 lines
- `src/db/schema.ts`: 1,683 lines
- `src/domain/ai/prompts.ts`: 1,666 lines
- `web/src/settings/Benchmark.tsx`: 1,353 lines
- `web/src/settings/Prompts.tsx`: 1,348 lines

**Recommendation:** Introduce tenant-bound repositories or services, split settings routes by resource, and add a two-tenant route-level matrix for every ID-based read and mutation.

### F5 — Local-auth counters and TOTP replay protection are non-atomic (Low)

Local login reads `failedAttempts` and `lastTotpStep`, awaits Argon2 verification, and later writes values calculated from the stale row (`src/server/auth/local.ts:150-240`). Parallel requests can therefore overlap across the asynchronous password check.

Consequences:

- Several failed attempts can all read the same counter and each write the same incremented value, weakening the five-attempt account lockout.
- Two requests using the same valid TOTP can both pass the freshness check and mint sessions.

The local-login CIDR gate, mandatory second factor, and limit of ten attempts per IP per fifteen minutes substantially reduce practical impact.

**Recommendation:** Use atomic SQL increments for failures. Consume a TOTP with a conditional update such as `WHERE last_totp_step IS NULL OR last_totp_step < ?`, and accept the login only when exactly one row changes.

### F6 — Supply-chain pinning policy is inconsistent (Low)

Most GitHub Actions and Docker base images are pinned to immutable commits or digests, but several important paths remain mutable:

- `.github/workflows/image.yml:75` uses `aquasecurity/trivy-action@v0.36.0`.
- `.github/workflows/ci.yml:91-94` runs `zricethezav/gitleaks:latest` with the checkout mounted into the container.
- `compose.yaml:8` defaults to `niqck/balancr:latest`.
- `.github/workflows/ci.yml:17-20` states that the actions below are commit-SHA pinned.
- `renovate.json:26-29` broadly disables digest pinning, while the Dockerfiles deliberately retain reviewed digests.

**Recommendation:** Pin Trivy to a commit, Gitleaks to a reviewed digest or immutable version, and the production Compose default to a release tag or digest. Update the Renovate rule and comments so the declared policy matches the implemented one.

### F7 — `SESSION_SECRET` is mandatory and documented but unused (Low)

`SESSION_SECRET` is required at startup (`src/config.ts:134-136`), logged as configured, included in `.env.example`, and documented as a sensitive authentication secret. A repository-wide runtime search found no consumer outside configuration, tests, and verification scripts.

That matches the actual session design in `src/server/auth/sessions.ts`: browsers receive random 32-byte opaque tokens, the database stores their SHA-256 hashes, and no trusted cookie payload needs signing. `src/server/app.ts:140-143` explicitly explains why the cookie plugin has no signing key.

This creates false operational assurance and needless secret-management burden rather than an immediate vulnerability.

**Recommendation:** Remove `SESSION_SECRET` from the schema, example environment, scripts, tests, logs, and documentation unless a concrete cryptographic purpose is introduced.

### F8 — The full test suite has a fragile five-second contrast-test timeout (Low)

The full permitted test run passed 4,061 of 4,062 tests. The sole failure was the final application-wide contrast test timing out under full parallel load. Running the contrast file alone passed all six tests in 4.33 seconds.

Each test launches `npx tsx` synchronously (`test/unit/web-contrast.test.ts:38-52`), while the application-wide case at lines 96-100 uses Vitest's default five-second timeout.

**Recommendation:** Give this child-process integration test an explicit larger timeout, invoke the script without repeated `npx` startup, or expose a direct module seam for the test.

## Positive observations

- TypeScript uses strict settings, including unchecked indexed-access and exact optional-property checks.
- Type-aware linting checks floating promises and unused values.
- Authentication and CSRF protection are deny-by-default hooks rather than route-by-route opt-ins.
- Sessions use server-side random tokens, store only their hashes, and reject disabled users.
- OIDC uses state, nonce, PKCE, and a redirect derived from the configured public base URL.
- Local authentication uses Argon2id, mandatory TOTP, a CIDR gate, rate limiting, and account lockout.
- Fastify has a bounded request body, generic error envelopes, secure cookie attributes, and a CSP without `unsafe-inline`.
- Sensitive database fields use AES-GCM; backups use a password-derived key and AES-GCM.
- The container runs non-root, read-only, with dropped capabilities.
- Tenant IDs are consistently present across current routes, domain calls, jobs, and AI data access.
- Markdown is escaped before a fixed HTML tag set is emitted; the limited `dangerouslySetInnerHTML` uses consume that sanitised output.
- Production and development dependency audits were clean at review time.
- The test suite is large, has no skipped or focused tests, and includes meaningful multi-tenant behavior checks.

## Previously reported issues now resolved

The following findings from the earlier security assessment were verified as fixed and are not repeated as current defects:

- Stored Actual and Ghostfolio secrets are no longer reused with a different candidate origin.
- Changing a stored integration host clears the secret associated with the old host.
- The persistent Actual worker installs its own egress guard and scopes traffic to its tenant's server.
- AI retention clears `payload_json` together with request and response text.
- User-facing documentation now discloses the unredacted month-note exception and approved Actual writes.

The proposal race remains present. Version 2.4.0 added logging for one race outcome, but did not make the state transition durable or prevent the external/local inconsistency described in F1.

## Validation

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed |
| `npm run i18n:check` | Passed: 9 namespaces, 2 languages, 1,370 keys each |
| `npm run badges:check` | Passed |
| `npm run skips:check` | Passed: 181 files, no skipped or focused tests |
| `npm run contrast:check` | Passed: 49 pairs in both themes |
| Full test suite in permitted runtime | 4,061 passed, 1 timeout failure |
| Isolated contrast suite | 6 passed |
| `npm audit --omit=dev --json` | No known vulnerabilities |
| Full `npm audit --json` | No known vulnerabilities across 506 dependencies |
| Gitleaks repository-history scan | 703 commits scanned, no leaks found |
| Repository status after review | Clean; `main` matched `origin/main` |

The production build is code-split. Its largest generated chunk was ECharts at approximately 642 KB uncompressed and 218 KB gzip. This is worth monitoring as a performance concern but is not a correctness or security defect.

## Assessment limits

This was a local source review, repository-history secret scan, dependency audit, and automated test/build review. No live Actual, Ghostfolio, AI provider, production database, or deployed network was attacked. No cloud IAM review, container-image vulnerability scan, dynamic browser penetration test, or network-level egress verification was performed. Dependency audit results cover published advisories available at the time of the review, not unpublished vulnerabilities.

## Recommended order

1. Make proposal application durable across remote I/O and concurrent decisions (F1).
2. Replace the process-global scoped-host allowance with async-context or transport-level isolation (F2).
3. Decide and document whether tenant owners are trusted network administrators; add destination restrictions if they are not (F3).
4. Introduce tenant-bound data-access abstractions while splitting the largest route and schema modules (F4).
5. Make local-auth replay and failure state atomic (F5).
6. Align supply-chain pinning, remove the unused session secret, and stabilise the contrast test (F6-F8).
