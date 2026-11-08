-- 0004_applications.sql
-- Portal accounts, applications, review snapshots, approvals, attempts,
-- evidence, events, quota buckets/reservations, interview packs.

CREATE TABLE portal_accounts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_id              uuid NOT NULL REFERENCES sources (id),
  label                  text NOT NULL,
  encrypted_profile_ref  bytea,
  session_state          text NOT NULL DEFAULT 'needs_login'
                           CHECK (session_state IN ('needs_login', 'active', 'expired', 'blocked', 'logged_out')),
  last_checked_at        timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX portal_accounts_owner_idx ON portal_accounts (owner_id, source_id);

CREATE TABLE applications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  job_id            uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  submission_status text NOT NULL DEFAULT 'draft'
                      CHECK (submission_status IN (
                        'draft', 'ready_for_review', 'approved', 'submitting',
                        'submitted_confirmed', 'submit_unknown', 'not_submitted', 'cancelled')),
  recruitment_stage text NOT NULL DEFAULT 'not_started'
                      CHECK (recruitment_stage IN (
                        'not_started', 'under_review', 'interview', 'offered',
                        'rejected', 'withdrawn', 'unknown')),
  current_version   integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT applications_owner_job_uq UNIQUE (owner_id, job_id)
);

CREATE INDEX applications_owner_status_idx ON applications (owner_id, submission_status, updated_at DESC);

ALTER TABLE document_versions
  ADD CONSTRAINT document_versions_application_fk
  FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE;

CREATE TABLE application_answers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id      uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  question            text NOT NULL,
  answer_ref          text,
  answer_ciphertext   bytea,
  source_fact_ids     uuid[] NOT NULL DEFAULT '{}',
  verification_status text NOT NULL DEFAULT 'unverified'
                        CHECK (verification_status IN ('unverified', 'verified', 'needs_user_input', 'retracted')),
  version             integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT application_answers_uq UNIQUE (application_id, question)
);

CREATE TABLE application_review_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  application_id      uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  listing_id          uuid NOT NULL REFERENCES job_listings (id) ON DELETE CASCADE,
  posting_revision_id uuid NOT NULL REFERENCES posting_revisions (id) ON DELETE CASCADE,
  portal_account_id   uuid REFERENCES portal_accounts (id) ON DELETE SET NULL,
  target_key          text,
  form_fingerprint    text NOT NULL,
  content             jsonb NOT NULL,
  content_ref         text,
  snapshot_hash       text NOT NULL,
  captured_at         timestamptz NOT NULL DEFAULT now(),
  valid_until         timestamptz NOT NULL,
  invalidated_at      timestamptz
);

CREATE INDEX review_snapshots_application_idx
  ON application_review_snapshots (application_id, captured_at DESC);

CREATE TABLE approvals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  owner_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  snapshot_id    uuid NOT NULL REFERENCES application_review_snapshots (id) ON DELETE CASCADE,
  approved_at    timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX approvals_active_idx
  ON approvals (application_id, expires_at)
  WHERE revoked_at IS NULL AND consumed_at IS NULL;

CREATE TABLE application_attempts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  application_id         uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  approval_id            uuid UNIQUE REFERENCES approvals (id) ON DELETE SET NULL,
  listing_id             uuid REFERENCES job_listings (id) ON DELETE SET NULL,
  portal_account_id      uuid REFERENCES portal_accounts (id) ON DELETE SET NULL,
  target_key             text,
  mode                   text NOT NULL CHECK (mode IN ('manual', 'dry_run', 'review_before_submit')),
  state                  text NOT NULL
                           CHECK (state IN (
                             'reserved', 'running', 'submitting', 'submitted_confirmed',
                             'submit_unknown', 'not_submitted', 'cancelled', 'simulated')),
  version                integer NOT NULL DEFAULT 1 CHECK (version > 0),
  dispatch_intent_at     timestamptz,
  dispatch_owner         text,
  reported_submitted_at  timestamptz,
  material_ref           text,
  confirmation_source    text CHECK (confirmation_source IN ('portal', 'manual')),
  confirmation_ref       text,
  error_code             text,
  finished_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attempts_intent_owner_ck CHECK (
    dispatch_intent_at IS NULL OR dispatch_owner IS NOT NULL),
  CONSTRAINT attempts_confirmed_ck CHECK (
    state <> 'submitted_confirmed' OR confirmation_source IS NOT NULL)
);

CREATE INDEX attempts_application_idx ON application_attempts (application_id, created_at DESC);
CREATE INDEX attempts_owner_state_idx ON application_attempts (owner_id, state);

-- One active browser attempt per application.
CREATE UNIQUE INDEX attempts_one_active_uq
  ON application_attempts (application_id)
  WHERE mode = 'review_before_submit'
    AND state IN ('reserved', 'running', 'submitting');

-- One submit lock per verified target (cross-listing, cross-run).
CREATE UNIQUE INDEX attempts_target_lock_uq
  ON application_attempts (owner_id, target_key)
  WHERE target_key IS NOT NULL
    AND mode IN ('review_before_submit', 'manual')
    AND state IN ('reserved', 'running', 'submitting', 'submit_unknown', 'submitted_confirmed');

CREATE TABLE attempt_evidence (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id     uuid NOT NULL REFERENCES application_attempts (id) ON DELETE CASCADE,
  kind           text NOT NULL,
  provider_ref   text,
  source         text NOT NULL CHECK (source IN ('portal', 'manual', 'adapter')),
  object_key     text,
  policy_version text,
  captured_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attempt_evidence_attempt_idx ON attempt_evidence (attempt_id, captured_at DESC);

CREATE TABLE application_events (
  id             bigserial PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  attempt_id     uuid REFERENCES application_attempts (id) ON DELETE SET NULL,
  event_type     text NOT NULL,
  from_state     text,
  to_state       text,
  actor_type     text NOT NULL CHECK (actor_type IN ('owner', 'worker', 'system')),
  actor_id       text,
  reason_code    text,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX application_events_app_idx ON application_events (application_id, occurred_at DESC);

CREATE TABLE quota_buckets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scope          text NOT NULL CHECK (scope IN ('global', 'source')),
  scope_key      text NOT NULL,
  local_date     date NOT NULL,
  policy_version integer NOT NULL DEFAULT 1,
  reserved_count integer NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
  consumed_count integer NOT NULL DEFAULT 0 CHECK (consumed_count >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quota_buckets_uq UNIQUE (owner_id, scope, scope_key, local_date)
);

CREATE TABLE quota_reservations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id       uuid NOT NULL UNIQUE REFERENCES application_attempts (id) ON DELETE CASCADE,
  global_bucket_id uuid NOT NULL REFERENCES quota_buckets (id),
  source_bucket_id uuid NOT NULL REFERENCES quota_buckets (id),
  reserved_at      timestamptz NOT NULL DEFAULT now(),
  consumed_at      timestamptz,
  timezone         text NOT NULL,
  state            text NOT NULL DEFAULT 'reserved'
                     CHECK (state IN ('reserved', 'consumed', 'released')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE interview_packs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  application_id      uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  posting_revision_id uuid REFERENCES posting_revisions (id) ON DELETE SET NULL,
  version_no          integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
  document_version_ids uuid[] NOT NULL DEFAULT '{}',
  content_ref         text,
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interview_packs_version_uq UNIQUE (application_id, version_no)
);
