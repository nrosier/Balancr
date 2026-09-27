CREATE TABLE `tag_meta` (
	`tag_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`tag` text NOT NULL,
	`color` text,
	`hidden` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `tag_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tag_monthly_facts` (
	`tenant_id` text NOT NULL,
	`month` text NOT NULL,
	`tag_id` text NOT NULL,
	`net_cents` integer DEFAULT 0 NOT NULL,
	`txn_count` integer DEFAULT 0 NOT NULL,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `month`, `tag_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tag_facts_month_idx` ON `tag_monthly_facts` (`month`);