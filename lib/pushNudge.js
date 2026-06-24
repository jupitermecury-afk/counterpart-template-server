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

function startPresenceNudges() {
  // Every 30 minutes; the queries above gate actual sends by the quiet/renudge thresholds.
  cron.schedule('*/30 * * * *', () => {
    runPresenceNudgeSweep().catch(err => console.error('[push] sweep error:', err));
  });
  console.log('[push] presence-nudge sweep scheduled');
}

module.exports = { startPresenceNudges, runPresenceNudgeSweep };
