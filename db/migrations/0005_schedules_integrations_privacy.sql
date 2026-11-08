-- 0005_schedules_integrations_privacy.sql
-- Schedules/occurrences, AI providers, notifications, submission guards,
-- recovery holds, privacy requests.

CREATE TABLE schedules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  timezone         text NOT NULL,
  rule             jsonb NOT NULL,
  search_config_id uuid NOT NULL REFERENCES saved_searches (id) ON DELETE CASCADE,
  enabled          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX schedules_enabled_idx ON schedules (enabled) WHERE enabled;

CREATE TABLE schedule_occurrences (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id        uuid NOT NULL REFERENCES schedules (id) ON DELETE CASCADE,
  local_date         date NOT NULL,
  local_time         time NOT NULL,
  timezone           text NOT NULL,
  scheduled_for_utc  timestamptz NOT NULL,
  state              text NOT NULL DEFAULT 'pending'
                       CHECK (state IN ('pending', 'materialized', 'skipped', 'failed')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedule_occurrences_slot_uq UNIQUE (schedule_id, local_date, local_time)
);

ALTER TABLE search_runs
  ADD CONSTRAINT search_runs_occurrence_fk
  FOREIGN KEY (schedule_occurrence_id) REFERENCES schedule_occurrences (id) ON DELETE SET NULL;

CREATE UNIQUE INDEX search_runs_occurrence_uq
  ON search_runs (schedule_occurrence_id)
  WHERE schedule_occurrence_id IS NOT NULL;

CREATE TABLE ai_providers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type              text NOT NULL CHECK (type IN ('openai_compatible', 'gemini', 'anthropic')),
  base_url          text,
  model             text NOT NULL,
  secret_ciphertext bytea,
  enabled           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_providers_owner_idx ON ai_providers (owner_id, enabled);

CREATE TABLE notification_channels (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider          text NOT NULL,
  destination_ref   text NOT NULL,
  secret_ciphertext bytea,
  enabled           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_channels_owner_idx ON notification_channels (owner_id, enabled);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  event_key   text NOT NULL,
  channel_id  uuid NOT NULL REFERENCES notification_channels (id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'sent', 'failed')),
  sent_at     timestamptz,
  error_code  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_event_uq UNIQUE (owner_id, channel_id, event_key)
);

CREATE TABLE submission_controls (
  owner_id        uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  browser_enabled boolean NOT NULL DEFAULT false,
  quota_timezone  text NOT NULL DEFAULT 'Asia/Jakarta',
  global_limit    integer NOT NULL DEFAULT 0 CHECK (global_limit >= 0),
  source_limits   jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_version  integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  version         integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE submission_recovery_holds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scope          text NOT NULL CHECK (scope IN ('global', 'source', 'target')),
  scope_key      text NOT NULL DEFAULT '',
  checkpoint_at  timestamptz NOT NULL,
  window_end_at  timestamptz,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  evidence_ref   text,
  resolved_at    timestamptz,
  version        integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX submission_holds_active_uq
  ON submission_recovery_holds (owner_id, scope, scope_key)
  WHERE status = 'active';

CREATE INDEX submission_holds_owner_idx
  ON submission_recovery_holds (owner_id, status);

CREATE TABLE privacy_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('export', 'deletion')),
  scope              text NOT NULL CHECK (scope IN ('workspace_data', 'document')),
  resource_id        uuid,
  generation         integer NOT NULL,
  status             text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  artifact_ref       text,
  artifact_expires_at timestamptz,
  backup_expires_at  timestamptz,
  error_code         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX privacy_requests_owner_idx ON privacy_requests (owner_id, created_at DESC);
