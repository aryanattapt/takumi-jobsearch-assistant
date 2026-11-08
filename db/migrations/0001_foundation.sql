-- 0001_foundation.sql
-- Identity, sessions, audit, idempotency, outbox, background tasks.
-- Source of truth: requirement/05-DBD-Database-Design.md, 06-BSD, 07-BSD.

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL,
  email_normalized   text NOT NULL,
  password_hash      text NOT NULL,
  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'disabled')),
  timezone           text NOT NULL DEFAULT 'Asia/Jakarta',
  privacy_generation integer NOT NULL DEFAULT 1 CHECK (privacy_generation > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_normalized_uq UNIQUE (email_normalized),
  CONSTRAINT users_email_shape_ck CHECK (position('@' IN email) > 1)
);

-- Single-owner installation singleton. The migration seeds the row; the CLI
-- locks it and fills owner_id atomically. HTTP must never provision an owner.
CREATE TABLE installation_owner (
  slot           smallint PRIMARY KEY DEFAULT 1 CHECK (slot = 1),
  owner_id       uuid UNIQUE REFERENCES users (id),
  provisioned_at timestamptz,
  CONSTRAINT installation_owner_provisioned_ck
    CHECK ((owner_id IS NULL AND provisioned_at IS NULL)
        OR (owner_id IS NOT NULL AND provisioned_at IS NOT NULL))
);

INSERT INTO installation_owner (slot) VALUES (1);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  csrf_token   text NOT NULL,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip_hash      text,
  user_agent_hash text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_owner_idx ON sessions (owner_id, expires_at DESC);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- DB-backed fixed-window throttle for login attempts (single-instance pilot).
CREATE TABLE auth_throttle (
  key          text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  count        integer NOT NULL DEFAULT 0 CHECK (count >= 0)
);

CREATE TABLE audit_events (
  id          bigserial PRIMARY KEY,
  owner_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_type  text NOT NULL CHECK (actor_type IN ('owner', 'worker', 'operator', 'system', 'anonymous')),
  actor_id    text,
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  result      text NOT NULL CHECK (result IN ('success', 'failure', 'denied')),
  request_id  text,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_events_owner_idx ON audit_events (owner_id, occurred_at DESC);

-- Idempotency scope: (owner, method, normalized route, key).
CREATE TABLE idempotency_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  method          text NOT NULL,
  route           text NOT NULL,
  key             text NOT NULL,
  request_hash    text NOT NULL,
  operation_id    uuid,
  state           text NOT NULL DEFAULT 'in_progress'
                    CHECK (state IN ('in_progress', 'completed')),
  response_status integer,
  response_body   jsonb,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_scope_uq UNIQUE (owner_id, method, route, key)
);

CREATE INDEX idempotency_expiry_idx ON idempotency_records (expires_at);

CREATE TABLE outbox_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid REFERENCES users (id) ON DELETE CASCADE,
  event_key    text NOT NULL UNIQUE,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_unpublished_idx ON outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  state           text NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  available_at    timestamptz NOT NULL DEFAULT now(),
  lease_owner     text,
  lease_until     timestamptz,
  lease_token     integer NOT NULL DEFAULT 0,
  attempt_count   integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts    integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 25),
  idempotency_key text,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

CREATE INDEX tasks_claim_idx ON tasks (state, available_at);
CREATE INDEX tasks_owner_idx ON tasks (owner_id, created_at DESC);
CREATE UNIQUE INDEX tasks_idempotency_uq
  ON tasks (owner_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
