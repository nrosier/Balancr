CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_name` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_ms` integer,
	`error` text,
	`steps_json` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `job_runs_job_name_started_at_idx` ON `job_runs` (`job_name`,`started_at`);