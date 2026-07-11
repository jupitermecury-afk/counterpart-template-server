const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { streamCounterpartReply } = require('../lib/claude');

const router = express.Router();
const MODEL = 'claude-sonnet-4-6';

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateKey() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  const bytes = crypto.randomBytes(16);
  let raw = '';
  for (let i = 0; i < bytes.length; i++) raw += alphabet[bytes[i] % alphabet.length];
  return raw.match(/.{1,4}/g).join('-'); // e.g. WXTF-93KQ-PLM2-7ZRN
}

// Wrap every async route/middleware so a thrown/rejected error becomes next(err) —
// a JSON 500 from the error handler in server.js — instead of an unhandled rejection
// that crashes the whole process (which would also take down /counterpart and /).
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// Same defense-in-depth as the existing /counterpart route, tuned for the mobile app's
// own per-key auth (real DB validation, not a shared secret) rather than CLIENT_SECRET.
const apiLimiter = rateLimit({
  windowMs: (Number(process.env.RATE_LIMIT_WINDOW_MIN) || 15) * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many requests — please wait a few minutes and try again.' } },
});
router.use(apiLimiter);

// Without a configured database, every route below would throw on its first pool.query
// (pg defaults to localhost:5432). Fail soft with a clear 503 instead of letting that happen.
router.use((req, res, next) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'mobile app database not configured yet' });
  }
  next();
});

// ── Admin: issue keys ───────────────────────────────────────────────────────
router.post('/admin/keys', asyncRoute(async (req, res) => {
  if (!process.env.ADMIN_SECRET || req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { valid_days } = req.body || {};
  const key = generateKey();
  const validUntil = valid_days ? new Date(Date.now() + valid_days * 86400000) : null;
  const result = await pool.query(
    `INSERT INTO access_keys (key_hash, valid_until) VALUES ($1, $2) RETURNING id, valid_until`,
    [hashKey(key), validUntil]
  );
  res.json({ key, id: result.rows[0].id, valid_until: result.rows[0].valid_until });
}));

// ── Door: verify a key ───────────────────────────────────────────────────────
router.post('/auth/verify', asyncRoute(async (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ ok: false });
  const result = await pool.query(
    `SELECT id, valid_from, valid_until, revoked_at FROM access_keys WHERE key_hash = $1`,
    [hashKey(key)]
  );
  const row = result.rows[0];
  const now = new Date();
  const valid = row && !row.revoked_at
    && new Date(row.valid_from) <= now
    && (!row.valid_until || new Date(row.valid_until) > now);
  if (!valid) return res.status(401).json({ ok: false });
  res.json({ ok: true });
}));

// ── Auth middleware for everything below ─────────────────────────────────────
router.use(asyncRoute(async (req, res, next) => {
  const key = req.headers['x-counterpart-key'];
  if (!key) return res.status(401).json({ error: 'missing key' });
  const result = await pool.query(
    `SELECT id, valid_from, valid_until, revoked_at FROM access_keys WHERE key_hash = $1`,
    [hashKey(key)]
  );
  const row = result.rows[0];
  const now = new Date();
  const valid = row && !row.revoked_at
    && new Date(row.valid_from) <= now
    && (!row.valid_until || new Date(row.valid_until) > now);
  if (!valid) return res.status(401).json({ error: 'invalid or expired key' });
  req.accessKeyId = row.id;
  next();
}));

// ── Thread state assembly ────────────────────────────────────────────────────
async function loadThreadState(threadId) {
  const [thread, turns, held, verif, artifacts] = await Promise.all([
    pool.query(`SELECT * FROM threads WHERE id = $1`, [threadId]),
    pool.query(`SELECT * FROM turns WHERE thread_id = $1 ORDER BY id ASC`, [threadId]),
    pool.query(`SELECT * FROM held_items WHERE thread_id = $1 ORDER BY id ASC`, [threadId]),
    pool.query(`SELECT * FROM verification_items WHERE thread_id = $1 ORDER BY id ASC`, [threadId]),
    pool.query(`SELECT * FROM artifacts WHERE thread_id = $1 ORDER BY id ASC`, [threadId]),
  ]);
  return {
    thread: thread.rows[0] || null,
    turns: turns.rows,
    held: held.rows,
    verification: verif.rows,
    artifacts: artifacts.rows,
  };
}

