-- 0003_jobs.sql
-- Sources, canonical jobs, listings, revisions, search runs, evaluations.

CREATE TABLE sources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,
  name             text NOT NULL,
  adapter_version  text,
  enabled          boolean NOT NULL DEFAULT false,
  capabilities_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  access_policy    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO sources (code, name, adapter_version, enabled)
VALUES ('manual', 'Manual import', '1', true);

CREATE TABLE jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  company_normalized text NOT NULL DEFAULT '',
  title_normalized   text NOT NULL DEFAULT '',
  location           text,
  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'archived', 'merged')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jobs_owner_status_idx ON jobs (owner_id, status);

CREATE TABLE job_listings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  job_id              uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  source_id           uuid NOT NULL REFERENCES sources (id),
  external_id         text,
  canonical_url       text,
  current_revision_id uuid,
  retrieved_at        timestamptz NOT NULL DEFAULT now(),
  posting_status      text NOT NULL DEFAULT 'unknown'
                        CHECK (posting_status IN ('active', 'expired', 'unknown', 'unreachable')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX job_listings_source_external_uq
  ON job_listings (owner_id, source_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX job_listings_job_idx ON job_listings (job_id);

CREATE TABLE posting_revisions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id   uuid NOT NULL REFERENCES job_listings (id) ON DELETE CASCADE,
  title        text NOT NULL DEFAULT '',
  company      text NOT NULL DEFAULT '',
  description  text NOT NULL DEFAULT '',
  location     text,
  salary_json  jsonb,
  content_hash text NOT NULL,
  content_ref  text,
  provenance   text NOT NULL CHECK (provenance IN ('adapter', 'manual', 'owner_paste')),
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX posting_revisions_listing_idx ON posting_revisions (listing_id, retrieved_at DESC);

ALTER TABLE job_listings
  ADD CONSTRAINT job_listings_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES posting_revisions (id) ON DELETE SET NULL;

CREATE TABLE duplicate_suggestions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  left_job_id uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  right_job_id uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  confidence  numeric(5, 4) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  reason      text NOT NULL DEFAULT '',
  resolution  text NOT NULL DEFAULT 'pending'
                CHECK (resolution IN ('pending', 'merged', 'rejected')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT duplicate_suggestions_pair_ck CHECK (left_job_id < right_job_id),
  CONSTRAINT duplicate_suggestions_pair_uq UNIQUE (owner_id, left_job_id, right_job_id)
);

CREATE INDEX duplicate_suggestions_pending_idx
  ON duplicate_suggestions (owner_id, created_at DESC) WHERE resolution = 'pending';

CREATE TABLE saved_searches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  filters_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_codes text[] NOT NULL DEFAULT '{}',
  version      integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE search_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  query_snapshot         jsonb NOT NULL,
  status                 text NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  started_at             timestamptz,
  finished_at            timestamptz,
  schedule_occurrence_id uuid,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX search_runs_owner_idx ON search_runs (owner_id, created_at DESC);

CREATE TABLE search_run_sources (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid NOT NULL REFERENCES search_runs (id) ON DELETE CASCADE,
  source_id  uuid NOT NULL REFERENCES sources (id),
  status     text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'timeout')),
  counts     jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_run_sources_uq UNIQUE (run_id, source_id)
);

CREATE TABLE search_run_listings (
  run_id              uuid NOT NULL REFERENCES search_runs (id) ON DELETE CASCADE,
  listing_id          uuid NOT NULL REFERENCES job_listings (id) ON DELETE CASCADE,
  posting_revision_id uuid REFERENCES posting_revisions (id) ON DELETE SET NULL,
  seen_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, listing_id)
);

CREATE TABLE match_evaluations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  job_id              uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  evaluation_version  integer NOT NULL DEFAULT 1 CHECK (evaluation_version > 0),
  profile_version     integer NOT NULL,
  posting_revision_id uuid REFERENCES posting_revisions (id) ON DELETE SET NULL,
  rubric_version      text NOT NULL,
  score_json          jsonb NOT NULL DEFAULT '{}'::jsonb,
  score               numeric(4, 1),
  gaps_json           jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_refs         jsonb NOT NULL DEFAULT '[]'::jsonb,
  model               text,
  status              text NOT NULL CHECK (status IN ('scored', 'insufficient_data', 'unreachable', 'failed')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_evaluations_version_uq UNIQUE (job_id, evaluation_version)
);

CREATE INDEX match_evaluations_owner_idx ON match_evaluations (owner_id, created_at DESC);

CREATE TABLE company_research (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  job_id     uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  summary    text NOT NULL DEFAULT '',
  claims_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  checked_at timestamptz,
  status     text NOT NULL DEFAULT 'unknown'
               CHECK (status IN ('complete', 'unknown', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX company_research_job_idx ON company_research (job_id, created_at DESC);
