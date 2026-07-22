-- The Counterpart — web app's own problem-scoped store. Deliberately isolated from
-- 001_init.sql's tables (the mobile app's): own keys, own threads, own everything.
-- No FKs into the mobile tables, no shared code path except lib/claude.js.

-- One table for both plain keys and issued seats/cohorts. issuer_key_id models the
-- existing operator/partner console's self-service pattern (org() === currentKey) —
-- any key can issue further keys under itself, at unlimited depth. org_* columns are
-- populated only when a key is actually used as an org (someone logs into
-- operator.html/partner.html with it and issues seats) — no separate org table.
CREATE TABLE IF NOT EXISTS web_access_keys (
  id              SERIAL PRIMARY KEY,
  key_hash        TEXT NOT NULL UNIQUE,
  issuer_key_id   INTEGER REFERENCES web_access_keys(id) ON DELETE SET NULL,
  label           TEXT,
  cohort          TEXT,
  lang            TEXT,
  voice_first     BOOLEAN NOT NULL DEFAULT false,
  valid_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until     TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  org_name        TEXT,
  org_context     TEXT,
  org_rate        NUMERIC(10,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_web_access_keys_issuer ON web_access_keys(issuer_key_id);

-- title/pinned/context are new vs. the mobile threads table — index.html's situations
-- are a richer object (user-titled, pinnable, with a per-situation standing-context box).
CREATE TABLE IF NOT EXISTS web_threads (
  id              SERIAL PRIMARY KEY,
  access_key_id   INTEGER NOT NULL REFERENCES web_access_keys(id) ON DELETE CASCADE,
  title           TEXT,
  pinned          BOOLEAN NOT NULL DEFAULT false,
  context         TEXT,
  status          TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','rest','done','unresolved')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_web_threads_key ON web_threads(access_key_id);

CREATE TABLE IF NOT EXISTS web_turns (
  id                SERIAL PRIMARY KEY,
  thread_id         INTEGER NOT NULL REFERENCES web_threads(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('person','counterpart')),
  content           TEXT NOT NULL,
  attachment_label  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_web_turns_thread ON web_turns(thread_id);

-- source distinguishes model-authored (via the update_held_thread tool) from
-- person-authored (a manually jotted checklist item) rows — the web app's existing
-- "Steps" feature is user-editable today, and nothing asks for that to be removed.
CREATE TABLE IF NOT EXISTS web_held_items (
  id          SERIAL PRIMARY KEY,
  thread_id   INTEGER NOT NULL REFERENCES web_threads(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  glyph       TEXT NOT NULL DEFAULT 'live' CHECK (glyph IN ('live','rest','done','unresolved')),
  meta        TEXT,
  source      TEXT NOT NULL DEFAULT 'model' CHECK (source IN ('model','person')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_web_held_thread ON web_held_items(thread_id);

CREATE TABLE IF NOT EXISTS web_verification_items (
  id          SERIAL PRIMARY KEY,
  thread_id   INTEGER NOT NULL REFERENCES web_threads(id) ON DELETE CASCADE,
  claim_text  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'just_surfaced'
              CHECK (status IN ('just_surfaced','person_confirming','counterpart_checking','proceeding_unconfirmed','confirmed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_web_verif_thread ON web_verification_items(thread_id);

-- source: same model/person split as web_held_items — "Documents" today are freeform
-- user notes as well as counterpart-drafted artifacts. sent_at mirrors the mobile
-- app's send-tracking for prepare_email_draft artifacts (web has no send-for-real
-- action, but the column costs nothing to keep the shape consistent and future-proof).
CREATE TABLE IF NOT EXISTS web_artifacts (
  id            SERIAL PRIMARY KEY,
  thread_id     INTEGER NOT NULL REFERENCES web_threads(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  fidelity      TEXT NOT NULL DEFAULT 'draft' CHECK (fidelity IN ('draft','full')),
  content_json  JSONB NOT NULL,
  source        TEXT NOT NULL DEFAULT 'model' CHECK (source IN ('model','person')),
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_web_artifacts_thread ON web_artifacts(thread_id);
