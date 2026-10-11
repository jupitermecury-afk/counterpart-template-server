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

-- Rolling standing summary that lets a long-running situation stay coherent without
-- resending its entire history every request. See maybeCompact() in routes/api.js.
ALTER TABLE threads ADD COLUMN IF NOT EXISTS compacted_summary TEXT;
ALTER TABLE threads ADD COLUMN IF NOT EXISTS compacted_through_id INTEGER NOT NULL DEFAULT 0;

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

-- Lets the model track real time pressure and dependency on a held item, instead of just a
-- flat status — when it's actually due, and what it's actually waiting on.
ALTER TABLE held_items ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
ALTER TABLE held_items ADD COLUMN IF NOT EXISTS blocked_on TEXT;

-- Tracks when THIS item was last nudged about specifically for its deadline — separate
-- from threads.last_nudged_at (the generic quiet-time presence nudge), so a real deadline
-- isn't throttled by an unrelated cooldown on the thread. See runDeadlineNudgeSweep()
-- in lib/pushNudge.js.
ALTER TABLE held_items ADD COLUMN IF NOT EXISTS nudged_at TIMESTAMPTZ;

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

-- What would actually resolve this claim (e.g. "check the county assessor's site",
-- "call the insurer") — the register used to hold only the claim itself, with nowhere
-- to record how it could be checked.
ALTER TABLE verification_items ADD COLUMN IF NOT EXISTS confirm_via TEXT;

-- When this claim has to be resolved by, and when a deadline nudge was last sent for it
-- (independent of the thread-level presence cooldown, same as held_items.nudged_at).
ALTER TABLE verification_items ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
ALTER TABLE verification_items ADD COLUMN IF NOT EXISTS nudged_at TIMESTAMPTZ;

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

-- Decisions: what the person has actually decided and why. The counterpart can only PROPOSE
-- one; it becomes live when the person confirms it. made_by is never the counterpart.
CREATE TABLE IF NOT EXISTS decisions (
  id             SERIAL PRIMARY KEY,
  thread_id      INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  decision       TEXT NOT NULL,
  rationale      TEXT,
  affects        TEXT[] NOT NULL DEFAULT '{}',
  made_by        TEXT NOT NULL DEFAULT 'person' CHECK (made_by IN ('person','joint')),
  status         TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','live','superseded','reversed')),
  superseded_by  INTEGER REFERENCES decisions(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_decisions_thread ON decisions(thread_id);

-- Actions log: a passive audit trail of what actually left the system from a situation (an
-- email sent, a calendar event added, text shared). The record, not the working surface.
CREATE TABLE IF NOT EXISTS actions (
  id                 SERIAL PRIMARY KEY,
  thread_id          INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  artifact_id        INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
  action_type        TEXT NOT NULL,
  description        TEXT NOT NULL,
  executed_by        TEXT NOT NULL DEFAULT 'person' CHECK (executed_by IN ('person','counterpart')),
  confirmation_mode  TEXT NOT NULL DEFAULT 'person_confirmed' CHECK (confirmation_mode IN ('person_confirmed','person_executed','autonomous')),
  outcome            TEXT NOT NULL DEFAULT 'ok',
  confirmation_ref   TEXT,
  parameters         JSONB NOT NULL DEFAULT '{}'::jsonb,
  executed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_actions_thread ON actions(thread_id);

-- Evidence the counterpart attached to a claim while checking it (finding, supports, sources).
ALTER TABLE verification_items ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '[]'::jsonb;

-- One row per "move this forward" review: what it reported, what it changed, what it cost.
CREATE TABLE IF NOT EXISTS reviews (
  id             SERIAL PRIMARY KEY,
  thread_id      INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK (status IN ('ok','skipped','failed')),
  report         JSONB NOT NULL DEFAULT '{}'::jsonb,
  changes        JSONB NOT NULL DEFAULT '{}'::jsonb,
  model          TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  searches       INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reviews_thread ON reviews(thread_id, created_at);
