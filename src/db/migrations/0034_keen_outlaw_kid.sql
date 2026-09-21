CREATE TABLE `revolving_debts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text DEFAULT 'creditCard' NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`balance_cents` integer NOT NULL,
	`minimum_payment_cents` integer NOT NULL,
	`apr_bp` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `revolving_debts_tenant_idx` ON `revolving_debts` (`tenant_id`,`created_at`);