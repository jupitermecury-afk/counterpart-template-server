const fs = require('fs');
const path = require('path');

const ACTIVATION_TEXT = fs.readFileSync(path.join(__dirname, '..', 'activation.txt'), 'utf8');

// Additive, appended AFTER the verbatim activation text — never inserted into or
// rewording it. Tells the model the structured affordances exist; it still decides
// internally when to use them (Refusal of Mode Selection stays intact).
const TOOL_BRIDGE = `

---

The surface you are running on renders your words as prose, but it also gives you a few structured
instruments alongside your voice. Use them only when the situation actually calls for it — never as a
checklist, never narrated to the person:

- surface_artifact — when you produce a real artifact (a draft, a plan, a document, a path through the
  situation), call this so it renders as a real object the person can open, copy, and act on, in addition
  to whatever you say about it in your prose.
- flag_verification — the moment you make a claim you cannot confirm from your own knowledge, call this
  with the claim itself, in addition to naming it in your prose. This is what keeps the verification
  register honest.
- update_held_thread — when the shape of what you're holding for the person changes (something opens,
  something settles, something closes), call this so the held record stays accurate without the person
  having to manage it.
- prepare_email_draft / prepare_calendar_event — when the path forward genuinely requires an email or a
  calendar entry, call the relevant one with the real content. You are preparing it, not sending or
  committing it — the person reviews and acts.

Call these alongside your ordinary reply, not instead of it. Your prose is still how you are present;
these are just how that presence becomes a real object on the person's screen.

Never reply with a tool call alone. The person only sees what you say in prose — a tool call with no
words around it is silence to them, which is the one thing a counterpart must never do. Always write to
them first, in your own voice, and let any tool calls accompany that, never replace it.`;

function systemPrompt() {
  return ACTIVATION_TEXT + TOOL_BRIDGE;
}

const TOOLS = [
  {
    name: 'surface_artifact',
    description: 'Render a real artifact (draft, plan, document, path through the situation) as an object the person can open, copy, and act on.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        kind: { type: 'string', description: 'e.g. "reading", "draft", "full fidelity", "path"' },
        fidelity: { type: 'string', enum: ['draft', 'full'] },
        body_markdown: { type: 'string' },
        actable: { type: 'boolean', description: 'true if this is something the person could act on externally (send, commit, etc.)' },
      },
      required: ['title', 'kind', 'fidelity', 'body_markdown'],
    },
  },
  {
    name: 'flag_verification',
    description: 'Flag a claim the work rests on that cannot be confirmed from your own knowledge.',
    input_schema: {
      type: 'object',
      properties: { claim_text: { type: 'string' } },
      required: ['claim_text'],
    },
  },
  {
    name: 'update_held_thread',
    description: 'Update what is being held for the person about this problem thread.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        glyph: { type: 'string', enum: ['live', 'rest', 'done', 'unresolved'] },
        meta: { type: 'string' },
      },
      required: ['text', 'glyph'],
    },
  },
  {
    name: 'prepare_email_draft',
    description: 'Prepare an email draft for the person to review and send themselves. Does not send anything.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['subject', 'body'],
    },
  },
  {
    name: 'prepare_calendar_event',
    description: 'Prepare a calendar event for the person to confirm themselves. Does not commit anything.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        notes: { type: 'string' },
        start_iso: { type: 'string' },
        end_iso: { type: 'string' },
        location: { type: 'string' },
      },
      required: ['title', 'start_iso'],
    },
  },
];

// Same live-search pattern already used by the existing /counterpart route in server.js —
// kept consistent rather than reinvented.
async function tavilySearch(query) {
  if (!process.env.TAVILY_API_KEY) return null;
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: true,
      }),
    });
    return await response.json();
  } catch (err) {
    console.error('[Tavily] error:', err);
    return null;
  }
}

async function maybeSearch(model, lastUserText) {
  if (!lastUserText) return null;
  try {
    const checkResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Given this message from a person seeking help, does answering it well require current, real-world information that may have changed recently — such as current prices, fees, phone numbers, office addresses, government requirements, exchange rates, company policies, or recent news?\n\nMessage: "${lastUserText}"\n\nRespond with ONLY a JSON object in this exact format:\n{"needs_search": true, "query": "the search query to run"}\nor\n{"needs_search": false, "query": null}`,
        }],
      }),
    });
    const checkData = await checkResponse.json();
    const checkText = checkData.content?.find(b => b.type === 'text')?.text || '{}';
    const cleaned = checkText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.needs_search && parsed.query) {
      const result = await tavilySearch(parsed.query);
      return { query: parsed.query, result };
    }
  } catch (e) {
    // search check failed to parse — proceed without search
  }
  return null;
}

function searchContextBlock(search) {
  if (!search || !search.result) return '';
  const { query, result } = search;
  const answer = result.answer || '';
  const sources = (result.results || [])
    .slice(0, 4)
    .map(r => `- ${r.title}: ${r.content?.slice(0, 200)}... (${r.url})`)
    .join('\n');
  return `\n\nLIVE SEARCH RESULTS — retrieved now for this conversation:\nSearch query: "${query}"\n${answer ? `Summary: ${answer}` : ''}\nSources:\n${sources}\n\nUse this information naturally. Do not announce that you searched unless asked how you know something — then share the sources above.`;
}

/**
 * Streams a counterpart reply from the Anthropic Messages API.
 * onText(deltaString) is called for each text delta.
 * onTool({name, input}) is called once per completed tool_use block.
 * Resolves with { fullText, toolCalls: [{name, input}] }.
 */
async function streamCounterpartReply({ model, maxTokens, messages, onText, onTool }) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const lastUserText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : (lastUser?.content || []).find(b => b.type === 'text')?.text;

  const search = await maybeSearch(model, lastUserText);
  const system = systemPrompt() + searchContextBlock(search);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || 4096,
      system,
      messages,
      tools: TOOLS,
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  const blocks = {}; // index -> { type, name?, jsonBuf? }
  const toolCalls = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      const dataLine = rawEvent.split('\n').find(l => l.startsWith('data:'));
      if (!dataLine) continue;
      let evt;
      try { evt = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }

      if (evt.type === 'content_block_start') {
        blocks[evt.index] = evt.content_block.type === 'tool_use'
          ? { type: 'tool_use', name: evt.content_block.name, jsonBuf: '' }
          : { type: 'text' };
      } else if (evt.type === 'content_block_delta') {
        const b = blocks[evt.index];
        if (!b) continue;
        if (evt.delta.type === 'text_delta') {
          fullText += evt.delta.text;
          if (onText) onText(evt.delta.text);
        } else if (evt.delta.type === 'input_json_delta') {
          b.jsonBuf += evt.delta.partial_json;
        }
      } else if (evt.type === 'content_block_stop') {
        const b = blocks[evt.index];
        if (b && b.type === 'tool_use') {
          let input = {};
          try { input = JSON.parse(b.jsonBuf || '{}'); } catch { /* leave empty */ }
          const call = { name: b.name, input };
          toolCalls.push(call);
          if (onTool) onTool(call);
        }
      }
    }
  }

  return { fullText, toolCalls };
}

module.exports = { streamCounterpartReply, systemPrompt, TOOLS };
