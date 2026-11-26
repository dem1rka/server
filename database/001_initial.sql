-- PostgreSQL 16+. Run ONCE in a new, empty neura database as its owner.
-- This creates storage, not a complete authorization system.
-- Backend must authorize every record/file request. Never expose DB to browsers.
BEGIN;
CREATE SCHEMA neura;
REVOKE ALL ON SCHEMA neura FROM PUBLIC;
SET LOCAL search_path = neura, pg_catalog;
ALTER DEFAULT PRIVILEGES IN SCHEMA neura REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  password_hash text NOT NULL, -- Argon2id encoded hash, never a password
  display_name text NOT NULL DEFAULT '',
  email_verified_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens(user_id);

CREATE TABLE participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX participants_owner_idx ON participants(owner_id);
-- Owner alone grants/revokes access through the backend.
-- No global specialist role grants automatic access to participant data.
CREATE TABLE participant_access (
  participant_id uuid NOT NULL REFERENCES participants ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission IN ('read', 'contribute')),
  granted_by uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (participant_id, user_id),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX participant_access_user_idx ON participant_access(user_id);

-- One row per questionnaire/game/MRI observation. Payload schema is validated
-- by backend according to kind, instrument_key and instrument_version.
CREATE TABLE observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES participants ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('questionnaire', 'game', 'mri')),
  instrument_key text NOT NULL,
  instrument_version text NOT NULL,
  language text NOT NULL DEFAULT 'ru' CHECK (language IN ('ru', 'kk', 'en')),
  age_months integer CHECK (age_months BETWEEN 0 AND 1500),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);
CREATE INDEX observations_participant_idx ON observations(participant_id, started_at DESC);
CREATE INDEX observations_author_idx ON observations(author_id);
CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id uuid NOT NULL REFERENCES observations ON DELETE CASCADE,
  observation_revision integer NOT NULL CHECK (observation_revision > 0),
  generator_version text NOT NULL,
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_observation_idx ON reports(observation_id);
CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id uuid NOT NULL REFERENCES observations ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE, -- private storage key, never a public URL
  media_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_observation_idx ON files(observation_id);
CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE RESTRICT,
  participant_id uuid NOT NULL REFERENCES participants ON DELETE CASCADE,
  purpose text NOT NULL,
  document_version text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);
CREATE INDEX consents_participant_idx ON consents(participant_id);
CREATE INDEX consents_user_idx ON consents(user_id);
-- No passwords, tokens, answers, email addresses or medical payloads in audit.
-- UUID references deliberately have no FK: audit survives deletion of records.
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  request_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_resource_idx ON audit_events(resource_type, resource_id, occurred_at DESC);
CREATE INDEX audit_actor_idx ON audit_events(actor_id, occurred_at DESC);

CREATE FUNCTION touch_observation() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
BEGIN
  NEW.updated_at = now();
  NEW.revision = OLD.revision + 1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER observation_revision BEFORE UPDATE ON observations
FOR EACH ROW EXECUTE FUNCTION touch_observation();
REVOKE ALL ON ALL TABLES IN SCHEMA neura FROM PUBLIC;
COMMIT;