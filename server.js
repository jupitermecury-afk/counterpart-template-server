const express = require('express');
const cors    = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
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

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'counterpart-server' }));

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
app.post('/counterpart', checkSecret, async (req, res) => {
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

// ── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Counterpart server running on port ${PORT}`));
