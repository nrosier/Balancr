PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_account_map` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`include_in_net_worth` integer DEFAULT true NOT NULL,
	`off_budget` integer DEFAULT false NOT NULL,
	`dedupe_group` text,
	`is_source_of_truth` integer DEFAULT true NOT NULL,
	`decided_fields` text,
	`classified_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_account_map`("id", "tenant_id", "source", "external_id", "name", "kind", "include_in_net_worth", "off_budget", "dedupe_group", "is_source_of_truth", "decided_fields", "classified_at", "created_at") SELECT "id", "tenant_id", "source", "external_id", "name", "kind", "include_in_net_worth", "off_budget", "dedupe_group", "is_source_of_truth", "decided_fields", "classified_at", "created_at" FROM `account_map`;--> statement-breakpoint
DROP TABLE `account_map`;--> statement-breakpoint
ALTER TABLE `__new_account_map` RENAME TO `account_map`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `account_map_source_external_uq` ON `account_map` (`tenant_id`,`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `account_map_dedupe_idx` ON `account_map` (`dedupe_group`);--> statement-breakpoint
CREATE TABLE `__new_ai_narratives` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`run_id` text NOT NULL,
	`period` text NOT NULL,
	`locale` text NOT NULL,
	`body_md` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_ai_narratives`("id", "tenant_id", "run_id", "period", "locale", "body_md", "created_at") SELECT "id", "tenant_id", "run_id", "period", "locale", "body_md", "created_at" FROM `ai_narratives`;--> statement-breakpoint
DROP TABLE `ai_narratives`;--> statement-breakpoint
ALTER TABLE `__new_ai_narratives` RENAME TO `ai_narratives`;--> statement-breakpoint
CREATE UNIQUE INDEX `ai_narratives_period_locale_uq` ON `ai_narratives` (`tenant_id`,`period`,`locale`);--> statement-breakpoint
-- Recreating ai_runs would otherwise fail: ai_spend_monthly still selects from
-- it, and SQLite refuses the rename while a view depends on the table being
-- dropped. Drop it here and recreate it (identically to 0023) after the rename.
DROP VIEW `ai_spend_monthly`;--> statement-breakpoint
CREATE TABLE `__new_ai_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text NOT NULL,
	`model` text NOT NULL,
	`prompt_id` text,
	`locale` text NOT NULL,
	`period` text,
	`payload_json` text NOT NULL,
	`payload_hash` text,
	`reused_from_run_id` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cached_tokens` integer DEFAULT 0 NOT NULL,
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
INSERT INTO `__new_ai_runs`("id", "tenant_id", "kind", "model", "prompt_id", "locale", "period", "payload_json", "payload_hash", "reused_from_run_id", "input_tokens", "output_tokens", "cached_tokens", "cost_micro_eur", "status", "error", "duration_ms", "created_at", "user_id") SELECT "id", "tenant_id", "kind", "model", "prompt_id", "locale", "period", "payload_json", "payload_hash", "reused_from_run_id", "input_tokens", "output_tokens", "cached_tokens", "cost_micro_eur", "status", "error", "duration_ms", "created_at", "user_id" FROM `ai_runs`;--> statement-breakpoint
DROP TABLE `ai_runs`;--> statement-breakpoint
ALTER TABLE `__new_ai_runs` RENAME TO `ai_runs`;--> statement-breakpoint
CREATE INDEX `ai_runs_created_idx` ON `ai_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `ai_runs_kind_idx` ON `ai_runs` (`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_runs_period_idx` ON `ai_runs` (`period`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_runs_reuse_idx` ON `ai_runs` (`tenant_id`,`period`,`payload_hash`);--> statement-breakpoint
CREATE VIEW `ai_spend_monthly` AS select
    ai_runs.tenant_id as tenant_id,
    strftime('%Y-%m', ai_runs.created_at / 1000, 'unixepoch') as month,
    count(*) as run_count,
    coalesce(sum(ai_runs.input_tokens), 0) as input_tokens,
    coalesce(sum(ai_runs.output_tokens), 0) as output_tokens,
    coalesce(sum(ai_runs.cached_tokens), 0) as cached_tokens,
    coalesce(sum(ai_runs.cost_micro_eur), 0) as cost_micro_eur
  from ai_runs
  group by ai_runs.tenant_id, strftime('%Y-%m', ai_runs.created_at / 1000, 'unixepoch');--> statement-breakpoint
CREATE TABLE `__new_clarification_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`category_id` text NOT NULL,
	`question_code` text NOT NULL,
	`run_id` text,
	`materiality_bp` integer DEFAULT 0 NOT NULL,
	`suggestion_json` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`answered_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_clarification_queue`("id", "tenant_id", "category_id", "question_code", "run_id", "materiality_bp", "suggestion_json", "status", "created_at", "answered_at") SELECT "id", "tenant_id", "category_id", "question_code", "run_id", "materiality_bp", "suggestion_json", "status", "created_at", "answered_at" FROM `clarification_queue`;--> statement-breakpoint
DROP TABLE `clarification_queue`;--> statement-breakpoint
ALTER TABLE `__new_clarification_queue` RENAME TO `clarification_queue`;--> statement-breakpoint
CREATE UNIQUE INDEX `clarification_open_uq` ON `clarification_queue` (`tenant_id`,`category_id`,`question_code`) WHERE status = 'open';--> statement-breakpoint
CREATE INDEX `clarification_status_idx` ON `clarification_queue` (`status`,`materiality_bp`);--> statement-breakpoint
CREATE TABLE `__new_job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`job_name` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_ms` integer,
	`error` text,
	`steps_json` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_job_runs`("id", "tenant_id", "job_name", "status", "started_at", "finished_at", "duration_ms", "error", "steps_json") SELECT "id", "tenant_id", "job_name", "status", "started_at", "finished_at", "duration_ms", "error", "steps_json" FROM `job_runs`;--> statement-breakpoint
DROP TABLE `job_runs`;--> statement-breakpoint
ALTER TABLE `__new_job_runs` RENAME TO `job_runs`;--> statement-breakpoint
CREATE INDEX `job_runs_job_name_started_at_idx` ON `job_runs` (`tenant_id`,`job_name`,`started_at`);--> statement-breakpoint
CREATE TABLE `__new_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`run_id` text,
	`type` text NOT NULL,
	`target_ref` text NOT NULL,
	`payload_json` text NOT NULL,
	`rendered_diff_json` text,
	`explanation_json` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`applied_at` integer,
	`applied_by` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`applied_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_proposals`("id", "tenant_id", "run_id", "type", "target_ref", "payload_json", "rendered_diff_json", "explanation_json", "status", "created_at", "expires_at", "applied_at", "applied_by") SELECT "id", "tenant_id", "run_id", "type", "target_ref", "payload_json", "rendered_diff_json", "explanation_json", "status", "created_at", "expires_at", "applied_at", "applied_by" FROM `proposals`;--> statement-breakpoint
DROP TABLE `proposals`;--> statement-breakpoint
ALTER TABLE `__new_proposals` RENAME TO `proposals`;--> statement-breakpoint
CREATE INDEX `proposals_status_idx` ON `proposals` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `proposals_pending_uq` ON `proposals` (`tenant_id`,`type`,`target_ref`) WHERE status = 'pending';--> statement-breakpoint
CREATE TABLE `__new_category_guess_candidates` (
	`month` text NOT NULL,
	`tenant_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`payee_id` text NOT NULL,
	`payee_name` text,
	`amount_cents` integer NOT NULL,
	`date` text NOT NULL,
	`history_json` text NOT NULL,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `month`, `transaction_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_category_guess_candidates`("month", "tenant_id", "transaction_id", "payee_id", "payee_name", "amount_cents", "date", "history_json", "computed_at") SELECT "month", "tenant_id", "transaction_id", "payee_id", "payee_name", "amount_cents", "date", "history_json", "computed_at" FROM `category_guess_candidates`;--> statement-breakpoint
DROP TABLE `category_guess_candidates`;--> statement-breakpoint
ALTER TABLE `__new_category_guess_candidates` RENAME TO `category_guess_candidates`;--> statement-breakpoint
CREATE INDEX `category_guess_candidates_month_idx` ON `category_guess_candidates` (`month`);--> statement-breakpoint
CREATE TABLE `__new_monthly_category_facts` (
	`month` text NOT NULL,
	`tenant_id` text NOT NULL,
	`category_id` text NOT NULL,
	`spent_cents` integer DEFAULT 0 NOT NULL,
	`budgeted_cents` integer DEFAULT 0 NOT NULL,
	`available_cents` integer DEFAULT 0 NOT NULL,
	`carryover_enabled` integer DEFAULT false NOT NULL,
	`txn_count` integer DEFAULT 0 NOT NULL,
	`recomputed_spent_cents` integer,
	`committed_cents` integer DEFAULT 0 NOT NULL,
	`committed_to_date_cents` integer DEFAULT 0 NOT NULL,
	`committed_approximate` integer DEFAULT false NOT NULL,
	`ewma_baseline_cents` integer,
	`baseline_delta_bp` integer,
	`baseline_current_cents` integer,
	`baseline_months_used` integer,
	`baseline_window_months` integer,
	`baseline_winsor_effect_bp` integer,
	`day_curve_median_fraction_bp` integer,
	`day_curve_dispersion_bp` integer,
	`day_curve_months_used` integer,
	`day_curve_reliable` integer,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `month`, `category_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_monthly_category_facts`("month", "tenant_id", "category_id", "spent_cents", "budgeted_cents", "available_cents", "carryover_enabled", "txn_count", "recomputed_spent_cents", "committed_cents", "committed_to_date_cents", "committed_approximate", "ewma_baseline_cents", "baseline_delta_bp", "baseline_current_cents", "baseline_months_used", "baseline_window_months", "baseline_winsor_effect_bp", "day_curve_median_fraction_bp", "day_curve_dispersion_bp", "day_curve_months_used", "day_curve_reliable", "computed_at") SELECT "month", "tenant_id", "category_id", "spent_cents", "budgeted_cents", "available_cents", "carryover_enabled", "txn_count", "recomputed_spent_cents", "committed_cents", "committed_to_date_cents", "committed_approximate", "ewma_baseline_cents", "baseline_delta_bp", "baseline_current_cents", "baseline_months_used", "baseline_window_months", "baseline_winsor_effect_bp", "day_curve_median_fraction_bp", "day_curve_dispersion_bp", "day_curve_months_used", "day_curve_reliable", "computed_at" FROM `monthly_category_facts`;--> statement-breakpoint
DROP TABLE `monthly_category_facts`;--> statement-breakpoint
ALTER TABLE `__new_monthly_category_facts` RENAME TO `monthly_category_facts`;--> statement-breakpoint
CREATE INDEX `facts_month_idx` ON `monthly_category_facts` (`month`);--> statement-breakpoint
CREATE INDEX `facts_category_idx` ON `monthly_category_facts` (`category_id`);--> statement-breakpoint
CREATE TABLE `__new_monthly_signals` (
	`month` text NOT NULL,
	`tenant_id` text NOT NULL,
	`code` text NOT NULL,
	`subject_key` text NOT NULL,
	`subject_id` text,
	`subject_name` text,
	`severity` text NOT NULL,
	`metrics_json` text NOT NULL,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `month`, `code`, `subject_key`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_monthly_signals`("month", "tenant_id", "code", "subject_key", "subject_id", "subject_name", "severity", "metrics_json", "computed_at") SELECT "month", "tenant_id", "code", "subject_key", "subject_id", "subject_name", "severity", "metrics_json", "computed_at" FROM `monthly_signals`;--> statement-breakpoint
DROP TABLE `monthly_signals`;--> statement-breakpoint
ALTER TABLE `__new_monthly_signals` RENAME TO `monthly_signals`;--> statement-breakpoint
CREATE INDEX `signals_month_idx` ON `monthly_signals` (`month`,`severity`);--> statement-breakpoint
CREATE TABLE `__new_net_worth_snapshots` (
	`date` text NOT NULL,
	`tenant_id` text NOT NULL,
	`account_map_id` text NOT NULL,
	`value_cents` integer NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `date`, `account_map_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_map_id`) REFERENCES `account_map`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_net_worth_snapshots`("date", "tenant_id", "account_map_id", "value_cents", "currency", "computed_at") SELECT "date", "tenant_id", "account_map_id", "value_cents", "currency", "computed_at" FROM `net_worth_snapshots`;--> statement-breakpoint
DROP TABLE `net_worth_snapshots`;--> statement-breakpoint
ALTER TABLE `__new_net_worth_snapshots` RENAME TO `net_worth_snapshots`;--> statement-breakpoint
CREATE INDEX `networth_date_idx` ON `net_worth_snapshots` (`date`);--> statement-breakpoint
CREATE TABLE `__new_portfolio_snapshots` (
	`date` text NOT NULL,
	`tenant_id` text NOT NULL,
	`instrument` text NOT NULL,
	`symbol` text,
	`isin` text,
	`name` text,
	`quantity` text NOT NULL,
	`price_cents` integer NOT NULL,
	`value_cents` integer NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`price_currency` text,
	`asset_class` text,
	`asset_sub_class` text,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `date`, `instrument`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_portfolio_snapshots`("date", "tenant_id", "instrument", "symbol", "isin", "name", "quantity", "price_cents", "value_cents", "currency", "price_currency", "asset_class", "asset_sub_class", "computed_at") SELECT "date", "tenant_id", "instrument", "symbol", "isin", "name", "quantity", "price_cents", "value_cents", "currency", "price_currency", "asset_class", "asset_sub_class", "computed_at" FROM `portfolio_snapshots`;--> statement-breakpoint
DROP TABLE `portfolio_snapshots`;--> statement-breakpoint
ALTER TABLE `__new_portfolio_snapshots` RENAME TO `portfolio_snapshots`;--> statement-breakpoint
CREATE INDEX `portfolio_date_idx` ON `portfolio_snapshots` (`date`);--> statement-breakpoint
CREATE TABLE `__new_recompute_mismatches` (
	`month` text NOT NULL,
	`tenant_id` text NOT NULL,
	`category_id` text NOT NULL,
	`category_name` text NOT NULL,
	`actual_cents` integer NOT NULL,
	`recomputed_cents` integer NOT NULL,
	`difference_cents` integer NOT NULL,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `month`, `category_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_recompute_mismatches`("month", "tenant_id", "category_id", "category_name", "actual_cents", "recomputed_cents", "difference_cents", "computed_at") SELECT "month", "tenant_id", "category_id", "category_name", "actual_cents", "recomputed_cents", "difference_cents", "computed_at" FROM `recompute_mismatches`;--> statement-breakpoint
DROP TABLE `recompute_mismatches`;--> statement-breakpoint
ALTER TABLE `__new_recompute_mismatches` RENAME TO `recompute_mismatches`;--> statement-breakpoint
CREATE INDEX `mismatch_month_idx` ON `recompute_mismatches` (`month`);--> statement-breakpoint
CREATE TABLE `__new_ai_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`run_id` text NOT NULL,
	`code` text NOT NULL,
	`category_id` text,
	`month` text,
	`metric` text,
	`value_json` text,
	`severity` text DEFAULT 'info' NOT NULL,
	`confidence` integer DEFAULT 50 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_ai_findings`("id", "tenant_id", "run_id", "code", "category_id", "month", "metric", "value_json", "severity", "confidence", "created_at") SELECT "id", "tenant_id", "run_id", "code", "category_id", "month", "metric", "value_json", "severity", "confidence", "created_at" FROM `ai_findings`;--> statement-breakpoint
DROP TABLE `ai_findings`;--> statement-breakpoint
ALTER TABLE `__new_ai_findings` RENAME TO `ai_findings`;--> statement-breakpoint
CREATE INDEX `ai_findings_run_idx` ON `ai_findings` (`run_id`);--> statement-breakpoint
CREATE INDEX `ai_findings_severity_idx` ON `ai_findings` (`severity`);--> statement-breakpoint
CREATE TABLE `__new_category_meta` (
	`category_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`name_snapshot` text NOT NULL,
	`is_income` integer DEFAULT false NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`user_description` text,
	`coicop_code` text,
	`nature` text,
	`expected_frequency` text DEFAULT 'monthly' NOT NULL,
	`custody_shared` integer DEFAULT false NOT NULL,
	`sensitive` integer DEFAULT false NOT NULL,
	`ai_excluded` integer DEFAULT false NOT NULL,
	`confidence` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `category_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_category_meta`("category_id", "tenant_id", "name_snapshot", "is_income", "hidden", "user_description", "coicop_code", "nature", "expected_frequency", "custody_shared", "sensitive", "ai_excluded", "confidence", "updated_at") SELECT "category_id", "tenant_id", "name_snapshot", "is_income", "hidden", "user_description", "coicop_code", "nature", "expected_frequency", "custody_shared", "sensitive", "ai_excluded", "confidence", "updated_at" FROM `category_meta`;--> statement-breakpoint
DROP TABLE `category_meta`;--> statement-breakpoint
ALTER TABLE `__new_category_meta` RENAME TO `category_meta`;--> statement-breakpoint
CREATE INDEX `category_meta_sensitive_idx` ON `category_meta` (`sensitive`);--> statement-breakpoint
CREATE TABLE `__new_jobs` (
	`name` text NOT NULL,
	`tenant_id` text NOT NULL,
	`last_run_at` integer,
	`last_success_at` integer,
	`next_run_at` integer,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_duration_ms` integer,
	`error` text,
	PRIMARY KEY(`tenant_id`, `name`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_jobs`("name", "tenant_id", "last_run_at", "last_success_at", "next_run_at", "status", "last_duration_ms", "error") SELECT "name", "tenant_id", "last_run_at", "last_success_at", "next_run_at", "status", "last_duration_ms", "error" FROM `jobs`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;--> statement-breakpoint
CREATE TABLE `__new_monthly_hygiene` (
	`month` text NOT NULL,
	`tenant_id` text NOT NULL,
	`score_bp` integer NOT NULL,
	`deductions_json` text NOT NULL,
	`judged_facts_hash` text,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `month`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_monthly_hygiene`("month", "tenant_id", "score_bp", "deductions_json", "judged_facts_hash", "computed_at") SELECT "month", "tenant_id", "score_bp", "deductions_json", "judged_facts_hash", "computed_at" FROM `monthly_hygiene`;--> statement-breakpoint
DROP TABLE `monthly_hygiene`;--> statement-breakpoint
ALTER TABLE `__new_monthly_hygiene` RENAME TO `monthly_hygiene`;--> statement-breakpoint
CREATE TABLE `__new_monthly_totals` (
	`month` text NOT NULL,
	`tenant_id` text NOT NULL,
	`income_cents` integer DEFAULT 0 NOT NULL,
	`spent_cents` integer DEFAULT 0 NOT NULL,
	`budgeted_cents` integer DEFAULT 0 NOT NULL,
	`to_budget_cents` integer DEFAULT 0 NOT NULL,
	`from_last_month_cents` integer DEFAULT 0 NOT NULL,
	`balance_cents` integer DEFAULT 0 NOT NULL,
	`savings_rate_bp` integer,
	`uncategorised_txn_count` integer DEFAULT 0 NOT NULL,
	`uncategorised_cents` integer DEFAULT 0 NOT NULL,
	`committed_cents` integer DEFAULT 0 NOT NULL,
	`committed_unallocated_cents` integer DEFAULT 0 NOT NULL,
	`committed_unallocated_count` integer DEFAULT 0 NOT NULL,
	`committed_approximate` integer DEFAULT false NOT NULL,
	`facts_hash` text,
	`facts_changed_at` integer,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `month`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_monthly_totals`("month", "tenant_id", "income_cents", "spent_cents", "budgeted_cents", "to_budget_cents", "from_last_month_cents", "balance_cents", "savings_rate_bp", "uncategorised_txn_count", "uncategorised_cents", "committed_cents", "committed_unallocated_cents", "committed_unallocated_count", "committed_approximate", "facts_hash", "facts_changed_at", "computed_at") SELECT "month", "tenant_id", "income_cents", "spent_cents", "budgeted_cents", "to_budget_cents", "from_last_month_cents", "balance_cents", "savings_rate_bp", "uncategorised_txn_count", "uncategorised_cents", "committed_cents", "committed_unallocated_cents", "committed_unallocated_count", "committed_approximate", "facts_hash", "facts_changed_at", "computed_at" FROM `monthly_totals`;--> statement-breakpoint
DROP TABLE `monthly_totals`;--> statement-breakpoint
ALTER TABLE `__new_monthly_totals` RENAME TO `monthly_totals`;--> statement-breakpoint
CREATE TABLE `__new_portfolio_metrics` (
	`date` text NOT NULL,
	`tenant_id` text NOT NULL,
	`twr_bp` integer,
	`mwr_bp` integer,
	`total_value_cents` integer DEFAULT 0 NOT NULL,
	`invested_value_cents` integer,
	`cash_value_cents` integer,
	`allocation_json` text,
	`drift_json` text,
	`ter_annual_cents` integer,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `date`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_portfolio_metrics`("date", "tenant_id", "twr_bp", "mwr_bp", "total_value_cents", "invested_value_cents", "cash_value_cents", "allocation_json", "drift_json", "ter_annual_cents", "computed_at") SELECT "date", "tenant_id", "twr_bp", "mwr_bp", "total_value_cents", "invested_value_cents", "cash_value_cents", "allocation_json", "drift_json", "ter_annual_cents", "computed_at" FROM `portfolio_metrics`;--> statement-breakpoint
DROP TABLE `portfolio_metrics`;--> statement-breakpoint
ALTER TABLE `__new_portfolio_metrics` RENAME TO `portfolio_metrics`;--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`key` text NOT NULL,
	`tenant_id` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `key`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_settings`("key", "tenant_id", "value_json", "updated_at") SELECT "key", "tenant_id", "value_json", "updated_at" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
CREATE TABLE `__new_upstream_probes` (
	`source` text NOT NULL,
	`tenant_id` text NOT NULL,
	`status` text NOT NULL,
	`checked_at` integer NOT NULL,
	`report_json` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `source`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_upstream_probes`("source", "tenant_id", "status", "checked_at", "report_json") SELECT "source", "tenant_id", "status", "checked_at", "report_json" FROM `upstream_probes`;--> statement-breakpoint
DROP TABLE `upstream_probes`;--> statement-breakpoint
ALTER TABLE `__new_upstream_probes` RENAME TO `upstream_probes`;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`oidc_sub` text,
	`email` text,
	`display_name` text,
	`locale` text DEFAULT 'en' NOT NULL,
	`role` text DEFAULT 'owner' NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "tenant_id", "oidc_sub", "email", "display_name", "locale", "role", "disabled", "created_at", "last_seen_at") SELECT "id", "tenant_id", "oidc_sub", "email", "display_name", "locale", "role", "disabled", "created_at", "last_seen_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_oidc_sub_uq` ON `users` (`oidc_sub`);