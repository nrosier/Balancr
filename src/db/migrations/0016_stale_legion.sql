ALTER TABLE `ai_runs` ADD `payload_hash` text;--> statement-breakpoint
ALTER TABLE `ai_runs` ADD `reused_from_run_id` text REFERENCES ai_runs(id);--> statement-breakpoint
CREATE INDEX `ai_runs_reuse_idx` ON `ai_runs` (`period`,`payload_hash`);