ALTER TABLE `goals` ADD `category_id` text;--> statement-breakpoint
ALTER TABLE `goals` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `goals` ADD `done_at` text;