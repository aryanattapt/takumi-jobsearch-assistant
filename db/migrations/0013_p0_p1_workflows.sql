-- Evidence-grounded company research and encrypted interview preparation.
ALTER TABLE interview_packs
  ADD COLUMN content_ciphertext bytea,
  ADD COLUMN source_fact_version_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN model text,
  ADD COLUMN prompt_version text;

ALTER TABLE notifications
  ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX notification_channels_in_app_uq
  ON notification_channels (owner_id, provider, destination_ref)
  WHERE provider = 'in_app';
