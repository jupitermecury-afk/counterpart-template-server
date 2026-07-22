-- The Counterpart — problem-scoped store, for the mobile app.
-- Every table answers "what does this say about the problem/work," never "what does this say about the person."
-- No users table. No profile table. No name/email column anywhere.

CREATE TABLE IF NOT EXISTS access_keys (
  id            SERIAL PRIMARY KEY,
  key_hash      TEXT NOT NULL UNIQUE,
  valid_from    TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until   TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS threads (
  id              SERIAL PRIMARY KEY,
  access_key_id   INTEGER NOT NULL REFERENCES access_keys(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','rest','done','unresolved')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_nudged_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_threads_key ON threads(access_key_id);

CREATE TABLE IF NOT EXISTS turns (
  id                SERIAL PRIMARY KEY,
  thread_id         INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('person','counterpart')),
  content           TEXT NOT NULL,
  attachment_label  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_turns_thread ON turns(thread_id);

CREATE TABLE IF NOT EXISTS held_items (
  id          SERIAL PRIMARY KEY,
  thread_id   INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  glyph       TEXT NOT NULL DEFAULT 'live' CHECK (glyph IN ('live','rest','done','unresolved')),
  meta        TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_held_thread ON held_items(thread_id);

CREATE TABLE IF NOT EXISTS verification_items (
  id          SERIAL PRIMARY KEY,
  thread_id   INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  claim_text  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'just_surfaced'
              CHECK (status IN ('just_surfaced','person_confirming','counterpart_checking','proceeding_unconfirmed','confirmed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_verif_thread ON verification_items(thread_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id            SERIAL PRIMARY KEY,
  thread_id     INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  fidelity      TEXT NOT NULL DEFAULT 'draft' CHECK (fidelity IN ('draft','full')),
  content_json  JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_artifacts_thread ON artifacts(thread_id);

-- Set only when a prepare_email_draft artifact has actually been sent (person-triggered,
-- never by the model) — lets the app show "sent" persistently and prevents double-sending.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS push_tokens (
  id                SERIAL PRIMARY KEY,
  access_key_id     INTEGER NOT NULL REFERENCES access_keys(id) ON DELETE CASCADE,
  expo_push_token   TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(access_key_id, expo_push_token)
);
