ALTER TABLE `tenant_integrations` RENAME COLUMN "gemini_provider" TO "ai_provider";--> statement-breakpoint
ALTER TABLE `tenant_integrations` RENAME COLUMN "gemini_api_key_enc" TO "ai_api_key_enc";--> statement-breakpoint
ALTER TABLE `tenant_integrations` RENAME COLUMN "gemini_model_fast" TO "ai_model_fast";--> statement-breakpoint
ALTER TABLE `tenant_integrations` RENAME COLUMN "gemini_model_deep" TO "ai_model_deep";--> statement-breakpoint
ALTER TABLE `tenant_integrations` RENAME COLUMN "gemini_monthly_budget_eur_micro" TO "ai_monthly_budget_eur_micro";--> statement-breakpoint
UPDATE `tenant_integrations`
SET `ai_provider` = CASE `ai_provider`
  WHEN 'vertex' THEN 'gemini-vertex'
  ELSE 'gemini-aistudio'
END;--> statement-breakpoint
DROP INDEX `ai_runs_reuse_idx`;--> statement-breakpoint
ALTER TABLE `ai_runs` ADD `provider` text DEFAULT 'gemini-aistudio' NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_runs` ADD `cache_write_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Google reported cached reads inside promptTokenCount. The neutral ledger uses
-- four non-overlapping bins, so convert historical input to ordinary input.
UPDATE `ai_runs`
SET `input_tokens` = max(0, `input_tokens` - `cached_tokens`);--> statement-breakpoint
UPDATE `ai_runs`
SET `provider` = coalesce(
  (SELECT `ai_provider`
   FROM `tenant_integrations`
   WHERE `tenant_integrations`.`tenant_id` = `ai_runs`.`tenant_id`),
  'gemini-aistudio'
);--> statement-breakpoint
CREATE INDEX `ai_runs_reuse_idx` ON `ai_runs` (`tenant_id`,`provider`,`period`,`payload_hash`);--> statement-breakpoint
DROP VIEW `ai_spend_monthly`;--> statement-breakpoint
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
