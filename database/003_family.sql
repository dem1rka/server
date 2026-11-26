BEGIN;
ALTER TABLE neura.users ADD COLUMN IF NOT EXISTS account_role text NOT NULL DEFAULT 'patient'
  CHECK(account_role IN ('patient','family','specialist','admin'));
CREATE TABLE IF NOT EXISTS neura.family_children (
 family_id uuid NOT NULL REFERENCES neura.users ON DELETE CASCADE,
 child_id uuid NOT NULL REFERENCES neura.participants ON DELETE CASCADE,
 PRIMARY KEY(family_id,child_id)
);
CREATE TABLE IF NOT EXISTS neura.invitations (
 token_hash bytea PRIMARY KEY, email text NOT NULL, role text NOT NULL CHECK(role IN ('family','patient','specialist')),
 issuer uuid NOT NULL REFERENCES neura.users, child_id uuid REFERENCES neura.participants ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, consumed_at timestamptz,
 CHECK ((role='family')=(child_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS neura.assessments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), child_id uuid NOT NULL REFERENCES neura.participants ON DELETE CASCADE,
 specialist_id uuid NOT NULL REFERENCES neura.users, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS neura.assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assessment_id uuid NOT NULL REFERENCES neura.assessments ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('game','questionnaire')), version text NOT NULL DEFAULT '1',
 UNIQUE(assessment_id,kind)
);
CREATE TABLE IF NOT EXISTS neura.assignment_attempts (
 assignment_id uuid PRIMARY KEY REFERENCES neura.assignments ON DELETE CASCADE,
 answers smallint[] NOT NULL DEFAULT '{}', revision integer NOT NULL DEFAULT 0,
 started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
COMMIT;