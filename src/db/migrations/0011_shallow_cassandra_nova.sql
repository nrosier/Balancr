-- The last capability probe per upstream, so `/readyz` can report a shape mismatch
-- without calling Ghostfolio on every request.
--
-- No backfill and no default: an empty table means nothing has been probed yet, which
-- is exactly what a deployment that has not run a job looks like, and readiness says
-- "not known" for it rather than "ok". Claiming an upstream is healthy because no
-- probe has ever contradicted it is the one answer this table exists to avoid.
CREATE TABLE `upstream_probes` (
	`source` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`checked_at` integer NOT NULL,
	`report_json` text NOT NULL
);
