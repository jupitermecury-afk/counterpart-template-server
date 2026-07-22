// The web app's own backend — deliberately separate from routes/api.js (the mobile
// app's): own auth, own tables (web_*), own everything except lib/claude.js, which is
// the one intentionally shared piece (pure system-prompt + tool-loop logic, no state).
// Small helpers below (hashKey, generateKey, asyncRoute, the rate limiter, the
// DATABASE_URL guard) are duplicated from routes/api.js rather than imported — a bug
// in one file's auth/routing can never take down the other's.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { streamCounterpartReply } = require('../lib/claude');

const router = express.Router();
const MODEL = 'claude-sonnet-4-6';
const DEPTH_TOKENS = { brief: 800, standard: 1800, deep: 3600 };

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateKey() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  const bytes = crypto.randomBytes(16);
  let raw = '';
  for (let i = 0; i < bytes.length; i++) raw += alphabet[bytes[i] % alphabet.length];
  return raw.match(/.{1,4}/g).join('-');
}

// Preserves today's friendly "ESSENCE-A1B2C3"-style issued-key naming (operator.html's
// genSeatKey()/partner.html's genKey()) instead of switching to the generic dash-grouped
// format above, which would be a small but visible regression for existing operators.
function randomSuffix(len) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
function seatTagFrom(issuerPlaintext) {
  return (issuerPlaintext.split('-')[0] || 'SEAT').toUpperCase().slice(0, 10);
}
function generateSeatKey(issuerPlaintext) {
  return `${seatTagFrom(issuerPlaintext)}-${randomSuffix(6)}`;
}
function cohortTagFrom(name) {
  return (name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)) || 'COHORT';
}
function generateCohortKey(issuerPlaintext, cohortName) {
  const orgTag = (issuerPlaintext.split('-')[0] || 'PTNR').toUpperCase().slice(0, 6);
  return `${orgTag}-${cohortTagFrom(cohortName)}-${randomSuffix(4)}`;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

const apiLimiter = rateLimit({
  windowMs: (Number(process.env.RATE_LIMIT_WINDOW_MIN) || 15) * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many requests — please wait a few minutes and try again.' } },
});
router.use(apiLimiter);

router.use((req, res, next) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'web app database not configured yet' });
  }
  next();
});

// ── Migration + seeding, exported for server.js to call at boot, independent of the ──
// ── mobile app's migrate() — a failure here must never block mobile's boot or vice versa.
async function migrateWeb() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '002_web_init.sql'), 'utf8');
  await pool.query(sql);
  console.log('[db] web migration applied');
}

async function seedDemoKeys() {
  const DEMO_KEYS = [
    { key: 'ESSENCE-2026', validFrom: '2026-06-01', validTo: '2027-06-01' },
    { key: 'BAAFOUR-2026', validFrom: '2026-06-01', validTo: '2027-06-01' },
    { key: 'BENJI-2026', validFrom: '2026-06-01', validTo: '2027-06-01' },
    { key: 'EINSTJII-2026', validFrom: '2026-06-01', validTo: '2027-06-01' },
  ];
  for (const d of DEMO_KEYS) {
    await pool.query(
      `INSERT INTO web_access_keys (key_hash, label, valid_from, valid_until)
       VALUES ($1, $2, $3, $4) ON CONFLICT (key_hash) DO NOTHING`,
      [hashKey(d.key), d.key, d.validFrom, d.validTo]
    );
  }
  console.log('[db] web demo keys seeded');
}

