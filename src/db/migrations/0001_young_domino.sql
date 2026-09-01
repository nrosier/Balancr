CREATE TABLE `monthly_hygiene` (
	`month` text PRIMARY KEY NOT NULL,
	`score_bp` integer NOT NULL,
	`deductions_json` text NOT NULL,
	`computed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `monthly_signals` (
	`month` text NOT NULL,
	`code` text NOT NULL,
	`subject_key` text NOT NULL,
	`subject_id` text,
	`subject_name` text,
	`severity` text NOT NULL,
	`metrics_json` text NOT NULL,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`month`, `code`, `subject_key`)
);
--> statement-breakpoint
CREATE INDEX `signals_month_idx` ON `monthly_signals` (`month`,`severity`);--> statement-breakpoint
CREATE TABLE `monthly_totals` (
	`month` text PRIMARY KEY NOT NULL,
	`income_cents` integer DEFAULT 0 NOT NULL,
	`spent_cents` integer DEFAULT 0 NOT NULL,
	`budgeted_cents` integer DEFAULT 0 NOT NULL,
	`to_budget_cents` integer DEFAULT 0 NOT NULL,
	`from_last_month_cents` integer DEFAULT 0 NOT NULL,
	`balance_cents` integer DEFAULT 0 NOT NULL,
	`savings_rate_bp` integer,
	`uncategorised_txn_count` integer DEFAULT 0 NOT NULL,
	`uncategorised_cents` integer DEFAULT 0 NOT NULL,
	`computed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recompute_mismatches` (
	`month` text NOT NULL,
	`category_id` text NOT NULL,
	`category_name` text NOT NULL,
	`actual_cents` integer NOT NULL,
	`recomputed_cents` integer NOT NULL,
	`difference_cents` integer NOT NULL,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`month`, `category_id`)
);
--> statement-breakpoint
CREATE INDEX `mismatch_month_idx` ON `recompute_mismatches` (`month`);--> statement-breakpoint
ALTER TABLE `category_meta` ADD `is_income` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `category_meta` ADD `hidden` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `monthly_category_facts` ADD `baseline_current_cents` integer;--> statement-breakpoint
ALTER TABLE `monthly_category_facts` ADD `baseline_months_used` integer;--> statement-breakpoint
ALTER TABLE `monthly_category_facts` ADD `baseline_window_months` integer;--> statement-breakpoint
ALTER TABLE `monthly_category_facts` ADD `baseline_winsor_effect_bp` integer;