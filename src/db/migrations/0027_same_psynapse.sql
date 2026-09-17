ALTER TABLE `tenant_integrations` ADD `gemini_model_fast` text DEFAULT 'gemini-3.7-flash' NOT NULL;--> statement-breakpoint
ALTER TABLE `tenant_integrations` ADD `gemini_model_deep` text DEFAULT 'gemini-3.1-pro-preview' NOT NULL;--> statement-breakpoint
ALTER TABLE `tenant_integrations` ADD `gemini_monthly_budget_eur_micro` integer DEFAULT 15000000 NOT NULL;