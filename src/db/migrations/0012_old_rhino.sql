-- Ghostfolio's class labels, per position, for advice (#41).
--
-- The allocation has been aggregated into `portfolio_metrics.allocation_json` since
-- 0.5.0, which is enough to say that equities are 8% over their ceiling and not enough
-- to say what to sell. Advice names the position a sale would come out of, so the class
-- has to survive on the row.
--
-- No backfill and no default. Ghostfolio is asked for today's holdings on every pass, so
-- the current date fills in on the next run of the portfolio job; historical rows are
-- left null because their labels were never recorded and inferring one from the name
-- would be inventing the fact this column exists to carry. A null row is simply not a
-- candidate for a sale suggestion, which is the honest reading of "we do not know what
-- this is".
ALTER TABLE `portfolio_snapshots` ADD `asset_class` text;--> statement-breakpoint
-- ETF, STOCK, BOND — the distinction beurstaks turns on. Selling a share costs 0,35%
-- and selling an accumulating fund costs between 0,12% and 1,32%, so without this every
-- sale would be priced as a fund and a share's cost overstated nearly fourfold.
ALTER TABLE `portfolio_snapshots` ADD `asset_sub_class` text;
