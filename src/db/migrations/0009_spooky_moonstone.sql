-- Splits the portfolio total into positions and cash held at the broker.
--
-- Both are left null for rows written before the split existed, because the split is
-- not recoverable from what was stored: `total_value_cents` is one number and
-- `allocation_json` was computed over every holding including the cash one, so a
-- backfill would have to guess which slice was liquid. Filling
-- `invested_value_cents` with the old total would claim a cash balance was invested,
-- on exactly the rows that made this migration necessary. Null renders as "not known
-- for this date", which is true; the next nightly pass writes both.
ALTER TABLE `portfolio_metrics` ADD `invested_value_cents` integer;--> statement-breakpoint
ALTER TABLE `portfolio_metrics` ADD `cash_value_cents` integer;
