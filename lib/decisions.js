// Decisions layer: what the person has actually decided, and why. Shared by the mobile (/api)
// and web (/webapi) routes, which keep separate tables — callers pass the table names.
//
// A decision is judgment, so it is the person's: the counterpart can only PROPOSE one, and it
// becomes "live" when the person confirms it. made_by is never the counterpart.

const MAX_LIVE_IN_CONTEXT = 5;   // most recent confirmed decisions pushed into each turn
const MAX_TEXT = 600;
const MAX_TAGS = 8;

function clean(s, max) {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function normalizeInput(input) {
  const decision = clean(input && input.decision, MAX_TEXT);
  if (!decision) return null;
  const tags = Array.isArray(input.affects)
    ? input.affects.map(t => clean(t, 40).toLowerCase()).filter(Boolean).slice(0, MAX_TAGS)
    : [];
  return {
    decision,
    rationale: clean(input.rationale, MAX_TEXT) || null,
    affects: [...new Set(tags)],
    made_by: input.made_by === 'joint' ? 'joint' : 'person', // never "counterpart"
    // The model sees each confirmed decision as a line of context and may copy more than the bare
    // text (a leading dash, a trailing "(why: ...)"). Match on the decision text alone.
    supersedes: clean(input.supersedes, MAX_TEXT)
      .replace(/^[-•*]\s*/, '')
      .replace(/\s*\((why|because|rationale):.*\)\s*$/i, '')
      .replace(/^\[[^\]]*\]\s*/, '') || null,
  };
}

// Records a PROPOSED decision. Returns the new row, or null when there is nothing to record or
// the same decision is already proposed/live in this situation.
async function logDecision(pool, tables, threadId, input) {
  const d = normalizeInput(input);
  if (!d) return null;

  const dup = await pool.query(
    `SELECT id FROM ${tables.decisions} WHERE thread_id = $1 AND decision = $2 AND status IN ('proposed','live')`,
    [threadId, d.decision]
  );
  if (dup.rows[0]) return null;

  const inserted = await pool.query(
    `INSERT INTO ${tables.decisions} (thread_id, decision, rationale, affects, made_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [threadId, d.decision, d.rationale, d.affects, d.made_by]
  );
  const row = inserted.rows[0];

  if (d.supersedes && row) {
    const prior = await pool.query(
      `SELECT id FROM ${tables.decisions} WHERE thread_id = $1 AND decision = $2 AND status = 'live' AND id <> $3`,
      [threadId, d.supersedes, row.id]
    );
    if (prior.rows[0]) {
      await pool.query(
        `UPDATE ${tables.decisions} SET status = 'superseded', superseded_by = $1, updated_at = now() WHERE id = $2`,
        [row.id, prior.rows[0].id]
      );
    }
  }
  return row;
}

// The block of ground truth the model sees each turn. Proposed ones are included so it does not
// propose them again, and is told they are not yet the person's confirmed position.
async function decisionsContext(pool, tables, threadId) {
  const [live, proposed] = await Promise.all([
    pool.query(
      `SELECT decision, rationale FROM ${tables.decisions}
       WHERE thread_id = $1 AND status = 'live' ORDER BY updated_at DESC LIMIT ${MAX_LIVE_IN_CONTEXT}`,
      [threadId]
    ),
    pool.query(
      `SELECT decision FROM ${tables.decisions} WHERE thread_id = $1 AND status = 'proposed' ORDER BY id ASC`,
      [threadId]
    ),
  ]);
  let block = '';
  if (live.rows.length) {
    block += `\n\nDECISIONS THE PERSON HAS CONFIRMED (their standing position — build on these, do not reopen them unless they do; to replace one, pass its exact text as supersedes in log_decision):\n`;
    block += live.rows.map(r => `- ${r.decision}${r.rationale ? `\n    why: ${r.rationale}` : ''}`).join('\n');
  }
  if (proposed.rows.length) {
    block += `\n\nDECISIONS PROPOSED AND AWAITING THE PERSON'S CONFIRMATION (not yet their confirmed position; do not log them again):\n`;
    block += proposed.rows.map(r => `- ${r.decision}`).join('\n');
  }
  return block;
}

// Person-driven changes. Ownership is enforced through the thread's access key.
async function updateDecision(pool, tables, id, accessKeyId, patch) {
  const found = await pool.query(
    `SELECT d.* FROM ${tables.decisions} d JOIN ${tables.threads} t ON t.id = d.thread_id
     WHERE d.id = $1 AND t.access_key_id = $2`,
    [id, accessKeyId]
  );
  const row = found.rows[0];
  if (!row) return { error: 'not found', status: 404 };

  let status = row.status;
  if (patch.status !== undefined) {
    const allowed = { proposed: ['live'], live: ['reversed'], superseded: [], reversed: ['live'] };
    if (!(allowed[row.status] || []).includes(patch.status)) {
      return { error: `cannot move a ${row.status} decision to ${patch.status}`, status: 400 };
    }
    status = patch.status;
  }
  const decision = patch.decision !== undefined ? clean(patch.decision, MAX_TEXT) : row.decision;
  if (!decision) return { error: 'decision text cannot be empty', status: 400 };
  const rationale = patch.rationale !== undefined ? (clean(patch.rationale, MAX_TEXT) || null) : row.rationale;

  const updated = await pool.query(
    `UPDATE ${tables.decisions} SET status = $1, decision = $2, rationale = $3, updated_at = now()
     WHERE id = $4 RETURNING *`,
    [status, decision, rationale, id]
  );
  return { row: updated.rows[0] };
}

// A proposal the person rejects is not a decision that was reversed — it never existed, so it is
// removed. Confirmed decisions are reversed (kept, with history), never deleted here.
async function dismissProposal(pool, tables, id, accessKeyId) {
  const res = await pool.query(
    `DELETE FROM ${tables.decisions} d USING ${tables.threads} t
     WHERE d.id = $1 AND t.id = d.thread_id AND t.access_key_id = $2 AND d.status = 'proposed'
     RETURNING d.id`,
    [id, accessKeyId]
  );
  return !!res.rows[0];
}

module.exports = { logDecision, decisionsContext, updateDecision, dismissProposal, normalizeInput };
