# Architecture

```
Fastify ──┬── /api/*     read-only, against Balancr's own SQLite
          ├── /auth/*    OIDC (Authentik) + CIDR-gated local login
          └── static     Vite/React SPA, everything bundled locally
          │
cron ─────┴── sync → aggregate → snapshot → nightly AI run → encrypted backup
          │
adapters ─┼── actual/      @actual-app/api, sole owner of the sync dataDir
          ├── ghostfolio/  REST, capability-probed
          └── ai/          provider-neutral call, usage and pricing boundary
                ├── gemini/  native AI Studio and Vertex implementation
                ├── openai-compatible/  OpenAI, xAI and approved custom endpoints
                └── anthropic/  native Claude Messages API
```

One container, modular inside. The one hard constraint is that a single process
owns Actual's `dataDir` — its API is a local sync engine over SQLite, not a REST
client, and it makes no concurrency guarantees. Operations are serialised for the
same reason.

## Multi-tenant process shape

Each tenant's Actual traffic runs in its own long-lived forked child process
(`src/adapters/actual/client.ts`'s `getOrSpawnWorker`), one process per tenant,
because `@actual-app/api`'s sync engine is the thing that owns `dataDir` and
that ownership is per-process. Everything else — the HTTP API, the job
scheduler, the Ghostfolio adapter, the AI layer — runs in the one main process
and is scoped to a tenant by an explicit `tenantId` threaded through each call,
not by process isolation. See [`security-model.md`](security-model.md) for what
that means for the egress guard specifically.

A one-shot forked child (`src/adapters/actual/test-worker.ts`) handles the
Actual "test connection" flow the same way, so a bad candidate URL or a stuck
sync can't affect a tenant's real, long-lived worker.
