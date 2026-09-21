ALTER TABLE `prompts` ADD `validation_verdict` text;--> statement-breakpoint
ALTER TABLE `prompts` ADD `validation_json` text;--> statement-breakpoint
ALTER TABLE `prompts` ADD `validation_run_id` text;--> statement-breakpoint
ALTER TABLE `prompts` ADD `validation_rules_version` integer;--> statement-breakpoint
ALTER TABLE `prompts` ADD `validation_provider` text;--> statement-breakpoint
ALTER TABLE `prompts` ADD `validation_model` text;--> statement-breakpoint
ALTER TABLE `prompts` ADD `validated_at` integer;--> statement-breakpoint
ALTER TABLE `prompts` ADD `validated_by` text;