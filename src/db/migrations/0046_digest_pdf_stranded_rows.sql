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
DELETE FROM `digest_pdfs` WHERE `tenant_id` NOT IN (
  SELECT `tenant_id` FROM `settings`
  WHERE `key` = 'digest.preference'
    AND json_extract(`value_json`, '$.mode') = 'pdf'
);
