CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'liquid' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`target_cents` integer NOT NULL,
	`target_date` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `goals_tenant_idx` ON `goals` (`tenant_id`,`priority`,`created_at`);