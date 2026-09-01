import { defineConfig } from 'drizzle-kit'

// `casing` must match src/db/index.ts, or generated DDL will not match runtime
// queries. DATABASE_PATH is only needed for push/introspect, not generate.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? './data/balancr.db',
  },
  strict: true,
  verbose: true,
})
