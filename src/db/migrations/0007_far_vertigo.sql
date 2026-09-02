ALTER TABLE `portfolio_snapshots` ADD `price_currency` text;--> statement-breakpoint
-- Rows written before this column existed never recorded the instrument's own
-- quote currency, and it is not recoverable from what was stored. They were
-- rendered with the value currency all along, so backfilling from `currency`
-- changes no figure on screen — it only stops the reader having to know that
-- null once meant "assume base".
UPDATE `portfolio_snapshots` SET `price_currency` = `currency` WHERE `price_currency` IS NULL;