// ── Auth ──────────────────────────────────────────────────────────────────────
router.post('/auth/verify', asyncRoute(async (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ ok: false });
  const result = await pool.query(
    `SELECT id, valid_from, valid_until, revoked_at FROM web_access_keys WHERE key_hash = $1`,
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

router.use(asyncRoute(async (req, res, next) => {
  const key = req.headers['x-counterpart-key'];
  if (!key) return res.status(401).json({ error: 'missing key' });
  const result = await pool.query(
    `SELECT id, valid_from, valid_until, revoked_at FROM web_access_keys WHERE key_hash = $1`,
    [hashKey(key)]
  );
  const row = result.rows[0];
  const now = new Date();
  const valid = row && !row.revoked_at
    && new Date(row.valid_from) <= now
    && (!row.valid_until || new Date(row.valid_until) > now);
  if (!valid) return res.status(401).json({ error: 'invalid or expired key' });
  req.accessKeyId = row.id;
  req.accessKeyPlaintext = key;
  next();
}));

// ── Thread state assembly ────────────────────────────────────────────────────
async function loadThreadState(threadId) {
  const [thread, turns, held, verif, artifacts] = await Promise.all([
    pool.query(`SELECT * FROM web_threads WHERE id = $1`, [threadId]),
    pool.query(`SELECT * FROM web_turns WHERE thread_id = $1 ORDER BY id ASC`, [threadId]),
    pool.query(`SELECT * FROM web_held_items WHERE thread_id = $1 ORDER BY id ASC`, [threadId]),
    pool.query(`SELECT * FROM web_verification_items WHERE thread_id = $1 ORDER BY id ASC`, [threadId]),
    pool.query(`SELECT * FROM web_artifacts WHERE thread_id = $1 ORDER BY id ASC`, [threadId]),
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
    `SELECT id FROM web_threads WHERE id = $1 AND access_key_id = $2`,
    [threadId, accessKeyId]
  );
  return !!result.rows[0];
}

// Standing context that reaches the model as instruction-level context, not
// conversation content: the org context from whichever key ISSUED this one (if any),
// plus this specific situation's own context box.
async function buildExtraContext(accessKeyId, threadContext) {
  const result = await pool.query(
    `SELECT issuer.org_context AS org_context
     FROM web_access_keys me
     LEFT JOIN web_access_keys issuer ON issuer.id = me.issuer_key_id
     WHERE me.id = $1`,
    [accessKeyId]
  );
  const orgContext = result.rows[0]?.org_context || '';
  let extra = '';
  if (orgContext) extra += `\n\nSTANDING CONTEXT FROM THE ORGANISATION (applies to everyone on this team):\n${orgContext}`;
  if (threadContext) extra += `\n\nSTANDING CONTEXT FROM THE PERSON (applies to this whole situation):\n${threadContext}`;
  return extra;
}

// ── Threads (situations) ─────────────────────────────────────────────────────
router.get('/threads/active', asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id FROM web_threads WHERE access_key_id = $1 AND status = 'live' ORDER BY updated_at DESC LIMIT 1`,
    [req.accessKeyId]
  );
  if (!result.rows[0]) return res.json({ thread: null, turns: [], held: [], verification: [], artifacts: [] });
  res.json(await loadThreadState(result.rows[0].id));
}));

router.get('/threads', asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT t.id, t.title, t.pinned, t.status, t.created_at, t.updated_at,
            (SELECT content FROM web_turns WHERE thread_id = t.id ORDER BY id ASC LIMIT 1) AS preview
     FROM web_threads t WHERE t.access_key_id = $1 ORDER BY t.pinned DESC, t.updated_at DESC`,
    [req.accessKeyId]
  );
  res.json({ threads: result.rows });
}));

router.post('/threads', asyncRoute(async (req, res) => {
  const result = await pool.query(
    `INSERT INTO web_threads (access_key_id) VALUES ($1) RETURNING *`,
    [req.accessKeyId]
  );
  res.json({ thread: result.rows[0] });
}));

router.get('/threads/:id', asyncRoute(async (req, res) => {
  const threadId = +req.params.id;
  if (!(await assertOwnedThread(threadId, req.accessKeyId))) return res.status(404).json({ error: 'not found' });
  res.json(await loadThreadState(threadId));
}));

router.patch('/threads/:id', asyncRoute(async (req, res) => {
  const threadId = +req.params.id;
  if (!(await assertOwnedThread(threadId, req.accessKeyId))) return res.status(404).json({ error: 'not found' });
  const { title, pinned, context } = req.body || {};
  const fields = [], values = [];
  let i = 1;
  if (title !== undefined) { fields.push(`title = $${i++}`); values.push(title); }
  if (pinned !== undefined) { fields.push(`pinned = $${i++}`); values.push(!!pinned); }
  if (context !== undefined) { fields.push(`context = $${i++}`); values.push(context); }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
  values.push(threadId);
  const result = await pool.query(
    `UPDATE web_threads SET ${fields.join(', ')}, updated_at = now() WHERE id = $${i} RETURNING *`,
    values
  );
  res.json({ thread: result.rows[0] });
}));

