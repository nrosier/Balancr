CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`action` text NOT NULL,
	`actor_id` text,
	`entity` text NOT NULL,
	`entity_ref` text NOT NULL,
	`run_id` text,
	`proposal_id` text,
	`before_json` text,
	`after_json` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity`,`entity_ref`,`at`);--> statement-breakpoint
ALTER TABLE `clarification_queue` ADD `run_id` text;