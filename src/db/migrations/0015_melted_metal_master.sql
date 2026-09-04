ALTER TABLE `monthly_hygiene` ADD `judged_facts_hash` text;--> statement-breakpoint
ALTER TABLE `monthly_totals` ADD `facts_hash` text;--> statement-breakpoint
ALTER TABLE `monthly_totals` ADD `facts_changed_at` integer;