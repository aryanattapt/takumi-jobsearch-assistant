-- Phase 4 local fixture: versioned preflight snapshots and one active approval.
ALTER TABLE application_review_snapshots
  ADD COLUMN application_version integer NOT NULL DEFAULT 1
    CHECK (application_version > 0),
  ADD COLUMN adapter_id text NOT NULL DEFAULT 'local-dummy-v1';

CREATE INDEX application_review_snapshots_latest_idx
  ON application_review_snapshots (owner_id, application_id, captured_at DESC);

CREATE UNIQUE INDEX approvals_one_active_uq
  ON approvals (application_id)
  WHERE revoked_at IS NULL AND consumed_at IS NULL;
