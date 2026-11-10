-- Phase 3: one owner-configured AI provider, grounded review metadata,
-- application document versions, and reviewable PDF artifacts.

CREATE UNIQUE INDEX ai_providers_one_per_owner_uq ON ai_providers (owner_id);
ALTER TABLE ai_providers
  ADD COLUMN last_tested_at timestamptz,
  ADD COLUMN last_test_status text CHECK (last_test_status IN ('passed', 'failed'));

CREATE TABLE ai_job_reviews (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  job_id                uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  posting_revision_id   uuid REFERENCES posting_revisions (id) ON DELETE SET NULL,
  profile_version       integer NOT NULL CHECK (profile_version > 0),
  fact_version_ids      uuid[] NOT NULL CHECK (cardinality(fact_version_ids) > 0),
  provider_id           uuid NOT NULL REFERENCES ai_providers (id) ON DELETE RESTRICT,
  provider_type         text NOT NULL,
  model                 text NOT NULL,
  prompt_version        text NOT NULL,
  schema_version        text NOT NULL,
  result_json           jsonb NOT NULL,
  input_tokens          integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens         integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  latency_ms            integer NOT NULL CHECK (latency_ms >= 0),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_job_reviews_owner_job_idx ON ai_job_reviews (owner_id, job_id, created_at DESC);

CREATE TABLE application_document_versions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                 uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  application_id           uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  kind                     text NOT NULL CHECK (kind IN ('cv', 'cover_letter')),
  version_no               integer NOT NULL CHECK (version_no > 0),
  content_ciphertext       bytea NOT NULL,
  source_fact_version_ids  uuid[] NOT NULL CHECK (cardinality(source_fact_version_ids) > 0),
  document_id              uuid NOT NULL REFERENCES documents (id) ON DELETE RESTRICT,
  document_version_id      uuid NOT NULL UNIQUE REFERENCES document_versions (id) ON DELETE RESTRICT,
  pdf_status               text NOT NULL CHECK (pdf_status IN ('passed', 'failed')),
  pdf_check                jsonb NOT NULL,
  reviewed_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT application_document_versions_uq UNIQUE (application_id, kind, version_no)
);
CREATE INDEX application_document_versions_owner_idx
  ON application_document_versions (owner_id, application_id, created_at DESC);

ALTER TABLE application_answers
  ADD COLUMN source_fact_version_ids uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE answer_bank
  ADD COLUMN source_fact_version_ids uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE application_answers ADD COLUMN question_key text;
UPDATE application_answers
   SET question_key = regexp_replace(lower(trim(question)), '\s+', ' ', 'g')
 WHERE question_key IS NULL;
ALTER TABLE application_answers ALTER COLUMN question_key SET NOT NULL;
CREATE UNIQUE INDEX application_answers_question_key_uq
  ON application_answers (application_id, question_key);

CREATE TABLE application_answer_versions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  application_id          uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  answer_id               uuid NOT NULL REFERENCES application_answers (id) ON DELETE CASCADE,
  version_no              integer NOT NULL CHECK (version_no > 0),
  question                text NOT NULL,
  answer_ciphertext       bytea NOT NULL,
  source_fact_ids         uuid[] NOT NULL DEFAULT '{}',
  source_fact_version_ids uuid[] NOT NULL DEFAULT '{}',
  verification_status    text NOT NULL CHECK (verification_status IN ('unverified', 'verified', 'needs_user_input', 'retracted')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT application_answer_versions_uq UNIQUE (answer_id, version_no)
);
CREATE INDEX application_answer_versions_application_idx
  ON application_answer_versions (owner_id, application_id, created_at DESC);
