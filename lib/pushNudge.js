const cron = require('node-cron');
const { pool } = require('../db');

const QUIET_HOURS = 24;       // a live thread untouched this long is "quiet"
const RENUDGE_HOURS = 48;     // don't nudge again sooner than this

async function sendExpoPush(token, body) {
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: token,
        body,
        sound: 'default',
      }),
    });
  } catch (err) {
    console.error('[push] send error:', err);
  }
}

async function runPresenceNudgeSweep() {
  const result = await pool.query(`
    SELECT t.id AS thread_id, t.access_key_id,
           h.text AS held_text
    FROM threads t
    JOIN held_items h ON h.thread_id = t.id AND h.glyph = 'live'
    WHERE t.status = 'live'
      AND t.updated_at < now() - interval '${QUIET_HOURS} hours'
      AND (t.last_nudged_at IS NULL OR t.last_nudged_at < now() - interval '${RENUDGE_HOURS} hours')
    ORDER BY h.updated_at DESC
  `);

  const byThread = new Map();
  for (const row of result.rows) {
    if (!byThread.has(row.thread_id)) byThread.set(row.thread_id, row);
  }

  for (const [threadId, row] of byThread) {
    const tokens = await pool.query(
      `SELECT expo_push_token FROM push_tokens WHERE access_key_id = $1`,
      [row.access_key_id]
    );
    if (!tokens.rows.length) continue;

    const heldText = (row.held_text || 'something').toLowerCase();
    const body = `You left ${heldText} with me. I've been holding it. When you're ready, I have a next move — no rush.`;

    for (const { expo_push_token } of tokens.rows) {
      await sendExpoPush(expo_push_token, body);
    }
    await pool.query(`UPDATE threads SET last_nudged_at = now() WHERE id = $1`, [threadId]);
  }
}

// A held item with a real due_at shouldn't wait on the generic 24h-quiet threshold above —
// if an eviction response is due tomorrow, that's worth surfacing even if the person was
// active in the app three hours ago. Tracked per-item (held_items.nudged_at), independent
// of threads.last_nudged_at, so a real deadline is never throttled by an unrelated cooldown.
const DEADLINE_LOOKAHEAD_HOURS = 48; // nudge once a deadline is this close, or already past
const DEADLINE_RENUDGE_HOURS = 24;   // don't nudge again about the same item sooner than this

async function runDeadlineNudgeSweep() {
  const result = await pool.query(`
    SELECT h.id AS held_id, h.text AS held_text, h.due_at, h.blocked_on, t.access_key_id
    FROM held_items h
    JOIN threads t ON t.id = h.thread_id
    WHERE h.glyph = 'live'
      AND t.status = 'live'
      AND h.due_at IS NOT NULL
      AND h.due_at < now() + interval '${DEADLINE_LOOKAHEAD_HOURS} hours'
      AND (h.nudged_at IS NULL OR h.nudged_at < now() - interval '${DEADLINE_RENUDGE_HOURS} hours')
  `);

  for (const row of result.rows) {
    const tokens = await pool.query(
      `SELECT expo_push_token FROM push_tokens WHERE access_key_id = $1`,
      [row.access_key_id]
    );
    if (!tokens.rows.length) continue;

    const dueAt = new Date(row.due_at);
    const overdue = dueAt.getTime() < Date.now();
    const days = Math.abs(Math.round((Date.now() - dueAt.getTime()) / 86400000));
    const heldText = (row.held_text || 'something').toLowerCase();
    const when = overdue
      ? (days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`)
      : (days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`);
    const body = overdue
      ? `${heldText} — was due ${when}. Still holding it. Come back when you can.`
      : `${heldText} — due ${when}${row.blocked_on ? `. Still waiting on ${row.blocked_on}` : ''}.`;

    for (const { expo_push_token } of tokens.rows) {
      await sendExpoPush(expo_push_token, body);
    }
    await pool.query(`UPDATE held_items SET nudged_at = now() WHERE id = $1`, [row.held_id]);
  }
}

function startPresenceNudges() {
  // Every 30 minutes; the queries above gate actual sends by the quiet/renudge thresholds.
  cron.schedule('*/30 * * * *', () => {
    runPresenceNudgeSweep().catch(err => console.error('[push] presence sweep error:', err));
    runDeadlineNudgeSweep().catch(err => console.error('[push] deadline sweep error:', err));
  });
  console.log('[push] presence-nudge and deadline-nudge sweeps scheduled');
}

module.exports = { startPresenceNudges, runPresenceNudgeSweep, runDeadlineNudgeSweep };
