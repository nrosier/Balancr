CREATE TABLE `category_guess_candidates` (
	`month` text NOT NULL,
	`transaction_id` text NOT NULL,
	`payee_id` text NOT NULL,
	`payee_name` text,
	`amount_cents` integer NOT NULL,
	`date` text NOT NULL,
	`history_json` text NOT NULL,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`month`, `transaction_id`)
);
--> statement-breakpoint
CREATE INDEX `category_guess_candidates_month_idx` ON `category_guess_candidates` (`month`);