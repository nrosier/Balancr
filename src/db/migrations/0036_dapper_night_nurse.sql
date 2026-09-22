CREATE TABLE `category_translations` (
	`category_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`locale` text NOT NULL,
	`name` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `category_id`, `locale`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `tenant_integrations` ADD `actual_category_source_locale` text DEFAULT 'en' NOT NULL;