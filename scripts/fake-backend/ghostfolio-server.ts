#!/usr/bin/env tsx
/**
 * A fake Ghostfolio, for local dev without a real instance (#391).
 *
 * Implements exactly the 5 routes `src/adapters/ghostfolio/client.ts` and
 * `scripts/probe.ts` call — no more, since nothing else in this codebase
 * talks to Ghostfolio. Point `GHOSTFOLIO_URL` at this server's address and
 * `GHOSTFOLIO_SECURITY_TOKEN` at anything non-empty; the token is never
 * actually checked.
 *
 * Run: `npm run fake:ghostfolio`. Port defaults to 4333, override with
 * `FAKE_GHOSTFOLIO_PORT`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { loadOrCreateGhostfolioData } from './ghostfolio-data.ts'

const PORT = Number(process.env.FAKE_GHOSTFOLIO_PORT ?? 4333)

function heading(text: string): void {
  process.stdout.write(`\n\x1b[1m${text}\x1b[0m\n`)
}
function ok(text: string): void {
  process.stdout.write(`\x1b[32m✓\x1b[0m ${text}\n`)
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) })
  res.end(json)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const dataset = loadOrCreateGhostfolioData()

  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/'

      if (req.method === 'POST' && path === '/api/v1/auth/anonymous') {
        await readBody(req) // drain, unread — the fake accepts any access token.
        send(res, 200, { authToken: 'fake-ghostfolio-jwt' })
        return
      }

      if (req.method === 'GET' && path === '/api/v1/health') {
        send(res, 200, { status: 'ok' })
        return
      }

      if (req.method === 'GET' && path === '/api/v1/portfolio/details') {
        send(res, 200, { holdings: dataset.holdings, summary: dataset.summary })
        return
      }

      if (req.method === 'GET' && path === '/api/v2/portfolio/performance') {
        send(res, 200, dataset.performance)
        return
      }

      if (req.method === 'GET' && path === '/api/v1/account') {
        send(res, 200, { accounts: dataset.accounts })
        return
      }

      send(res, 404, { message: `not found: ${req.method} ${path}` })
    })()
  })

  await new Promise<void>((resolve) => server.listen(PORT, resolve))
  heading('Fake Ghostfolio')
  ok(`listening on http://localhost:${PORT}`)
  ok(`${dataset.holdings.length} holdings, ${dataset.accounts.length} accounts`)
  process.stdout.write('\nPress Ctrl-C to stop.\n')
}

await main()
