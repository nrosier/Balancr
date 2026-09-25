PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- Recreating ai_runs would otherwise fail: ai_spend_monthly still selects from
-- it, and SQLite refuses the rename while a view depends on the table being
-- dropped. Drop it here and recreate it (identically to 0031) after the rename.
DROP VIEW `ai_spend_monthly`;--> statement-breakpoint
CREATE TABLE `__new_ai_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`kind` text NOT NULL,
	`provider` text DEFAULT 'gemini-aistudio' NOT NULL,
	`model` text NOT NULL,
	`prompt_id` text,
	`locale` text NOT NULL,
	`period` text,
	`payload_json` text,
	`payload_hash` text,
	`request_text` text,
	`response_text` text,
	`reused_from_run_id` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cached_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_micro_eur` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	`user_id` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reused_from_run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_ai_runs`("id", "tenant_id", "seq", "kind", "provider", "model", "prompt_id", "locale", "period", "payload_json", "payload_hash", "request_text", "response_text", "reused_from_run_id", "input_tokens", "output_tokens", "cached_tokens", "cache_write_tokens", "cost_micro_eur", "status", "error", "duration_ms", "created_at", "user_id") SELECT "id", "tenant_id", "seq", "kind", "provider", "model", "prompt_id", "locale", "period", "payload_json", "payload_hash", "request_text", "response_text", "reused_from_run_id", "input_tokens", "output_tokens", "cached_tokens", "cache_write_tokens", "cost_micro_eur", "status", "error", "duration_ms", "created_at", "user_id" FROM `ai_runs`;--> statement-breakpoint
DROP TABLE `ai_runs`;--> statement-breakpoint
ALTER TABLE `__new_ai_runs` RENAME TO `ai_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `ai_runs_seq_idx` ON `ai_runs` (`seq`);--> statement-breakpoint
CREATE INDEX `ai_runs_created_idx` ON `ai_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `ai_runs_kind_idx` ON `ai_runs` (`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_runs_period_idx` ON `ai_runs` (`period`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_runs_reuse_idx` ON `ai_runs` (`tenant_id`,`provider`,`period`,`payload_hash`);--> statement-breakpoint
CREATE VIEW `ai_spend_monthly` AS select
    ai_runs.tenant_id as tenant_id,
    strftime('%Y-%m', ai_runs.created_at / 1000, 'unixepoch') as month,
    count(*) as run_count,
    coalesce(sum(ai_runs.input_tokens), 0) as input_tokens,
    coalesce(sum(ai_runs.output_tokens), 0) as output_tokens,
    coalesce(sum(ai_runs.cached_tokens), 0) as cached_tokens,
    coalesce(sum(ai_runs.cache_write_tokens), 0) as cache_write_tokens,
    coalesce(sum(ai_runs.cost_micro_eur), 0) as cost_micro_eur
  from ai_runs
  group by ai_runs.tenant_id, strftime('%Y-%m', ai_runs.created_at / 1000, 'unixepoch');