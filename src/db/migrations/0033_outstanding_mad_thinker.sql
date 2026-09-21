CREATE TABLE `loans` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text DEFAULT 'personal' NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`opening_date` text NOT NULL,
	`principal_cents` integer NOT NULL,
	`anchor_date` text NOT NULL,
	`rate_bp` integer NOT NULL,
	`monthly_payment_cents` integer NOT NULL,
	`remaining_term_months` integer NOT NULL,
	`original_principal_cents` integer,
	`extra_monthly_payment_cents` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `loans_tenant_idx` ON `loans` (`tenant_id`,`opening_date`);