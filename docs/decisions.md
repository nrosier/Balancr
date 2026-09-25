# Design decisions

A log of deliberate tradeoffs — cases where a review or an issue flagged
something that looks like a gap, and the considered answer was "leave it,
for this reason" rather than a code change. Each entry links the issue that
raised it and the code that documents the decision at the point of use, so a
future review doesn't have to re-derive the same reasoning from scratch.

This is not a changelog of what shipped — see [`../CHANGELOG.md`](../CHANGELOG.md)
for that. It's a log of what was *decided not* to change, and why.

## A remote Actual write can outlive a rejected proposal

**Decision:** `applyProposal` writes to Actual before opening its local
`db.transaction`. If another request rejects the same proposal while that
remote write is in flight, the write already happened but the local commit is
refused — Balancr's own record shows "rejected" while Actual shows the
change applied. This is accepted rather than fixed with an atomic
claim/durable state machine, because both remote write handlers are
idempotent: recovery is "notice it happened, manually re-apply or revert,"
never a double-apply. Adding an `applying` claim state and reconciliation
machinery was considered and rejected as unneeded complexity for a race this
narrow.

**What did change:** the race is now logged (`log.warn`, #540) with the
proposal's id, type and target ref, so the manual re-apply case has something
to notice it by. A later review (F1, 2026-09-25) re-raised the same
recommendation the original issue had already declined; it was not re-opened.

**Where:** `src/domain/ai/proposals.ts` — see `applyProposal`'s own docstring
for the full reasoning. **Issues:** [#540](https://github.com/nrosier/Balancr/issues/540).

## Tenant owners are trusted to choose integration destinations

**Decision:** an Actual or Ghostfolio URL a tenant owner enters is accepted as
any absolute URL — plain `http://`, a private/LAN address, a Docker-network
hostname — with no scheme restriction and no block on internal destinations.
The "test connection" routes will contact whatever is submitted. This is
deliberate: self-hosted Actual/Ghostfolio routinely run on exactly those kinds
of addresses, and blocking them would break normal self-hosted setups. The
blast radius is bounded instead of eliminated — owner-only access, CSRF
protection, a 20-tests/hour rate limit, and stored secrets that only follow a
*matching* host (`sameHost`, #534/#535) — not by restricting the destination
itself.

**Who this assumes:** a tenant owner is trusted to choose a destination the
server is allowed to reach. A deployment where tenant owners are *not*
mutually trusted (e.g. a hosted multi-tenant offering with unrelated tenants)
should put an operator-controlled destination policy or network-level egress
restriction in front of Balancr rather than expect the app to filter it.

**Where:** the `integrationUrl` schema's own comment in
`src/server/routes/settings.ts`. **Issues:**
[#549](https://github.com/nrosier/Balancr/issues/549) (this entry is that
issue's fix — documenting the assumption, not changing the code).

## The production Compose file defaults to a mutable image tag

**Decision:** `compose.yaml`'s `${BALANCR_IMAGE:-niqck/balancr:latest}`
default tracks the newest non-RC release rather than a pinned digest. This is
an example file for a self-hosted installer, not a supply-chain-controlled
deployment pipeline — pinning is the installer's call to make for their own
environment, and `latest` is the sane default for someone following the quick
start for the first time. `docker pull` resolving `latest` to the current
version is documented in the README's versioning section.

**Where:** `compose.yaml:8`. **Issues:** raised and closed without a code
change during triage of the 2026-09-25 code review; tracked instead in
[#551](https://github.com/nrosier/Balancr/issues/551), which is scoped to the
two CI images that *do* need pinning (Trivy, Gitleaks) and explicitly excludes
this one.

## Renovate does not pin Docker base image digests

**Decision:** `renovate.json` disables digest pinning (`pinDigests: false`)
even though the Dockerfile's base images are pinned to reviewed digests. The
two aren't in conflict: a Renovate-proposed digest bump for a base image is a
diff of two opaque hashes with nothing to review, so those pins are updated
and reviewed by hand instead, on the maintainer's own schedule, and Renovate
is left to handle everything else (npm dependencies, GitHub Actions versions)
where a version-to-version diff is actually reviewable.

**Where:** `renovate.json`'s own comment beside `pinDigests: false`.
**Issues:** same triage as above — explicitly excluded from
[#551](https://github.com/nrosier/Balancr/issues/551).
