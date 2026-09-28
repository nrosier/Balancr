-- Drops a stored digest PDF for any tenant not currently in `pdf` mode (#585).
--
-- #572 (shipped in #574) only deletes the stored PDF at the moment a tenant's
-- preference *changes away* from `pdf` mode, through `PATCH /api/settings/digest`.
-- An install that had already left `pdf` mode before that change shipped never
-- passed through that code, and its PDF was never dropped. This is the backfill:
-- one sweep, run once, for whatever #572 could not have caught retroactively.
--
-- A tenant counts as "currently in `pdf` mode" only if it has a `digest.preference`
-- row and that row's JSON says so; no row at all means the default (`off`), same as
-- `loadDigestPreference` falls back to.
--
-- `json_extract` throws on invalid JSON, and SQLite doesn't guarantee AND operands
-- are evaluated left-to-right, so a `json_valid` guard placed only elsewhere in the
-- WHERE clause could still leave this exposed to a corrupt `value_json` row (#756).
-- Wrapping the argument itself in a `CASE` means `json_extract` never sees invalid
-- JSON regardless of evaluation order — a corrupt row simply reads as `{}`, which
-- fails the `= 'pdf'` check the same as a genuinely absent key would.
DELETE FROM `digest_pdfs` WHERE `tenant_id` NOT IN (
  SELECT `tenant_id` FROM `settings`
  WHERE `key` = 'digest.preference'
    AND json_extract(
      CASE WHEN json_valid(`value_json`) THEN `value_json` ELSE '{}' END,
      '$.mode'
    ) = 'pdf'
);
