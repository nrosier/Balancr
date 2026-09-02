ALTER TABLE `account_map` ADD `decided_fields` text;--> statement-breakpoint
ALTER TABLE `account_map` ADD `classified_at` integer;--> statement-breakpoint
-- Infer provenance for rows that predate the column.
--
-- The only evidence available is that a stored value differs from what the
-- insert-time default would have produced, so the inference runs field by field
-- and is deliberately conservative: it can under-report a decision but never
-- invent one. Under-reporting costs a re-derivation that agrees with the person
-- anyway; over-reporting would freeze a row against every future improvement.
--
--  * include_in_net_worth — defaults to 1, and nothing but a person sets it to 0.
--    Exact, and the one that matters most here: it is what preserves the manual
--    exclusions on the reporting instance.
--  * kind — `defaultKind` emits only 'investment' for Ghostfolio and only
--    'checking' or 'other' for Actual. Anything else was chosen. An Actual row
--    that *is* 'checking' or 'other' stays undecided on purpose: those are the
--    vague ones a better classifier should be free to sharpen.
--  * dedupe_group — only ever written by grouping two accounts together, which is
--    a person's act. Non-null is exact.
--  * is_source_of_truth — defaults to 1 and is set to 0 only as the other half of
--    that same act. Non-default is exact; a row left at 1 cannot be told apart
--    from one never touched, which is the known gap in this inference.
--
-- Built by concatenation rather than with `json_array`, because the branches that
-- do not fire would leave nulls in the array and `json_remove` takes the paths it
-- is given whether or not they are null — which quietly emptied every row.
-- `substr(…, 2)` drops the leading separator, and yields '' for no matches, so a
-- row with nothing decided gets '[]'.
UPDATE `account_map` SET `decided_fields` = '[' || substr(
  CASE WHEN (`source` = 'ghostfolio' AND `kind` <> 'investment')
          OR (`source` = 'actual' AND `kind` NOT IN ('checking', 'other'))
       THEN ',"kind"' ELSE '' END ||
  CASE WHEN `include_in_net_worth` = 0 THEN ',"includeInNetWorth"' ELSE '' END ||
  CASE WHEN `dedupe_group` IS NOT NULL THEN ',"dedupeGroup"' ELSE '' END ||
  CASE WHEN `is_source_of_truth` = 0 THEN ',"isSourceOfTruth"' ELSE '' END
, 2) || ']';
