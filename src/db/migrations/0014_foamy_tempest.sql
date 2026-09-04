-- The month each AI run was about, so the insights ledger can be filtered to one (#158).
--
-- Nullable, and null means "about no month" rather than "not known": a chat turn answers
-- a question, and `recentRuns` shows those under whatever month is on screen instead of
-- hiding them from every view.
ALTER TABLE `ai_runs` ADD `period` text;--> statement-breakpoint
CREATE INDEX `ai_runs_period_idx` ON `ai_runs` (`period`,`created_at`);--> statement-breakpoint
-- Backfilled from what each run produced, because the alternative is a ledger whose
-- history is invisible under every month. Two joins recover it for the rows that wrote
-- something: a narrative names its period, and every finding of an analysis carries the
-- month it judged.
UPDATE `ai_runs` SET `period` = (
	SELECT `n`.`period` FROM `ai_narratives` AS `n` WHERE `n`.`run_id` = `ai_runs`.`id`
) WHERE `period` IS NULL;--> statement-breakpoint
UPDATE `ai_runs` SET `period` = (
	SELECT `f`.`month` FROM `ai_findings` AS `f`
	WHERE `f`.`run_id` = `ai_runs`.`id` AND `f`.`month` IS NOT NULL LIMIT 1
) WHERE `period` IS NULL;
--
-- What stays null: a run that produced nothing — `capped`, `blocked`, a call that
-- failed, a dry run whose findings were deliberately discarded. Its month is not
-- recorded anywhere and guessing it from `created_at` would be wrong on exactly the
-- nights that matter, when the pass ran after midnight about the month before. Those
-- rows read as "no month" and stay visible, which is the honest answer rather than a
-- plausible one.
