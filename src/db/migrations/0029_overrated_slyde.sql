-- Prompt rows predate tenant isolation. Authored versions can be attributed to
-- their creator's tenant; built-in rows have no creator and belong to the
-- bootstrap tenant every pre-multi-tenant installation already used. This keeps
-- existing history without copying one household's editable prompt to all others.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`key` text NOT NULL,
	`locale` text NOT NULL,
	`version` integer NOT NULL,
	`body` text NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_prompts`(
	`id`, `tenant_id`, `key`, `locale`, `version`, `body`, `active`, `note`, `created_at`, `created_by`
)
SELECT
	`p`.`id`,
	coalesce(
		`u`.`tenant_id`,
		(SELECT `t`.`id` FROM `tenants` AS `t` ORDER BY `t`.`created_at`, `t`.`id` LIMIT 1)
	),
	`p`.`key`, `p`.`locale`, `p`.`version`, `p`.`body`, `p`.`active`, `p`.`note`, `p`.`created_at`, `p`.`created_by`
FROM `prompts` AS `p`
LEFT JOIN `users` AS `u` ON `u`.`id` = `p`.`created_by`;
--> statement-breakpoint
-- SQLite applies ai_runs.prompt_id's ON DELETE SET NULL while the old table is
-- dropped even though this migration requests foreign_keys=OFF inside drizzle's
-- transaction. Preserve and restore those references around the table rebuild.
CREATE TEMP TABLE `__prompt_run_refs` AS
SELECT `id`, `prompt_id` FROM `ai_runs` WHERE `prompt_id` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `prompts`;--> statement-breakpoint
ALTER TABLE `__new_prompts` RENAME TO `prompts`;--> statement-breakpoint
UPDATE `ai_runs`
SET `prompt_id` = (
	SELECT `r`.`prompt_id` FROM `__prompt_run_refs` AS `r` WHERE `r`.`id` = `ai_runs`.`id`
)
WHERE `id` IN (SELECT `id` FROM `__prompt_run_refs`);
--> statement-breakpoint
DROP TABLE `__prompt_run_refs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_key_locale_version_uq` ON `prompts` (`tenant_id`,`key`,`locale`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_one_active_uq` ON `prompts` (`tenant_id`,`key`,`locale`) WHERE active = 1;