router.post('/threads/:id/reopen', asyncRoute(async (req, res) => {
  const threadId = +req.params.id;
  if (!(await assertOwnedThread(threadId, req.accessKeyId))) return res.status(404).json({ error: 'not found' });
  await pool.query(`UPDATE web_threads SET status = 'live', updated_at = now() WHERE id = $1`, [threadId]);
  await pool.query(
    `UPDATE web_held_items SET glyph = 'live', meta = 'reopened — held again', updated_at = now() WHERE thread_id = $1`,
    [threadId]
  );
  res.json(await loadThreadState(threadId));
}));

router.post('/threads/:id/close', asyncRoute(async (req, res) => {
  const threadId = +req.params.id;
  if (!(await assertOwnedThread(threadId, req.accessKeyId))) return res.status(404).json({ error: 'not found' });
  const { path: closePath } = req.body || {};
  const statusMap = { solved: 'done', rest: 'rest', short: 'unresolved' };
  const status = statusMap[closePath];
  if (!status) return res.status(400).json({ error: 'invalid path' });
  await pool.query(`UPDATE web_threads SET status = $1, updated_at = now() WHERE id = $2`, [status, threadId]);
  await pool.query(`UPDATE web_held_items SET glyph = $1, updated_at = now() WHERE thread_id = $2`, [status, threadId]);
  res.json(await loadThreadState(threadId));
}));

router.delete('/threads/:id', asyncRoute(async (req, res) => {
  const threadId = +req.params.id;
  if (!(await assertOwnedThread(threadId, req.accessKeyId))) return res.status(404).json({ error: 'not found' });
  await pool.query(`DELETE FROM web_threads WHERE id = $1`, [threadId]);
  res.json({ ok: true });
}));

// ── The live conversation (SSE) ──────────────────────────────────────────────
router.post('/threads/:id/messages', asyncRoute(async (req, res) => {
  const threadId = +req.params.id;
  if (!(await assertOwnedThread(threadId, req.accessKeyId))) return res.status(404).json({ error: 'not found' });

  const { text, depth, attachments, attachment_label } = req.body || {};
  if (!text && !(attachments && attachments.length)) {
    return res.status(400).json({ error: 'empty message' });
  }

  await pool.query(
    `INSERT INTO web_turns (thread_id, role, content, attachment_label) VALUES ($1, 'person', $2, $3)`,
    [threadId, text || '', attachment_label || null]
  );

  const [priorTurns, threadRow] = await Promise.all([
    pool.query(`SELECT role, content, attachment_label FROM web_turns WHERE thread_id = $1 ORDER BY id ASC`, [threadId]),
    pool.query(`SELECT context FROM web_threads WHERE id = $1`, [threadId]),
  ]);

  const messages = [];
  for (const t of priorTurns.rows) {
    const role = t.role === 'person' ? 'user' : 'assistant';
    const label = t.attachment_label ? `[${t.attachment_label}] ` : '';
    messages.push({ role, content: `${label}${t.content}` });
  }
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

  const extraSystemContext = await buildExtraContext(req.accessKeyId, threadRow.rows[0]?.context || '');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const { fullText, toolCalls } = await streamCounterpartReply({
      model: MODEL,
      maxTokens: DEPTH_TOKENS[depth] || DEPTH_TOKENS.standard,
      messages,
      extraSystemContext,
      onText: (delta) => send({ type: 'text', delta }),
      onTool: (call) => send({ type: 'tool', name: call.name, input: call.input }),
    });

    await pool.query(
      `INSERT INTO web_turns (thread_id, role, content) VALUES ($1, 'counterpart', $2)`,
      [threadId, fullText]
    );

    for (const call of toolCalls) {
      if (call.name === 'surface_artifact') {
        await pool.query(
          `INSERT INTO web_artifacts (thread_id, title, kind, fidelity, content_json, source) VALUES ($1,$2,$3,$4,$5,'model')`,
          [threadId, call.input.title, call.input.kind, call.input.fidelity, JSON.stringify(call.input)]
        );
      } else if (call.name === 'flag_verification') {
        await pool.query(
          `INSERT INTO web_verification_items (thread_id, claim_text) VALUES ($1, $2)`,
          [threadId, call.input.claim_text]
        );
      } else if (call.name === 'update_held_thread') {
        const existing = await pool.query(
          `SELECT id FROM web_held_items WHERE thread_id = $1 AND text = $2 AND source = 'model'`,
          [threadId, call.input.text]
        );
        if (existing.rows[0]) {
          await pool.query(
            `UPDATE web_held_items SET glyph = $1, meta = $2, updated_at = now() WHERE id = $3`,
            [call.input.glyph, call.input.meta || null, existing.rows[0].id]
          );
        } else {
          await pool.query(
            `INSERT INTO web_held_items (thread_id, text, glyph, meta, source) VALUES ($1,$2,$3,$4,'model')`,
            [threadId, call.input.text, call.input.glyph, call.input.meta || null]
          );
        }
      } else if (call.name === 'prepare_email_draft' || call.name === 'prepare_calendar_event') {
        await pool.query(
          `INSERT INTO web_artifacts (thread_id, title, kind, fidelity, content_json, source) VALUES ($1,$2,$3,'full',$4,'model')`,
          [threadId, call.input.subject || call.input.title, call.name, JSON.stringify(call.input)]
        );
      }
    }

    await pool.query(`UPDATE web_threads SET updated_at = now() WHERE id = $1`, [threadId]);

    send({ type: 'done' });
    res.end();
  } catch (err) {
    console.error('[webapi] stream error:', err);
    send({ type: 'error', message: err.message });
    res.end();
  }
}));

