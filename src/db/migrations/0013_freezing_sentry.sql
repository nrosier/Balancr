-- What is still to come this month, from Actual's schedules (#159).
--
-- Zero everywhere is the correct backfill, which is why there is none. A committed
-- figure is a statement about the days between today and month end: for every month
-- that has already closed it is zero by definition, and for the current one the next
-- `sync` pass recomputes it — within fifteen minutes of this migration running, and
-- again every fifteen minutes after that, because the figure is a day older each time.
--
-- Defaulted rather than nullable for the same reason: "nothing is scheduled against
-- this envelope" and "nobody has looked yet" would both read as null, and the
-- projection in `overspend.ts` treats zero as the honest answer to both.
ALTER TABLE `monthly_category_facts` ADD `committed_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `monthly_category_facts` ADD `committed_to_date_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `monthly_category_facts` ADD `committed_approximate` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `monthly_totals` ADD `committed_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `monthly_totals` ADD `committed_unallocated_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `monthly_totals` ADD `committed_unallocated_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `monthly_totals` ADD `committed_approximate` integer DEFAULT false NOT NULL;