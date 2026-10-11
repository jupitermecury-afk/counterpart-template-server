// Actions log: a passive audit trail of what has actually left the system from a situation —
// an email sent, a calendar event added, text shared. It is the record, not the working surface:
// nothing is loaded wholesale, and it never grants the counterpart any authority.
//
// Honesty rule: log only what is known. Opening the mail composer is "opened", not "sent",
// because the phone cannot always tell whether the person pressed send.

const CONTEXT_LIMIT = 5;
const LIST_LIMIT = 50;

function short(s, n) {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// What a device can report, and how each is described. The server builds the description from
// the stored artifact, never from client-supplied text, so the log cannot be written to say
// something the artifact does not.
const CLIENT_ACTIONS = {
  email_composer_opened: {
    kinds: ['prepare_email_draft'],
    outcome: 'opened',
    build: (c) => ({
      description: `Opened an email${c.to ? ` to ${short(c.to, 80)}` : ''}${c.subject ? ` — “${short(c.subject, 80)}”` : ''} in the mail app (whether it was sent is up to them)`,
      parameters: { to: c.to || null, subject: c.subject || null },
    }),
  },
  calendar_event_added: {
    kinds: ['prepare_calendar_event'],
    outcome: 'added',
    build: (c) => ({
      description: `Added “${short(c.title, 80) || 'an event'}” to their calendar`,
      parameters: { title: c.title || null, start_iso: c.start_iso || null },
    }),
  },
  whatsapp_opened: {
    kinds: null, // any text artifact
    outcome: 'opened',
    build: (c, a) => ({
      description: `Opened WhatsApp with “${short(a.title, 80) || 'a document'}” (whether it was sent is up to them)`,
      parameters: { title: a.title || null },
    }),
  },
  text_shared: {
    kinds: null, // any artifact
    outcome: 'shared',
    build: (c, a) => ({
      description: `Shared “${short(a.title, 80) || 'a document'}” from their device`,
      parameters: { title: a.title || null },
    }),
  },
};

// Never lets a logging failure break the action it describes.
async function recordAction(pool, tables, threadId, a) {
  try {
    const res = await pool.query(
      `INSERT INTO ${tables.actions}
         (thread_id, artifact_id, action_type, description, executed_by, confirmation_mode, outcome, confirmation_ref, parameters)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        threadId, a.artifact_id || null, a.action_type, short(a.description, 400),
        a.executed_by || 'person', a.confirmation_mode || 'person_confirmed',
        a.outcome || 'ok', a.confirmation_ref || null, JSON.stringify(a.parameters || {}),
      ]
    );
    return res.rows[0] || null;
  } catch (err) {
    console.error('[actions] could not record action:', err.message);
    return null;
  }
}

// A device reports an action the person took on an artifact.
async function recordClientAction(pool, tables, threadId, accessKeyId, { action_type, artifact_id }) {
  const spec = CLIENT_ACTIONS[action_type];
  if (!spec) return { error: 'unknown action type', status: 400 };

  const found = await pool.query(
    `SELECT a.* FROM ${tables.artifacts} a JOIN ${tables.threads} t ON t.id = a.thread_id
     WHERE a.id = $1 AND a.thread_id = $2 AND t.access_key_id = $3`,
    [artifact_id, threadId, accessKeyId]
  );
  const artifact = found.rows[0];
  if (!artifact) return { error: 'not found', status: 404 };
  if (spec.kinds && !spec.kinds.includes(artifact.kind)) {
    return { error: `${action_type} does not apply to a ${artifact.kind}`, status: 400 };
  }

  const content = artifact.content_json || {};
  const built = spec.build(content, artifact);
  const row = await recordAction(pool, tables, threadId, {
    artifact_id: artifact.id, action_type, outcome: spec.outcome,
    executed_by: 'person', confirmation_mode: 'person_executed', ...built,
  });
  return row ? { row } : { error: 'could not record', status: 500 };
}

async function listActions(pool, tables, threadId, limit) {
  const res = await pool.query(
    `SELECT id, artifact_id, action_type, description, executed_by, confirmation_mode, outcome, confirmation_ref, executed_at
     FROM ${tables.actions} WHERE thread_id = $1 ORDER BY id DESC LIMIT ${Math.min(+limit || LIST_LIMIT, 200)}`,
    [threadId]
  );
  return res.rows;
}

// A short block for the model, so it knows what has already gone out and does not re-draft or
// re-send it. The full trail is only a query away; it is not pushed wholesale.
async function actionsContext(pool, tables, threadId) {
  const rows = await listActions(pool, tables, threadId, CONTEXT_LIMIT);
  if (!rows.length) return '';
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  return `\n\nWHAT HAS ALREADY GONE OUT FROM THIS SITUATION (most recent first; a record of fact — do not offer to send these again unless asked):\n` +
    rows.map(r => `- ${day(r.executed_at)} · ${r.description} [${r.outcome}]`).join('\n');
}

module.exports = { recordAction, recordClientAction, listActions, actionsContext, CLIENT_ACTIONS };
