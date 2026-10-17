// Who is costing what, from real numbers. Read-only. Counts and estimated cost per key; no content.
//
//   railway run --service Postgres node scripts/usage-report.js        (30 days)
//   railway run --service Postgres node scripts/usage-report.js 7      (last 7 days)
//
// Use it to decide pricing and fair-use limits: what a typical key costs a month, how much of that is
// spoken versus typed, and whether anyone is near the daily cap.

const { Client } = require('pg');

(async () => {
  const days = Math.max(1, Math.min(365, parseInt(process.argv[2], 10) || 30));
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) { console.error('No database URL in the environment (use: railway run --service Postgres node scripts/usage-report.js).'); process.exit(2); }
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const per = (await c.query(`
    SELECT k.id, COALESCE(k.label, '(no label)') AS label,
           COALESCE(SUM(u.turns) FILTER (WHERE u.mode = 'typed'), 0)::int  AS typed_turns,
           COALESCE(SUM(u.turns) FILTER (WHERE u.mode = 'spoken'), 0)::int AS spoken_turns,
           COALESCE(SUM(u.est_cost_usd) FILTER (WHERE u.mode = 'typed'), 0)::float  AS typed_cost,
           COALESCE(SUM(u.est_cost_usd) FILTER (WHERE u.mode = 'spoken'), 0)::float AS spoken_cost,
           COUNT(DISTINCT u.day)::int AS active_days,
           (SELECT COALESCE(MAX(daily), 0) FROM (
              SELECT SUM(w.est_cost_usd) AS daily FROM web_usage w
               WHERE w.access_key_id = k.id AND w.day > (now() AT TIME ZONE 'utc')::date - $1::int GROUP BY w.day) x)::float AS worst_day
      FROM web_access_keys k
      LEFT JOIN web_usage u ON u.access_key_id = k.id AND u.day > (now() AT TIME ZONE 'utc')::date - $1::int
     GROUP BY k.id, k.label ORDER BY (COALESCE(SUM(u.est_cost_usd), 0)) DESC, k.id`, [days])).rows;

  const usd = (n) => '$' + n.toFixed(n < 1 ? 3 : 2);
  console.log(`Usage over the last ${days} day(s), estimated from list prices (counts only, never content)\n`);
  console.log('key  label                 days  typed turns  spoken turns  typed $   spoken $  total $   worst day');
  let total = 0, tt = 0, st = 0;
  for (const r of per) {
    const sum = r.typed_cost + r.spoken_cost; total += sum; tt += r.typed_turns; st += r.spoken_turns;
    console.log(String(r.id).padEnd(4), String(r.label).slice(0, 20).padEnd(21), String(r.active_days).padStart(4), String(r.typed_turns).padStart(12), String(r.spoken_turns).padStart(13), usd(r.typed_cost).padStart(9), usd(r.spoken_cost).padStart(9), usd(sum).padStart(9), usd(r.worst_day).padStart(10));
  }
  console.log(`\nAll keys: ${tt} typed turns, ${st} spoken turns, ${usd(total)} in total.`);
  const withUse = per.filter(r => r.typed_turns + r.spoken_turns > 0);
  if (withUse.length) {
    const avgTyped = per.reduce((a, r) => a + r.typed_cost, 0) / Math.max(1, per.reduce((a, r) => a + r.typed_turns, 0));
    const avgSpoken = per.reduce((a, r) => a + r.spoken_cost, 0) / Math.max(1, per.reduce((a, r) => a + r.spoken_turns, 0));
    console.log(`Average per turn: typed ${usd(avgTyped)}, spoken ${usd(avgSpoken)}.`);
  } else {
    console.log('No usage recorded yet in this period (recording began when this was deployed).');
  }
  await c.end();
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