// ── Quick summary (lightweight, non-tool, non-persisted utility — not a full ──
// ── counterpart turn, so it deliberately doesn't go through streamCounterpartReply).
router.post('/threads/:id/summarise', asyncRoute(async (req, res) => {
  const threadId = +req.params.id;
  if (!(await assertOwnedThread(threadId, req.accessKeyId))) return res.status(404).json({ error: 'not found' });
  const turns = await pool.query(`SELECT role, content FROM web_turns WHERE thread_id = $1 ORDER BY id ASC`, [threadId]);
  if (!turns.rows.length) return res.json({ summary: 'Nothing to summarise yet.' });
  const convo = turns.rows.map(t => `${t.role}: ${t.content}`).join('\n');
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: 'You summarise conversations in plain language.',
        messages: [{ role: 'user', content: `In three to five sentences, summarise this: what the person is dealing with, what has been decided or drafted, and what the next action is. Be concrete and plain.\n\n${convo}` }],
      }),
    });
    const d = await r.json();
    const summary = d.content?.filter(b => b.type === 'text').map(b => b.text).join('') || 'Could not generate summary.';
    res.json({ summary });
  } catch (err) {
    console.error('[webapi] summarise error:', err);
    res.status(502).json({ error: 'could not generate summary' });
  }
}));

// ── Verification holds ───────────────────────────────────────────────────────
router.post('/verification/:id', asyncRoute(async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['person_confirming', 'counterpart_checking', 'proceeding_unconfirmed', 'confirmed'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'invalid status' });
  const result = await pool.query(
    `UPDATE web_verification_items vi SET status = $1, updated_at = now()
     FROM web_threads t WHERE vi.thread_id = t.id AND vi.id = $2 AND t.access_key_id = $3
     RETURNING vi.*`,
    [status, +req.params.id, req.accessKeyId]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json({ item: result.rows[0] });
}));

// ── Person-authored documents ────────────────────────────────────────────────
router.post('/threads/:id/artifacts', asyncRoute(async (req, res) => {
  const threadId = +req.params.id;
  if (!(await assertOwnedThread(threadId, req.accessKeyId))) return res.status(404).json({ error: 'not found' });
  const { title, body_markdown } = req.body || {};
  if (!body_markdown) return res.status(400).json({ error: 'missing body' });
  const result = await pool.query(
    `INSERT INTO web_artifacts (thread_id, title, kind, fidelity, content_json, source)
     VALUES ($1,$2,'document','full',$3,'person') RETURNING *`,
    [threadId, title || 'Untitled document', JSON.stringify({ body_markdown })]
  );
  res.json({ artifact: result.rows[0] });
}));

