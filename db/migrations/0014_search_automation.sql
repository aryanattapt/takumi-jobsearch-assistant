-- Owner-controlled schedules and the dashboard notification inbox.
ALTER TABLE schedules
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN notify_in_app boolean NOT NULL DEFAULT true;

ALTER TABLE notifications
  ADD COLUMN read_at timestamptz;

CREATE INDEX notifications_inbox_idx
  ON notifications (owner_id, created_at DESC)
  WHERE read_at IS NULL;
