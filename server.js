const express = require('express');
const cors    = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();
const { migrate } = require('./db');
const { startPresenceNudges } = require('./lib/pushNudge');
const apiRouter = require('./routes/api');

const app = express();

// ── CORS ─────────────────────────────────────────────────────────────────────
// By default, accepts requests from any origin. To restrict to your deployed
// front end(s), set ALLOWED_ORIGIN to a comma-separated list of origins, e.g.
//   ALLOWED_ORIGIN=https://my-company-counterpart.netlify.app
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors(allowedOrigins.length ? { origin: allowedOrigins } : {}));
app.use(express.json());

// ── OPTIONAL SHARED SECRET ──────────────────────────────────────────────────
// If you set CLIENT_SECRET in your environment, only requests carrying a
// matching "X-Client-Secret" header will be served. Leave it unset to skip
// this check entirely (fine for most single-company deployments).
const CLIENT_SECRET = process.env.CLIENT_SECRET || null;

function checkSecret(req, res, next) {
  if (!CLIENT_SECRET) return next();
  if (req.headers['x-client-secret'] === CLIENT_SECRET) return next();
  return res.status(401).json({ error: { message: 'Unauthorized' } });
}

// ── RATE LIMITING ────────────────────────────────────────────────────────────
// Caps how many /counterpart requests a single visitor can make, so a
// compromised secret or a stuck retry loop can't run away with your API bill.
// Tune with RATE_LIMIT_WINDOW_MIN / RATE_LIMIT_MAX env vars if needed.
const counterpartLimiter = rateLimit({
  windowMs: (Number(process.env.RATE_LIMIT_WINDOW_MIN) || 15) * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many requests — please wait a few minutes and try again.' } }
});

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'counterpart-server' }));

// ── MOBILE APP API ───────────────────────────────────────────────────────────
// Real per-key DB auth (not the shared CLIENT_SECRET above), problem-scoped
// persistence, SSE streaming, and tool-use wiring for the React Native app.
app.use('/api', apiRouter);

// ── TAVILY SEARCH HELPER ─────────────────────────────────────────────────────
async function tavilySearch(query) {
  if (!process.env.TAVILY_API_KEY) return null;
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key:        process.env.TAVILY_API_KEY,
        query:          query,
        search_depth:   'basic',
        max_results:    5,
        include_answer: true
      })
    });
    return await response.json();
  } catch (err) {
    console.error('[Tavily] error:', err);
    return null;
  }
}

// ── COUNTERPART ──────────────────────────────────────────────────────────────
app.post('/counterpart', counterpartLimiter, checkSecret, async (req, res) => {
  const { model, max_tokens, system, messages, key_name } = req.body;
  console.log(`[Counterpart] key=${key_name || 'unknown'} messages=${messages?.length}`);

  try {
    // ── STEP 1: Ask Claude whether a search is needed ──────────────────────
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
    const searchCheckMessages = [
      {
        role: 'user',
        content: `Given this message from a person seeking help, does answering it well require current, real-world information that may have changed recently — such as current prices, fees, phone numbers, office addresses, government requirements, exchange rates, company policies, or recent news?\n\nMessage: "${lastUserMessage?.content}"\n\nRespond with ONLY a JSON object in this exact format:\n{"needs_search": true, "query": "the search query to run"}\nor\n{"needs_search": false, "query": null}`
      }
    ];

    const checkResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      model,
        max_tokens: 200,
        messages:   searchCheckMessages
      })
    });

    const checkData  = await checkResponse.json();
    const checkText  = checkData.content?.find(b => b.type === 'text')?.text || '{}';
    let   searchResult = null;
    let   searchQuery  = null;

    try {
      const cleaned = checkText.replace(/```json|```/g, '').trim();
      const parsed  = JSON.parse(cleaned);
      if (parsed.needs_search && parsed.query) {
        searchQuery  = parsed.query;
        console.log(`[Counterpart] searching: "${searchQuery}"`);
        searchResult = await tavilySearch(searchQuery);
      }
    } catch (e) {
      // Search check failed to parse — proceed without search
    }

    // ── STEP 2: Build the final system prompt ─────────────────────────────
    let finalSystem = system;

    if (searchResult) {
      const answer  = searchResult.answer || '';
      const sources = (searchResult.results || [])
        .slice(0, 4)
        .map(r => `- ${r.title}: ${r.content?.slice(0, 200)}... (${r.url})`)
        .join('\n');

      const searchContext = `
LIVE SEARCH RESULTS — retrieved now for this conversation:
Search query: "${searchQuery}"
${answer ? `Summary: ${answer}` : ''}
Sources:
${sources}

Use this information naturally in your response. Do not announce that you searched unless the person specifically asks how you know something or asks you to show your sources — in that case, share the sources listed above. Weave the information in as if you simply know it.`;

      finalSystem = system + '\n\n' + searchContext;
    }

    // ── STEP 3: Call Claude with full context ─────────────────────────────
    const finalResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model, max_tokens, system: finalSystem, messages })
    });

    const finalData = await finalResponse.json();
    res.json(finalData);

  } catch (err) {
    console.error('[Counterpart] error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── ERROR HANDLER ────────────────────────────────────────────────────────────
// Catches anything passed to next(err) (see asyncRoute in routes/api.js) so a bug
// in the new mobile routes returns a JSON 500 instead of crashing the process.
app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: { message: err.message || 'internal error' } });
});

// Last-resort net: log and keep running rather than let a stray rejection take the
// whole server (and the existing web app's routes with it) down.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

// ── START ────────────────────────────────────────────────────────────────────
// The existing routes (/, /counterpart) must keep serving the live web app even if
// the new database isn't configured yet — so listen() never waits on migrate().
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Counterpart server running on port ${PORT}`));

if (process.env.DATABASE_URL) {
  migrate()
    .then(() => startPresenceNudges())
    .catch(err => console.error('[db] migration failed — /api routes will not work until this is fixed:', err));
} else {
  console.log('[db] DATABASE_URL not set — /api (mobile app) routes will fail until it is configured');
}
