CREATE TABLE `digest_pdfs` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`period` text NOT NULL,
	`pdf_bytes` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
