CREATE TABLE `account_map` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`include_in_net_worth` integer DEFAULT true NOT NULL,
	`dedupe_group` text,
	`is_source_of_truth` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_map_source_external_uq` ON `account_map` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `account_map_dedupe_idx` ON `account_map` (`dedupe_group`);--> statement-breakpoint
CREATE TABLE `ai_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`code` text NOT NULL,
	`category_id` text,
	`month` text,
	`metric` text,
	`value_json` text,
	`severity` text DEFAULT 'info' NOT NULL,
	`confidence` integer DEFAULT 50 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_findings_run_idx` ON `ai_findings` (`run_id`);--> statement-breakpoint
CREATE INDEX `ai_findings_severity_idx` ON `ai_findings` (`severity`);--> statement-breakpoint
CREATE TABLE `ai_narratives` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`period` text NOT NULL,
	`locale` text NOT NULL,
	`body_md` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_narratives_period_locale_uq` ON `ai_narratives` (`period`,`locale`);--> statement-breakpoint
CREATE TABLE `ai_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`model` text NOT NULL,
	`prompt_id` text,
	`locale` text NOT NULL,
	`payload_json` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cached_tokens` integer DEFAULT 0 NOT NULL,
	`cost_micro_eur` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	`user_id` text,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ai_runs_created_idx` ON `ai_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `ai_runs_kind_idx` ON `ai_runs` (`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `category_meta` (
	`category_id` text PRIMARY KEY NOT NULL,
	`name_snapshot` text NOT NULL,
	`user_description` text,
	`coicop_code` text,
	`nature` text,
	`expected_frequency` text DEFAULT 'monthly' NOT NULL,
	`custody_shared` integer DEFAULT false NOT NULL,
	`sensitive` integer DEFAULT false NOT NULL,
	`confidence` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `category_meta_sensitive_idx` ON `category_meta` (`sensitive`);--> statement-breakpoint
CREATE TABLE `clarification_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`question_code` text NOT NULL,
	`materiality_bp` integer DEFAULT 0 NOT NULL,
	`suggestion_json` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`answered_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clarification_open_uq` ON `clarification_queue` (`category_id`,`question_code`) WHERE status = 'open';--> statement-breakpoint
CREATE INDEX `clarification_status_idx` ON `clarification_queue` (`status`,`materiality_bp`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`name` text PRIMARY KEY NOT NULL,
	`last_run_at` integer,
	`last_success_at` integer,
	`next_run_at` integer,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_duration_ms` integer,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `local_credentials` (
	`user_id` text PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`totp_secret` text NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`password_changed_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `monthly_category_facts` (
	`month` text NOT NULL,
	`category_id` text NOT NULL,
	`spent_cents` integer DEFAULT 0 NOT NULL,
	`budgeted_cents` integer DEFAULT 0 NOT NULL,
	`available_cents` integer DEFAULT 0 NOT NULL,
	`carryover_enabled` integer DEFAULT false NOT NULL,
	`txn_count` integer DEFAULT 0 NOT NULL,
	`recomputed_spent_cents` integer,
	`ewma_baseline_cents` integer,
	`baseline_delta_bp` integer,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`month`, `category_id`)
);
--> statement-breakpoint
CREATE INDEX `facts_month_idx` ON `monthly_category_facts` (`month`);--> statement-breakpoint
CREATE INDEX `facts_category_idx` ON `monthly_category_facts` (`category_id`);--> statement-breakpoint
CREATE TABLE `net_worth_snapshots` (
	`date` text NOT NULL,
	`account_map_id` text NOT NULL,
	`value_cents` integer NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`date`, `account_map_id`),
	FOREIGN KEY (`account_map_id`) REFERENCES `account_map`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `networth_date_idx` ON `net_worth_snapshots` (`date`);--> statement-breakpoint
CREATE TABLE `portfolio_metrics` (
	`date` text PRIMARY KEY NOT NULL,
	`twr_bp` integer,
	`mwr_bp` integer,
	`total_value_cents` integer DEFAULT 0 NOT NULL,
	`allocation_json` text,
	`drift_json` text,
	`ter_annual_cents` integer,
	`computed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `portfolio_snapshots` (
	`date` text NOT NULL,
	`instrument` text NOT NULL,
	`symbol` text,
	`isin` text,
	`name` text,
	`quantity` text NOT NULL,
	`price_cents` integer NOT NULL,
	`value_cents` integer NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`date`, `instrument`)
);
--> statement-breakpoint
CREATE INDEX `portfolio_date_idx` ON `portfolio_snapshots` (`date`);--> statement-breakpoint
CREATE TABLE `prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`locale` text NOT NULL,
	`version` integer NOT NULL,
	`body` text NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_key_locale_version_uq` ON `prompts` (`key`,`locale`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_one_active_uq` ON `prompts` (`key`,`locale`) WHERE active = 1;--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`type` text NOT NULL,
	`target_ref` text NOT NULL,
	`payload_json` text NOT NULL,
	`rendered_diff_json` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`applied_at` integer,
	`applied_by` text,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`applied_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `proposals_status_idx` ON `proposals` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `proposals_pending_uq` ON `proposals` (`type`,`target_ref`) WHERE status = 'pending';--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`method` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`oidc_sub` text,
	`email` text,
	`display_name` text,
	`locale` text DEFAULT 'en' NOT NULL,
	`role` text DEFAULT 'owner' NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_oidc_sub_uq` ON `users` (`oidc_sub`);