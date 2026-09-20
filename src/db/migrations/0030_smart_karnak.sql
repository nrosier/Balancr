PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`action` text NOT NULL,
	`actor_id` text,
	`tenant_id` text NOT NULL,
	`entity` text NOT NULL,
	`entity_ref` text NOT NULL,
	`run_id` text,
	`proposal_id` text,
	`before_json` text,
	`after_json` text
);
--> statement-breakpoint
-- The column arrived nullable in 0023 and 0024 backfilled every row that existed
-- then to the bootstrap tenant. Buggy writers could still add null rows afterwards,
-- including once more than one tenant existed. Preserve an existing attribution;
-- otherwise use the strongest surviving relation in order: actor, AI run, proposal,
-- invite, or the tenant-creation row itself. Only a row with no surviving evidence is
-- assigned to the oldest/bootstrap tenant. It is therefore visible to one deliberate
-- scope, never implicitly to every tenant.
INSERT INTO `__new_audit_log`(
	"id", "at", "action", "actor_id", "tenant_id", "entity", "entity_ref",
	"run_id", "proposal_id", "before_json", "after_json"
)
SELECT
	`a`.`id`, `a`.`at`, `a`.`action`, `a`.`actor_id`,
	coalesce(
		`a`.`tenant_id`,
		(SELECT `u`.`tenant_id` FROM `users` AS `u` WHERE `u`.`id` = `a`.`actor_id`),
		(SELECT `r`.`tenant_id` FROM `ai_runs` AS `r` WHERE `r`.`id` = `a`.`run_id`),
		(SELECT `p`.`tenant_id` FROM `proposals` AS `p` WHERE `p`.`id` = `a`.`proposal_id`),
		(SELECT `i`.`tenant_id` FROM `tenant_invites` AS `i`
			WHERE `a`.`entity` = 'tenant_invites' AND `i`.`id` = `a`.`entity_ref`),
		(SELECT `t`.`id` FROM `tenants` AS `t`
			WHERE `a`.`action` = 'tenant.create' AND `a`.`entity` = 'tenants'
				AND `t`.`id` = `a`.`entity_ref`),
		(SELECT `t`.`id` FROM `tenants` AS `t` ORDER BY `t`.`created_at`, `t`.`id` LIMIT 1)
	),
	`a`.`entity`, `a`.`entity_ref`, `a`.`run_id`, `a`.`proposal_id`,
	`a`.`before_json`, `a`.`after_json`
FROM `audit_log` AS `a`;--> statement-breakpoint
DROP TABLE `audit_log`;--> statement-breakpoint
ALTER TABLE `__new_audit_log` RENAME TO `audit_log`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`tenant_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`tenant_id`,`entity`,`entity_ref`,`at`);
