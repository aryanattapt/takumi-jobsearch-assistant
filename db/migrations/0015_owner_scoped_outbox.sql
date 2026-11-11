-- Every outbox event belongs to the installation's single owner. This makes
-- privacy export/purge and future event consumers enforce owner scope at the
-- database boundary rather than relying on every caller to remember it.
DO $$
DECLARE
  current_owner uuid;
BEGIN
  SELECT owner_id INTO current_owner
    FROM installation_owner
   WHERE slot = 1;

  IF EXISTS (SELECT 1 FROM outbox_events WHERE owner_id IS NULL) THEN
    IF current_owner IS NULL THEN
      RAISE EXCEPTION 'Cannot scope existing outbox events before an owner is provisioned';
    END IF;
    UPDATE outbox_events SET owner_id = current_owner WHERE owner_id IS NULL;
  END IF;
END $$;

ALTER TABLE outbox_events ALTER COLUMN owner_id SET NOT NULL;
CREATE INDEX outbox_owner_created_idx ON outbox_events (owner_id, created_at DESC);
