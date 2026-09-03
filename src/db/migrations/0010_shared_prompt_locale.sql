-- Collapse the per-locale prompt copies the old seed created.
--
-- `prompts` is keyed by (key, locale, version), and the seed wrote the same English
-- default into every supported locale. That gave every locale an active row, which
-- meant the locale fallback in `resolvePrompt` — designed for exactly "nobody has
-- written a Dutch prompt yet" — could never fire. Improving the instructions in
-- English left a Dutch run on the untouched built-in text, silently, and the editor
-- opened in Dutch showed the old version as though the edit had been lost.
--
-- The fix is one shared text, stored under the sentinel locale `*`, with a real
-- locale code used only for a deliberate override. See `domain/ai/prompt-locale.ts`
-- for why a sentinel rather than NULL: both unique indexes on this table include
-- `locale`, and SQLite treats NULLs as distinct in a unique index, so "at most one
-- active version" would have stopped being enforced for precisely the rows that
-- carry the prompt in use.
--
-- Only byte-identical copies are collapsed, and the guard is deliberately strict:
-- one distinct body AND one distinct version across every row of the key. That is
-- the untouched seed and nothing else, so the rows deleted here are exact
-- duplicates of the row kept. A key whose languages have already diverged — someone
-- edited one of them — is left exactly as it is: no shared row is invented from
-- one language's text, and no edit is destroyed. Those rows surface in the editor as
-- what they now are, explicit per-language overrides, which is the opposite of the
-- state this migration ends, where divergence was mandatory and invisible.
--
-- The survivor is the active row, then the first locale alphabetically — the second
-- clause only decides between rows already known to be byte-identical, and exists so
-- that two runs of this file could not pick different winners.
DELETE FROM `prompts` WHERE `id` IN (
  SELECT `p`.`id` FROM `prompts` AS `p`
  WHERE `p`.`key` IN (
    SELECT `key` FROM `prompts`
    GROUP BY `key`
    HAVING count(DISTINCT `body`) = 1 AND count(DISTINCT `version`) = 1
  )
  AND `p`.`id` <> (
    SELECT `s`.`id` FROM `prompts` AS `s`
    WHERE `s`.`key` = `p`.`key`
    ORDER BY `s`.`active` DESC, `s`.`locale` ASC
    LIMIT 1
  )
);--> statement-breakpoint
-- What is left of a collapsed key is a single row, and that row is the shared text.
-- A key that still has more than one row diverged on purpose and keeps its locales.
UPDATE `prompts` SET `locale` = '*'
WHERE `locale` <> '*'
  AND `key` IN (SELECT `key` FROM `prompts` GROUP BY `key` HAVING count(*) = 1);
