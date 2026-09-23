ALTER TABLE `ai_runs` ADD `seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfills seq from the existing (still-untouched) rowid order, the last
-- point at which rowid is guaranteed to reflect true insertion order (#514).
UPDATE `ai_runs`
SET `seq` = `ranked`.`rn`
FROM (
  SELECT `rowid` AS `rid`, ROW_NUMBER() OVER (ORDER BY `created_at`, `rowid`) AS `rn`
  FROM `ai_runs`
) AS `ranked`
WHERE `ai_runs`.`rowid` = `ranked`.`rid`;