async function assertOwnedThread(threadId, accessKeyId) {
  const result = await pool.query(
    `SELECT id FROM threads WHERE id = $1 AND access_key_id = $2`,
    [threadId, accessKeyId]
  );
  return !!result.rows[0];
}

// ── Resume: the most recent open thread (Continuity) ────────────────────────
router.get('/threads/active', asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id FROM threads WHERE access_key_id = $1 AND status = 'live' ORDER BY updated_at DESC LIMIT 1`,
    [req.accessKeyId]
  );
  if (!result.rows[0]) return res.json({ thread: null, turns: [], held: [], verification: [], artifacts: [] });
  res.json(await loadThreadState(result.rows[0].id));
}));

// ── All threads (for browsing/switching between situations) ─────────────────
router.get('/threads', asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT t.id, t.status, t.created_at, t.updated_at,
            (SELECT content FROM turns WHERE thread_id = t.id ORDER BY id ASC LIMIT 1) AS preview
     FROM threads t WHERE t.access_key_id = $1 ORDER BY t.updated_at DESC`,
    [req.accessKeyId]
  );
  res.json({ threads: result.rows });
}));

// ── Start a new problem thread ───────────────────────────────────────────────
router.post('/threads', asyncRoute(async (req, res) => {
  const result = await pool.query(
    `INSERT INTO threads (access_key_id) VALUES ($1) RETURNING *`,
    [req.accessKeyId]
  );
  res.json({ thread: result.rows[0] });
}));

// ── Reopen / resume a specific thread whole ──────────────────────────────────
router.get('/threads/:id', asyncRoute(async (req, res) => {
  const threadId = +req.params.id;
  if (!(await assertOwnedThread(threadId, req.accessKeyId))) return res.status(404).json({ error: 'not found' });
  res.json(await loadThreadState(threadId));
}));

router.post('/threads/:id/reopen', asyncRoute(async (req, res) => {
  const threadId = +req.params.id;
  if (!(await assertOwnedThread(threadId, req.accessKeyId))) return res.status(404).json({ error: 'not found' });
  await pool.query(`UPDATE threads SET status = 'live', updated_at = now() WHERE id = $1`, [threadId]);
  await pool.query(
    `UPDATE held_items SET glyph = 'live', meta = 'reopened — held again', updated_at = now() WHERE thread_id = $1`,
    [threadId]
  );
  res.json(await loadThreadState(threadId));
}));

// ── The three-path close ─────────────────────────────────────────────────────
router.post('/threads/:id/close', asyncRoute(async (req, res) => {
  const threadId = +req.params.id;
  if (!(await assertOwnedThread(threadId, req.accessKeyId))) return res.status(404).json({ error: 'not found' });
  const { path } = req.body || {}; // 'solved' | 'rest' | 'short'
  const statusMap = { solved: 'done', rest: 'rest', short: 'unresolved' };
  const status = statusMap[path];
  if (!status) return res.status(400).json({ error: 'invalid path' });
  await pool.query(`UPDATE threads SET status = $1, updated_at = now() WHERE id = $2`, [status, threadId]);
  await pool.query(`UPDATE held_items SET glyph = $1, updated_at = now() WHERE thread_id = $2`, [status, threadId]);
  res.json(await loadThreadState(threadId));
}));

// ── Verification holds (the 3 taps on a chip) ────────────────────────────────
router.post('/verification/:id', asyncRoute(async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['person_confirming', 'counterpart_checking', 'proceeding_unconfirmed', 'confirmed'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'invalid status' });
  const result = await pool.query(
    `UPDATE verification_items vi SET status = $1, updated_at = now()
     FROM threads t WHERE vi.thread_id = t.id AND vi.id = $2 AND t.access_key_id = $3
     RETURNING vi.*`,
    [status, +req.params.id, req.accessKeyId]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json({ item: result.rows[0] });
}));

// ── Push token registration ──────────────────────────────────────────────────
router.post('/push/register', asyncRoute(async (req, res) => {
  const { expo_push_token } = req.body || {};
  if (!expo_push_token) return res.status(400).json({ error: 'missing token' });
  await pool.query(
    `INSERT INTO push_tokens (access_key_id, expo_push_token) VALUES ($1, $2)
     ON CONFLICT (access_key_id, expo_push_token) DO NOTHING`,
    [req.accessKeyId, expo_push_token]
  );
  res.json({ ok: true });
}));

