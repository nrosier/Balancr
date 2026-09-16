CREATE TABLE `tenant_integrations` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`actual_server_url` text NOT NULL,
	`actual_password_enc` text NOT NULL,
	`actual_sync_id` text NOT NULL,
	`actual_e2e_password_enc` text,
	`ghostfolio_url` text NOT NULL,
	`ghostfolio_security_token_enc` text NOT NULL,
	`gemini_provider` text NOT NULL,
	`gemini_api_key_enc` text,
	`google_cloud_project` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
