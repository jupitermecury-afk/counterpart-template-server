// What each key costs to run. Counts and an estimated cost per key, per day, per mode (spoken or
// typed) — never message content. Two jobs: give pricing and fair-use decisions real numbers, and put
// a ceiling under a single key so a leaked or runaway key cannot run up an unbounded bill.
//
// Everything here fails open: if metering itself breaks, the person's conversation must still work.

// Dollars per million tokens: input, cache write, cache read, output (Anthropic list prices).
const PRICES = {
  'claude-sonnet-4-6': [3, 3.75, 0.3, 15],
  'claude-sonnet-5-5': [2, 2.5, 0.2, 10],
  'claude-haiku-5-5': [0.10, 0.125, 0.01, 0.50],
};
const FALLBACK_PRICE = PRICES['claude-sonnet-4-6']; // an unknown model is costed at the dearer, safer rate

// Estimated spend per key per UTC day before further messages are paused. 0 turns the cap off.
const DEFAULT_DAILY_CAP_USD = Number(process.env.DAILY_COST_CAP_USD ?? 5);

function estimateCost(model, u) {
  const p = PRICES[model] || FALLBACK_PRICE;
  const x = u || {};
  return ((x.input || 0) * p[0] + (x.cacheWrite || 0) * p[1] + (x.cacheRead || 0) * p[2] + (x.output || 0) * p[3]) / 1e6;
}

const TODAY_SQL = `(now() AT TIME ZONE 'utc')::date`;

async function recordUsage(pool, keyId, { mode, model, usage }) {
  try {
    const u = usage || {};
    await pool.query(
      `INSERT INTO web_usage (access_key_id, day, mode, model, turns, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, est_cost_usd)
       VALUES ($1, ${TODAY_SQL}, $2, $3, 1, $4, $5, $6, $7, $8)
       ON CONFLICT (access_key_id, day, mode, model) DO UPDATE SET
         turns = web_usage.turns + 1,
         input_tokens = web_usage.input_tokens + EXCLUDED.input_tokens,
         cache_write_tokens = web_usage.cache_write_tokens + EXCLUDED.cache_write_tokens,
         cache_read_tokens = web_usage.cache_read_tokens + EXCLUDED.cache_read_tokens,
         output_tokens = web_usage.output_tokens + EXCLUDED.output_tokens,
         est_cost_usd = web_usage.est_cost_usd + EXCLUDED.est_cost_usd`,
      [keyId, mode === 'spoken' ? 'spoken' : 'typed', model, u.input || 0, u.cacheWrite || 0, u.cacheRead || 0, u.output || 0, estimateCost(model, u)]
    );
  } catch (err) {
    console.error('[usage] could not record:', err.message);
  }
}

async function spentToday(pool, keyId) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(est_cost_usd), 0)::float AS spent FROM web_usage WHERE access_key_id = $1 AND day = ${TODAY_SQL}`,
    [keyId]
  );
  return (r.rows[0] && r.rows[0].spent) || 0;
}

// { ok:true } to proceed; { ok:false, spent, cap } once today's estimated spend has reached the cap.
async function checkDailyCap(pool, keyId, capUsd = DEFAULT_DAILY_CAP_USD) {
  try {
    if (!(capUsd > 0)) return { ok: true, cap: 0 };
    const spent = await spentToday(pool, keyId);
    return spent >= capUsd ? { ok: false, spent, cap: capUsd } : { ok: true, spent, cap: capUsd };
  } catch (err) {
    console.error('[usage] cap check failed, allowing:', err.message);
    return { ok: true };
  }
}

// What one key has used: today, and the last 30 days by mode.
async function usageSummary(pool, keyId, capUsd = DEFAULT_DAILY_CAP_USD) {
  const rows = await pool.query(
    `SELECT day::text AS day, mode, SUM(turns)::int AS turns, SUM(est_cost_usd)::float AS cost
       FROM web_usage WHERE access_key_id = $1 AND day > ${TODAY_SQL} - 30
      GROUP BY day, mode ORDER BY day DESC, mode`,
    [keyId]
  );
  const round = (n) => Math.round(n * 10000) / 10000;
  const today = new Date().toISOString().slice(0, 10);
  const byMode = { spoken: { turns: 0, est_cost_usd: 0 }, typed: { turns: 0, est_cost_usd: 0 } };
  let spentTodayUsd = 0, turnsToday = 0;
  for (const r of rows.rows) {
    byMode[r.mode].turns += r.turns; byMode[r.mode].est_cost_usd += r.cost;
    if (r.day === today) { spentTodayUsd += r.cost; turnsToday += r.turns; }
  }
  for (const m of Object.values(byMode)) m.est_cost_usd = round(m.est_cost_usd);
  return {
    today: { turns: turnsToday, est_cost_usd: round(spentTodayUsd), daily_cap_usd: capUsd > 0 ? capUsd : null },
    last_30_days: byMode,
    note: 'Estimates from list prices; counts only, never content.',
  };
}

module.exports = { estimateCost, recordUsage, checkDailyCap, spentToday, usageSummary, PRICES, DEFAULT_DAILY_CAP_USD };
