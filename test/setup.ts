/**
 * Minimal valid environment for tests. config.ts validates at import time, so
 * this must run before any test file imports it (vitest `setupFiles`).
 */
process.env.NODE_ENV = 'test'
// Several tests deliberately drive failure paths that log at error level.
process.env.LOG_LEVEL = 'silent'
process.env.PUBLIC_BASE_URL = 'http://localhost:3000'
process.env.DATABASE_PATH = ':memory:'
process.env.ACTUAL_SERVER_URL = 'http://actual.test:5006'
process.env.ACTUAL_PASSWORD = 'test-password'
process.env.ACTUAL_SYNC_ID = 'test-sync-id'
process.env.GHOSTFOLIO_URL = 'http://ghostfolio.test:3333'
process.env.GHOSTFOLIO_SECURITY_TOKEN = 'test-token'
process.env.GEMINI_PROVIDER = 'aistudio'
process.env.GEMINI_API_KEY = 'test-key'
process.env.SESSION_SECRET = 'x'.repeat(48)
process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.AUTH_LOCAL_ENABLED = 'true'
// Pinned rather than left to whatever a developer's own .env happens to say — a test
// that bursts past this limit needs its runtime bounded, not tied to a value that can
// go as high as 1000 (#47).
process.env.RATE_LIMIT_AI_PER_HOUR = '30'
