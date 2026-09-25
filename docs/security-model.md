# Security model

How Balancr defends its container, its outbound network access, and its
secrets — and where each of those defenses stops on purpose. For decisions
about specific reported findings that were deliberately *not* changed, see
[`decisions.md`](decisions.md).

## Container

The container runs as UID 1000, non-root, on a read-only root filesystem, with
every Linux capability dropped and `no-new-privileges` set. Everything
writable is the one volume — SQLite and Actual's sync cache — plus a 64 MB
`tmpfs` for `/tmp`.

None of that is taken on trust, because all of it is configuration until
something checks it. `scripts/verify-image.sh` starts the built image with
exactly the flags `compose.yaml` uses and then asks the running container:
which uid is this, does `/app` really refuse a write, does `/data` really
accept one, is `CapEff` all zeroes, do both native modules load, and does the
image's own `HEALTHCHECK` command actually work — a broken one makes Docker
restart a perfectly healthy container every interval, forever. CI runs it on
every image build and records the image size and the time to first response
in the job summary, so a change that doubles either is something a reviewer
walks past rather than has to go looking for. By hand:

```sh
docker build -t balancr:test . && scripts/verify-image.sh balancr:test
```

## Egress

Balancr refuses to connect to a host nobody configured. The allowlist is
derived from `.env` and tenant integration rows — Actual, Ghostfolio, the OIDC
issuer and the fixed host for each selected built-in AI provider — so there is
no second list to keep in step: moving Ghostfolio to a new hostname needs no
edit here.

| | |
|---|---|
| `EGRESS_MODE=enforce` | the default: refuse the connection and log the host |
| `EGRESS_MODE=warn` | allow it and log the host — how to see what a new dependency wants before deciding whether it should have it |
| `EGRESS_MODE=off` | leave `fetch` alone |
| `EGRESS_EXTRA_HOSTS` | additional hostnames to allow, including an outbound proxy or approved custom AI endpoint |

A denial logs the host and never the path or query, because on an
exfiltration attempt the query string *is* the data being exfiltrated.

What this defends against is a dependency rather than a network. This process
holds the Actual password, the Ghostfolio token, the selected AI key and a
database of your finances, and the realistic attack on that is a compromised
transitive package posting the lot somewhere. It wraps global `fetch`, so it
covers the Ghostfolio adapter, the Gemini SDK, the native Anthropic client,
`openid-client` and anything else using the standard API; it does **not**
cover a library that reaches for `node:http` directly, a native module, or a
child process, and it is not a sandbox — code running in this process can put
the original `fetch` back.
So: a real barrier against accidental and casual exfiltration, an audit trail
for anything unexpected, and no claim to stop an attacker who already runs
code here. That last one is what the network layer is for, and it is worth
having as well: Docker networks cannot express this application-level host
allowlist, so that version of the rule lives on the host firewall or in
whatever egress gateway the network already has.

An allowlist rather than a blocklist, because the question this answers —
which few hosts may this process reach — is small and enumerable, while "which
hosts are dangerous" is not: a blocklist could never keep up with an unknown
compromised dependency reaching for an address nobody thought to list. The
trade-off is that every check here is a hostname string match, never a check
of the IP that name resolves to — so a host already on the list (an
`EGRESS_EXTRA_HOSTS` entry, or Actual/Ghostfolio's own configured URL) whose
DNS record is later hijacked would still pass (#467). This is a different
trust assumption than the "attacker who already runs code here" one just
above: rebinding an approved host needs no code running in this process at
all, only control of the DNS record for a name the operator already trusted
when they added it — a compromised registrar or DNS provider, or a domain
that lapsed and was re-registered by someone else. That gap is left
undefended on purpose: closing it needs a `fetch` dispatcher that inspects the
resolved socket address before the handshake completes, which is real ongoing
complexity for a threat that requires the attacker to first gain that DNS
control. A hostname nobody approved is refused regardless of what it resolves
to; that part never depends on DNS at all.

### Per-tenant scoped hosts

A tenant's own Actual/Ghostfolio URL is not in the allowlist above — it is
granted only for the duration of a call made on that tenant's behalf, via
`withScopedHost` in `src/egress.ts` (#535, #536). This keeps one tenant's
configured integration host from permanently widening what *any* fetch in the
process can reach. The mechanism's current implementation (a process-global
map rather than a per-call context) has a narrower residual gap — see
[#548](https://github.com/nrosier/Balancr/issues/548).

Tenant-controlled Actual/Ghostfolio URLs are themselves unrestricted — no
scheme check, no block on private/internal addresses — because self-hosted
Actual/Ghostfolio commonly run on plain `http://` over a LAN or Docker
network. See [`decisions.md`](decisions.md#tenant-owners-are-trusted-to-choose-integration-destinations)
for that trust assumption spelled out.

## The `.env` file

It holds the Actual password, the Ghostfolio token, the initial Gemini key,
the session secret and the backup passphrase — the whole set, in plain text.
`chmod 600 .env`, which the quick start does, and which Balancr checks at
every start: a group- or world-readable file gets one warning naming the mode
and the command that fixes it. A warning, not a refusal — the mode of a file
is not a reason to leave someone without their budget page.

Inside a container there is normally no such file at all: compose reads
`.env` on the host and passes the values as environment variables, so the
check is silent there and speaks up for installs running from source.
