-- 0011_recovery_reconciliation.sql
-- Preserve owner-reviewed recovery evidence and the exact coverage accepted
-- when a recovery hold is released.

ALTER TABLE attempt_evidence
  ADD COLUMN reviewer_note text;

ALTER TABLE submission_recovery_holds
  ADD COLUMN coverage_started_at timestamptz,
  ADD COLUMN coverage_ended_at timestamptz,
  ADD COLUMN resolution_note text,
  ADD COLUMN resolved_by uuid REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE submission_recovery_holds
  ADD CONSTRAINT submission_recovery_hold_coverage_ck
    CHECK (coverage_started_at IS NULL OR coverage_ended_at IS NULL
        OR coverage_started_at <= coverage_ended_at),
  ADD CONSTRAINT submission_recovery_hold_release_evidence_ck
    CHECK (status <> 'released'
        OR (evidence_ref IS NOT NULL
            AND resolution_note IS NOT NULL
            AND coverage_started_at IS NOT NULL
            AND coverage_ended_at IS NOT NULL
            AND resolved_at IS NOT NULL
            AND resolved_by IS NOT NULL));
