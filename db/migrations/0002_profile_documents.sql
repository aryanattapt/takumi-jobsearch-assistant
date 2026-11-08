-- 0002_profile_documents.sql
-- Candidate profile, versioned facts, private documents.

CREATE TABLE candidate_profiles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  display_name     text,
  preferences_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  version          integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('cv', 'cover_letter', 'evidence', 'export', 'other')),
  object_key    text NOT NULL UNIQUE,
  original_name text NOT NULL,
  media_type    text NOT NULL,
  sha256        text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'deleting', 'deleted')),
  version       integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX documents_owner_idx ON documents (owner_id, created_at DESC);

CREATE TABLE profile_facts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type                text NOT NULL,
  current_version_id  uuid,
  verification_status text NOT NULL DEFAULT 'unverified'
                        CHECK (verification_status IN ('unverified', 'verified', 'retracted')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX profile_facts_owner_idx ON profile_facts (owner_id, type);

-- value holds a structured inline value (DB stays private); value_ref points at
-- private storage for payloads that must be retractable on purge.
CREATE TABLE profile_fact_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  fact_id            uuid NOT NULL REFERENCES profile_facts (id) ON DELETE CASCADE,
  version_no         integer NOT NULL CHECK (version_no > 0),
  value              jsonb NOT NULL,
  value_ref          text,
  source_document_id uuid REFERENCES documents (id) ON DELETE SET NULL,
  verified_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_fact_versions_uq UNIQUE (fact_id, version_no)
);

CREATE INDEX profile_fact_versions_source_idx ON profile_fact_versions (source_document_id);

ALTER TABLE profile_facts
  ADD CONSTRAINT profile_facts_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES profile_fact_versions (id) ON DELETE SET NULL;

CREATE TABLE answer_bank (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  question_key        text NOT NULL,
  answer_ciphertext   bytea NOT NULL,
  source_fact_ids     uuid[] NOT NULL DEFAULT '{}',
  verification_status text NOT NULL DEFAULT 'unverified'
                        CHECK (verification_status IN ('unverified', 'verified', 'retracted')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT answer_bank_owner_question_uq UNIQUE (owner_id, question_key)
);

-- Application-scoped immutable document versions. application_id FK is added in
-- 0004 once applications exists.
CREATE TABLE document_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  application_id     uuid,
  document_id        uuid NOT NULL REFERENCES documents (id) ON DELETE RESTRICT,
  kind               text NOT NULL CHECK (kind IN ('cv', 'cover_letter', 'other')),
  version_no         integer NOT NULL CHECK (version_no > 0),
  content_hash       text NOT NULL,
  template_id        text,
  fact_version_ids   uuid[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_versions_app_kind_version_uq UNIQUE (application_id, kind, version_no)
);

CREATE INDEX document_versions_document_idx ON document_versions (document_id);
