// Return briefing: a deterministic "where things stand" digest for one situation.
// Pure composition is split from the database read so it can be tested without a database,
// and shared by the mobile (/api) and web (/webapi) routes, which keep separate tables.

const DAY_MS = 86400000;
const SOON_HOURS = 72;

function dayCount(ms) { return Math.max(0, Math.round(Math.abs(ms) / DAY_MS)); }

function composeBriefing({ thread, held, verification, decisions, lastReview, now }) {
  const t = (now || new Date()).getTime();
  const last = thread && thread.updated_at ? new Date(thread.updated_at).getTime() : null;
  const daysAway = last ? Math.max(0, Math.floor((t - last) / DAY_MS)) : 0;

  // 'rest' is held at rest on purpose, 'done' is finished — neither is overdue.
  const openSteps = (held || []).filter(h => h.glyph === 'live' || h.glyph === 'unresolved');
  const openVerify = (verification || []).filter(v => v.status !== 'confirmed');

  const overdue = [], dueSoon = [];
  const place = (item) => {
    if (!item.due_at) return;
    const delta = new Date(item.due_at).getTime() - t;
    if (delta < 0) overdue.push({ ...item, days: dayCount(delta) });
    else if (delta <= SOON_HOURS * 3600000) dueSoon.push({ ...item, days: dayCount(delta) });
  };

  const steps = openSteps.map(h => ({
    kind: 'step', id: h.id, text: h.text, due_at: h.due_at || null, blocked_on: h.blocked_on || null,
  }));
  const claims = openVerify.map(v => ({
    kind: 'verify', id: v.id, text: v.claim_text, due_at: v.due_at || null,
    status: v.status, confirm_via: v.confirm_via || null,
  }));
  steps.forEach(place);
  claims.forEach(place);
  const byDue = (a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
  overdue.sort(byDue); dueSoon.sort(byDue);

  const blocked = steps.filter(s => s.blocked_on);
  const unconfirmed = claims;
  // Decisions the counterpart proposed that the person has not yet confirmed or dismissed.
  const proposedDecisions = (decisions || []).filter(d => d.status === 'proposed')
    .map(d => ({ id: d.id, text: d.decision, rationale: d.rationale || null }));

  // The most recent "move this forward" report, while it is still fresh.
  let lastReviewOut = null;
  if (lastReview && lastReview.created_at && lastReview.report) {
    const ageDays = (t - new Date(lastReview.created_at).getTime()) / DAY_MS;
    if (ageDays <= 7) {
      lastReviewOut = {
        at: new Date(lastReview.created_at).toISOString(),
        headline: lastReview.report.headline || null,
        needs_you: Array.isArray(lastReview.report.needs_you) ? lastReview.report.needs_you : [],
        next_move: lastReview.report.next_move || null,
      };
    }
  }

  const parts = [];
  if (overdue.length) parts.push(`${overdue.length} overdue`);
  if (dueSoon.length) parts.push(`${dueSoon.length} due within ${SOON_HOURS / 24} days`);
  if (blocked.length) parts.push(`${blocked.length} waiting on someone else`);
  if (unconfirmed.length) parts.push(`${unconfirmed.length} not yet confirmed`);
  if (proposedDecisions.length) parts.push(`${proposedDecisions.length} decision${proposedDecisions.length === 1 ? '' : 's'} to confirm`);
  const headline = parts.length ? parts.join(', ') : 'Nothing is overdue or waiting right now.';

  const hasOpenWork = steps.length > 0 || claims.length > 0 || proposedDecisions.length > 0;
  const show = hasOpenWork && (overdue.length > 0 || dueSoon.length > 0 || daysAway >= 2 || proposedDecisions.length > 0);

  return {
    thread_id: thread ? thread.id : null,
    last_activity_at: thread && thread.updated_at ? new Date(thread.updated_at).toISOString() : null,
    days_away: daysAway,
    headline,
    show,
    overdue, due_soon: dueSoon, blocked, unconfirmed,
    proposed_decisions: proposedDecisions,
    last_review: lastReviewOut,
    counts: { open_steps: steps.length, open_verify: claims.length, proposed_decisions: proposedDecisions.length },
  };
}

async function loadBriefing(pool, tables, threadId, now) {
  const [thread, held, verification, decisions, review] = await Promise.all([
    pool.query(`SELECT id, updated_at FROM ${tables.threads} WHERE id = $1`, [threadId]),
    pool.query(`SELECT id, text, glyph, due_at, blocked_on FROM ${tables.held} WHERE thread_id = $1 ORDER BY id ASC`, [threadId]),
    pool.query(`SELECT id, claim_text, status, confirm_via, due_at FROM ${tables.verification} WHERE thread_id = $1 ORDER BY id ASC`, [threadId]),
    tables.decisions
      ? pool.query(`SELECT id, decision, rationale, status FROM ${tables.decisions} WHERE thread_id = $1 AND status = 'proposed' ORDER BY id ASC`, [threadId])
      : Promise.resolve({ rows: [] }),
    tables.reviews
      ? pool.query(`SELECT report, created_at FROM ${tables.reviews} WHERE thread_id = $1 AND status = 'ok' ORDER BY id DESC LIMIT 1`, [threadId])
      : Promise.resolve({ rows: [] }),
  ]);
  return composeBriefing({ thread: thread.rows[0], held: held.rows, verification: verification.rows, decisions: decisions.rows, lastReview: review.rows[0], now });
}

// A model-supplied date string that isn't a real date must never make a database write throw.
function safeIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = { composeBriefing, loadBriefing, safeIso };