// ── The live conversation (SSE) ──────────────────────────────────────────────
router.post('/threads/:id/messages', asyncRoute(async (req, res) => {
  const threadId = +req.params.id;
  if (!(await assertOwnedThread(threadId, req.accessKeyId))) return res.status(404).json({ error: 'not found' });

  const { text, attachments, attachment_label } = req.body || {};
  if (!text && !(attachments && attachments.length)) {
    return res.status(400).json({ error: 'empty message' });
  }

  // Persist the person's turn.
  await pool.query(
    `INSERT INTO turns (thread_id, role, content, attachment_label) VALUES ($1, 'person', $2, $3)`,
    [threadId, text || '', attachment_label || null]
  );

  // Build the full message history for Claude. Past turns replay as plain text;
  // only the NEW message carries real attachment content blocks (keeps token cost bounded
  // and matches the spec: the model engages with what's brought now, not a re-upload every turn).
  const priorTurns = await pool.query(
    `SELECT role, content, attachment_label FROM turns WHERE thread_id = $1 ORDER BY id ASC`,
    [threadId]
  );
  const messages = [];
  for (const t of priorTurns.rows) {
    const role = t.role === 'person' ? 'user' : 'assistant';
    const label = t.attachment_label ? `[${t.attachment_label}] ` : '';
    messages.push({ role, content: `${label}${t.content}` });
  }
  // Replace the content of the last (just-inserted) user message with real content blocks if there are attachments.
  if (attachments && attachments.length) {
    const blocks = attachments.map(a => {
      if (a.type === 'image') {
        return { type: 'image', source: { type: 'base64', media_type: a.media_type, data: a.data_base64 } };
      }
      return { type: 'document', source: { type: 'base64', media_type: a.media_type, data: a.data_base64 } };
    });
    if (text) blocks.push({ type: 'text', text });
    messages[messages.length - 1] = { role: 'user', content: blocks };
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const { fullText, toolCalls } = await streamCounterpartReply({
      model: MODEL,
      messages,
      onText: (delta) => send({ type: 'text', delta }),
      onTool: (call) => send({ type: 'tool', name: call.name, input: call.input }),
    });

    await pool.query(
      `INSERT INTO turns (thread_id, role, content) VALUES ($1, 'counterpart', $2)`,
      [threadId, fullText]
    );

    for (const call of toolCalls) {
      if (call.name === 'surface_artifact') {
        await pool.query(
          `INSERT INTO artifacts (thread_id, title, kind, fidelity, content_json) VALUES ($1,$2,$3,$4,$5)`,
          [threadId, call.input.title, call.input.kind, call.input.fidelity, JSON.stringify(call.input)]
        );
      } else if (call.name === 'flag_verification') {
        await pool.query(
          `INSERT INTO verification_items (thread_id, claim_text) VALUES ($1, $2)`,
          [threadId, call.input.claim_text]
        );
      } else if (call.name === 'update_held_thread') {
        const existing = await pool.query(
          `SELECT id FROM held_items WHERE thread_id = $1 AND text = $2`,
          [threadId, call.input.text]
        );
        if (existing.rows[0]) {
          await pool.query(
            `UPDATE held_items SET glyph = $1, meta = $2, updated_at = now() WHERE id = $3`,
            [call.input.glyph, call.input.meta || null, existing.rows[0].id]
          );
        } else {
          await pool.query(
            `INSERT INTO held_items (thread_id, text, glyph, meta) VALUES ($1,$2,$3,$4)`,
            [threadId, call.input.text, call.input.glyph, call.input.meta || null]
          );
        }
      } else if (call.name === 'prepare_email_draft' || call.name === 'prepare_calendar_event') {
        await pool.query(
          `INSERT INTO artifacts (thread_id, title, kind, fidelity, content_json) VALUES ($1,$2,$3,'full',$4)`,
          [threadId, call.input.subject || call.input.title, call.name, JSON.stringify(call.input)]
        );
      }
    }

    await pool.query(`UPDATE threads SET updated_at = now() WHERE id = $1`, [threadId]);

    send({ type: 'done' });
    res.end();
  } catch (err) {
    console.error('[api] stream error:', err);
    send({ type: 'error', message: err.message });
    res.end();
  }
}));

module.exports = router;
