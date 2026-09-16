CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `account_map` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `ai_findings` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `ai_narratives` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `ai_runs` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `audit_log` ADD `tenant_id` text;--> statement-breakpoint
ALTER TABLE `category_guess_candidates` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `category_meta` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `clarification_queue` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `job_runs` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `jobs` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `monthly_category_facts` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `monthly_hygiene` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `monthly_signals` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `monthly_totals` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `net_worth_snapshots` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `portfolio_metrics` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `portfolio_snapshots` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `proposals` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `rate_limits` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `recompute_mismatches` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `settings` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `upstream_probes` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
ALTER TABLE `users` ADD `tenant_id` text REFERENCES tenants(id);--> statement-breakpoint
DROP VIEW `ai_spend_monthly`;--> statement-breakpoint
CREATE VIEW `ai_spend_monthly` AS select
    ai_runs.tenant_id as tenant_id,
    strftime('%Y-%m', ai_runs.created_at / 1000, 'unixepoch') as month,
    count(*) as run_count,
    coalesce(sum(ai_runs.input_tokens), 0) as input_tokens,
    coalesce(sum(ai_runs.output_tokens), 0) as output_tokens,
    coalesce(sum(ai_runs.cached_tokens), 0) as cached_tokens,
    coalesce(sum(ai_runs.cost_micro_eur), 0) as cost_micro_eur
  from ai_runs
  group by ai_runs.tenant_id, strftime('%Y-%m', ai_runs.created_at / 1000, 'unixepoch');