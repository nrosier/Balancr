CREATE TABLE `schedule_meta` (
	`schedule_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`label` text NOT NULL,
	`category_id` text,
	`amount_cents` integer NOT NULL,
	`approximate` integer DEFAULT false NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `schedule_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