router.patch('/artifacts/:id', asyncRoute(async (req, res) => {
  const { title, body_markdown } = req.body || {};
  const existing = await pool.query(
    `SELECT a.* FROM web_artifacts a JOIN web_threads t ON t.id = a.thread_id
     WHERE a.id = $1 AND t.access_key_id = $2 AND a.source = 'person'`,
    [+req.params.id, req.accessKeyId]
  );
  if (!existing.rows[0]) return res.status(404).json({ error: 'not found' });
  const content = { ...existing.rows[0].content_json, ...(body_markdown !== undefined ? { body_markdown } : {}) };
  const result = await pool.query(
    `UPDATE web_artifacts SET title = COALESCE($1, title), content_json = $2, updated_at = now() WHERE id = $3 RETURNING *`,
    [title, JSON.stringify(content), +req.params.id]
  );
  res.json({ artifact: result.rows[0] });
}));

router.delete('/artifacts/:id', asyncRoute(async (req, res) => {
  const result = await pool.query(
    `DELETE FROM web_artifacts a USING web_threads t
     WHERE a.id = $1 AND t.id = a.thread_id AND t.access_key_id = $2 AND a.source = 'person'
     RETURNING a.id`,
    [+req.params.id, req.accessKeyId]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));

// ── Person-authored steps ────────────────────────────────────────────────────
router.post('/threads/:id/held', asyncRoute(async (req, res) => {
  const threadId = +req.params.id;
  if (!(await assertOwnedThread(threadId, req.accessKeyId))) return res.status(404).json({ error: 'not found' });
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'missing text' });
  const result = await pool.query(
    `INSERT INTO web_held_items (thread_id, text, glyph, source) VALUES ($1,$2,'live','person') RETURNING *`,
    [threadId, text]
  );
  res.json({ item: result.rows[0] });
}));

