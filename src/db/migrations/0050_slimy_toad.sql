PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`oidc_sub` text,
	`email` text,
	`display_name` text,
	`locale` text DEFAULT 'en' NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "tenant_id", "oidc_sub", "email", "display_name", "locale", "role", "disabled", "created_at", "last_seen_at") SELECT "id", "tenant_id", "oidc_sub", "email", "display_name", "locale", "role", "disabled", "created_at", "last_seen_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_oidc_sub_uq` ON `users` (`oidc_sub`);