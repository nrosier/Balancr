-- Hand-authored data migration (#367): seed the one tenant every existing
-- deployment implicitly already has, and backfill every row so today's
-- single-shared-instance behaviour is preserved exactly. drizzle-kit can only
-- diff schema.ts against the DB, not author INSERT/UPDATE statements, so this
-- is the one migration in this project's history with hand-written SQL and
-- data rather than a generated diff.
--
-- The id and timestamp are literals rather than SQLite functions: SQLite has
-- no UUID generator, and a fixed timestamp keeps this migration reproducible.
INSERT INTO `tenants` (`id`, `label`, `created_at`)
VALUES ('d020a702-3d59-456c-a944-99c04894a42c', 'Default', 1789566155323);
--> statement-breakpoint

UPDATE `users` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `account_map` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `category_meta` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `clarification_queue` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `monthly_category_facts` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `monthly_totals` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `recompute_mismatches` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `monthly_hygiene` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `monthly_signals` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `category_guess_candidates` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `net_worth_snapshots` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `portfolio_snapshots` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `portfolio_metrics` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `ai_runs` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `ai_findings` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `ai_narratives` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `proposals` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `audit_log` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `jobs` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `job_runs` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `upstream_probes` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `rate_limits` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
--> statement-breakpoint
UPDATE `settings` SET `tenant_id` = 'd020a702-3d59-456c-a944-99c04894a42c' WHERE `tenant_id` IS NULL;
