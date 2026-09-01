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
process.env.AUTH_LOCAL_ENABLED = 'true'
