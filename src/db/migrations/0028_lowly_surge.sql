CREATE TABLE `pending_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`oidc_sub` text NOT NULL,
	`email` text,
	`display_name` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_identities_expires_idx` ON `pending_identities` (`expires_at`);--> statement-breakpoint
CREATE TABLE `tenant_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`label` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`redeemed_at` integer,
	`redeemed_by` text,
	`revoked_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`redeemed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_invites_code_hash_uq` ON `tenant_invites` (`code_hash`);--> statement-breakpoint
CREATE INDEX `tenant_invites_tenant_idx` ON `tenant_invites` (`tenant_id`,`created_at`);