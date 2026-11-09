-- 0006_job_curation.sql
-- Owner curation fields for P0 job tracking: bookmark, ignore reason, version.
-- Listing status and owner curation status stay separate (DBD §4).

ALTER TABLE jobs
  ADD COLUMN bookmarked boolean NOT NULL DEFAULT false,
  ADD COLUMN ignored_reason text,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE INDEX jobs_owner_bookmarked_idx
  ON jobs (owner_id, bookmarked) WHERE bookmarked;

CREATE INDEX jobs_owner_company_idx
  ON jobs (owner_id, company_normalized)
  WHERE status = 'active';
