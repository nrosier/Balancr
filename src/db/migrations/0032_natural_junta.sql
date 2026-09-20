ALTER TABLE `tenant_integrations` ADD `ai_base_url` text;--> statement-breakpoint
ALTER TABLE `tenant_integrations` ADD `ai_model_prices_json` text DEFAULT '{}' NOT NULL;