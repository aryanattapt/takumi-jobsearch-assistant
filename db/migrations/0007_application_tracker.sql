-- 0007_application_tracker.sql
-- P0 tracker: owner notes and the document versions known for a manual report.

ALTER TABLE applications
  ADD COLUMN notes text;

ALTER TABLE application_attempts
  ADD COLUMN document_version_ids uuid[] NOT NULL DEFAULT '{}';

CREATE INDEX applications_owner_stage_idx
  ON applications (owner_id, recruitment_stage, updated_at DESC);