router.patch('/held/:id', asyncRoute(async (req, res) => {
  const { glyph } = req.body || {};
  const result = await pool.query(
    `UPDATE web_held_items h SET glyph = COALESCE($1, glyph), updated_at = now()
     FROM web_threads t WHERE h.thread_id = t.id AND h.id = $2 AND t.access_key_id = $3 AND h.source = 'person'
     RETURNING h.*`,
    [glyph, +req.params.id, req.accessKeyId]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json({ item: result.rows[0] });
}));

router.delete('/held/:id', asyncRoute(async (req, res) => {
  const result = await pool.query(
    `DELETE FROM web_held_items h USING web_threads t
     WHERE h.id = $1 AND t.id = h.thread_id AND t.access_key_id = $2 AND h.source = 'person'
     RETURNING h.id`,
    [+req.params.id, req.accessKeyId]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));

// ── Key issuance (self-service — authenticated by the caller's own valid key) ──
router.post('/keys', asyncRoute(async (req, res) => {
  const { label, valid_days } = req.body || {};
  if (!label) return res.status(400).json({ error: 'missing label' });
  const validUntil = valid_days ? new Date(Date.now() + valid_days * 86400000) : null;
  let key, attempts = 0;
  let inserted = null;
  while (!inserted && attempts < 5) {
    key = generateSeatKey(req.accessKeyPlaintext);
    try {
      const result = await pool.query(
        `INSERT INTO web_access_keys (key_hash, issuer_key_id, label, valid_until) VALUES ($1,$2,$3,$4) RETURNING *`,
        [hashKey(key), req.accessKeyId, label, validUntil]
      );
      inserted = result.rows[0];
    } catch (e) {
      if (e.code !== '23505') throw e; // unique_violation on key_hash — retry with a new key
      attempts++;
    }
  }
  if (!inserted) return res.status(500).json({ error: 'could not generate a unique key, try again' });
  res.json({ key, id: inserted.id, valid_until: inserted.valid_until });
}));

router.post('/keys/cohort', asyncRoute(async (req, res) => {
  const { cohort, count, valid_days, lang, voice_first } = req.body || {};
  if (!cohort) return res.status(400).json({ error: 'missing cohort name' });
  const n = Math.max(1, Math.min(500, parseInt(count, 10) || 1));
  const validUntil = valid_days ? new Date(Date.now() + valid_days * 86400000) : null;
  const issued = [];
  for (let i = 0; i < n; i++) {
    let inserted = null, attempts = 0, key;
    while (!inserted && attempts < 5) {
      key = generateCohortKey(req.accessKeyPlaintext, cohort);
      try {
        const result = await pool.query(
          `INSERT INTO web_access_keys (key_hash, issuer_key_id, label, cohort, lang, voice_first, valid_until)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [hashKey(key), req.accessKeyId, `${cohort} #${i + 1}`, cohort, lang || null, !!voice_first, validUntil]
        );
        inserted = result.rows[0];
      } catch (e) {
        if (e.code !== '23505') throw e;
        attempts++;
      }
    }
    if (inserted) issued.push(key);
  }
  res.json({ keys: issued });
}));

router.get('/keys', asyncRoute(async (req, res) => {
  const { cohort } = req.query;
  const params = [req.accessKeyId];
  let sql = `SELECT id, label, cohort, lang, voice_first, valid_from, valid_until, revoked_at, created_at
             FROM web_access_keys WHERE issuer_key_id = $1`;
  if (cohort) { params.push(cohort); sql += ` AND cohort = $2`; }
  sql += ` ORDER BY created_at DESC`;
  const result = await pool.query(sql, params);
  res.json({ keys: result.rows });
}));

router.patch('/keys/:id', asyncRoute(async (req, res) => {
  const { revoked, valid_until } = req.body || {};
  const fields = [], values = [];
  let i = 1;
  if (revoked !== undefined) { fields.push(`revoked_at = ${revoked ? 'now()' : 'NULL'}`); }
  if (valid_until !== undefined) { fields.push(`valid_until = $${i++}`); values.push(valid_until); }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
  values.push(+req.params.id, req.accessKeyId);
  const result = await pool.query(
    `UPDATE web_access_keys SET ${fields.join(', ')} WHERE id = $${i++} AND issuer_key_id = $${i} RETURNING id, label, revoked_at, valid_until`,
    values
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json({ key: result.rows[0] });
}));

router.delete('/keys/:id', asyncRoute(async (req, res) => {
  const result = await pool.query(
    `DELETE FROM web_access_keys WHERE id = $1 AND issuer_key_id = $2 RETURNING id`,
    [+req.params.id, req.accessKeyId]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));

router.delete('/keys/cohort/:name', asyncRoute(async (req, res) => {
  const result = await pool.query(
    `DELETE FROM web_access_keys WHERE issuer_key_id = $1 AND cohort = $2 RETURNING id`,
    [req.accessKeyId, req.params.name]
  );
  res.json({ ok: true, deleted: result.rows.length });
}));

// ── Org settings (self-as-org — the caller's own key row) ───────────────────
router.get('/org', asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT org_name, org_context, org_rate FROM web_access_keys WHERE id = $1`,
    [req.accessKeyId]
  );
  res.json(result.rows[0] || { org_name: null, org_context: null, org_rate: null });
}));

router.patch('/org', asyncRoute(async (req, res) => {
  const { name, context, rate } = req.body || {};
  const fields = [], values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`org_name = $${i++}`); values.push(name); }
  if (context !== undefined) { fields.push(`org_context = $${i++}`); values.push(context); }
  if (rate !== undefined) { fields.push(`org_rate = $${i++}`); values.push(rate); }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
  values.push(req.accessKeyId);
  const result = await pool.query(
    `UPDATE web_access_keys SET ${fields.join(', ')} WHERE id = $${i} RETURNING org_name, org_context, org_rate`,
    values
  );
  res.json(result.rows[0]);
}));

module.exports = router;
module.exports.migrateWeb = migrateWeb;
module.exports.seedDemoKeys = seedDemoKeys;
