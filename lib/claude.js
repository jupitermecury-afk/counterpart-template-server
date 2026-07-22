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

You also have a code execution tool — real bash and file operations in a sandboxed container. Use it
when the situation genuinely benefits from real computation: actual math, actually parsing something,
actually generating a real file — not for things you already know or that don't need computing.

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

// Anthropic's hosted code execution tool — real bash + file operations in a sandboxed
// container. Generally available, no anthropic-beta header required. Resolves server-side
// within the response (see the agentic loop below for the one case where it doesn't:
// paired with one of our own client tools in the same turn).
const CODE_EXECUTION_TOOL = { type: 'code_execution_20250825', name: 'code_execution' };

// The current, non-deprecated MCP connector beta header (mcp-client-2025-04-04 is deprecated).
const MCP_BETA_HEADER = 'mcp-client-2025-11-20';

// Safety cap on the agentic loop below — bounds cost/latency if the model keeps calling
// tools; degrades gracefully (returns partial content) rather than looping forever.
const MAX_AGENTIC_ROUNDS = 6;

// ── MCP config (deliberately no real server connected yet — this is just the plumbing) ──
// MCP_SERVERS_JSON, if set, is a JSON array of { type: 'url', url, name, authorization_token? }.
// Parsed once at module load, fails soft (logs and disables MCP) rather than throwing, so a
// bad env var can never crash the server on boot.
function parseMcpServersConfig(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('[claude.js] MCP_SERVERS_JSON invalid JSON, ignoring MCP config:', e.message);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error('[claude.js] MCP_SERVERS_JSON must be an array, ignoring MCP config');
    return [];
  }
  const valid = [];
  for (const entry of parsed) {
    if (!entry || entry.type !== 'url' || !entry.url || !entry.name) {
      console.error('[claude.js] skipping invalid MCP server entry:', JSON.stringify(entry));
      continue;
    }
    const server = { type: 'url', url: entry.url, name: entry.name };
    if (entry.authorization_token) server.authorization_token = entry.authorization_token;
    valid.push(server);
  }
  return valid;
}

const MCP_SERVERS = parseMcpServersConfig(process.env.MCP_SERVERS_JSON);
const MCP_SERVERS_FIELD = MCP_SERVERS.length ? MCP_SERVERS : undefined; // never send an empty array
const MCP_TOOLSET_TOOLS = MCP_SERVERS.map((s) => ({ type: 'mcp_toolset', mcp_server_name: s.name }));
const REQUEST_TOOLS = [...TOOLS, CODE_EXECUTION_TOOL, ...MCP_TOOLSET_TOOLS];

function buildHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  if (MCP_SERVERS.length) headers['anthropic-beta'] = MCP_BETA_HEADER;
  return headers;
}

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

function safeParseJSON(str) {
  try { return JSON.parse(str || '{}'); } catch { return {}; }
}

/**
 * Makes one streaming call to the Anthropic Messages API and parses the SSE response into
 * a structured result. Does not loop — the agentic loop lives in streamCounterpartReply below.
 *
 * Returns { assistantContent, textThisRound, toolCallsThisRound, stopReason }.
 * assistantContent is the exact ordered array of content blocks the API returned (text,
 * tool_use, server_tool_use, mcp_tool_use, and any *_tool_result blocks) — this must be
 * echoed back verbatim as the assistant's turn for a follow-up round to work correctly.
 */
async function runOneMessagesCall({ model, maxTokens, system, headers, conversation, onText, onTool, onServerToolEvent }) {
  const body = {
    model,
    max_tokens: maxTokens || 4096,
    system,
    messages: conversation,
    tools: REQUEST_TOOLS,
    stream: true,
  };
  if (MCP_SERVERS_FIELD) body.mcp_servers = MCP_SERVERS_FIELD;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let textThisRound = '';
  let stopReason = null;
  const blocks = {}; // index -> accumulator
  const toolCallsThisRound = [];

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
        const cb = evt.content_block;
        if (cb.type === 'text') {
          blocks[evt.index] = { type: 'text', textBuf: '' };
        } else if (cb.type === 'tool_use' || cb.type === 'server_tool_use' || cb.type === 'mcp_tool_use') {
          blocks[evt.index] = {
            type: cb.type,
            id: cb.id,
            name: cb.name,
            server_name: cb.server_name, // only present on mcp_tool_use, harmless otherwise
            jsonBuf: '',
            rawInput: cb.input || {}, // fallback if no input_json_delta events arrive
          };
        } else {
          // *_tool_result blocks (bash_code_execution_tool_result, mcp_tool_result, etc.) —
          // expected to arrive whole in this event, no deltas.
          blocks[evt.index] = { type: cb.type, raw: cb };
        }
      } else if (evt.type === 'content_block_delta') {
        const b = blocks[evt.index];
        if (!b) continue;
        if (evt.delta.type === 'text_delta') {
          b.textBuf += evt.delta.text;
          textThisRound += evt.delta.text;
          if (onText) onText(evt.delta.text);
        } else if (evt.delta.type === 'input_json_delta') {
          b.jsonBuf += evt.delta.partial_json;
        }
      } else if (evt.type === 'content_block_stop') {
        const b = blocks[evt.index];
        if (!b) continue;
        let finalBlock;
        if (b.type === 'text') {
          finalBlock = { type: 'text', text: b.textBuf };
        } else if (b.type === 'tool_use') {
          const input = b.jsonBuf ? safeParseJSON(b.jsonBuf) : b.rawInput;
          finalBlock = { type: 'tool_use', id: b.id, name: b.name, input };
          const call = { name: b.name, input };
          toolCallsThisRound.push(call);
          if (onTool) onTool(call);
        } else if (b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
          const input = b.jsonBuf ? safeParseJSON(b.jsonBuf) : b.rawInput;
          finalBlock = b.type === 'mcp_tool_use'
            ? { type: 'mcp_tool_use', id: b.id, name: b.name, server_name: b.server_name, input }
            : { type: 'server_tool_use', id: b.id, name: b.name, input };
          if (onServerToolEvent) onServerToolEvent(finalBlock);
        } else {
          finalBlock = b.raw;
          if (onServerToolEvent) onServerToolEvent(finalBlock);
        }
        blocks[evt.index].final = finalBlock;
      } else if (evt.type === 'message_delta') {
        if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
      } else if (evt.type === 'error') {
        console.error('[claude.js] stream error event:', evt.error);
        // Don't throw — let the read loop end naturally; the round is treated as final.
      }
    }
  }

  const assistantContent = Object.keys(blocks)
    .map(Number)
    .sort((a, b) => a - b)
    .map(i => blocks[i].final)
    .filter(Boolean);

  return { assistantContent, textThisRound, toolCallsThisRound, stopReason };
}

/**
 * Streams a counterpart reply from the Anthropic Messages API, running a real multi-round
 * agentic loop: if the model calls one of our custom tools, we submit a tool_result and let
 * it continue reasoning (fixing a real bug — today's single-shot call cuts off anything the
 * model meant to say after a tool call, since the API ends the turn at stop_reason: tool_use).
 * Code execution and MCP tool calls resolve server-side and are passed through untouched.
 *
 * onText(deltaString) is called for each text delta, across all rounds.
 * onTool({name, input}) is called once per completed custom tool_use block, across all rounds.
 * onServerToolEvent(block) is optional — called for resolved code-execution/MCP blocks.
 * Resolves with { fullText, toolCalls: [{name, input}] } — same shape as before, concatenated
 * across all rounds.
 */
async function streamCounterpartReply({ model, maxTokens, messages, onText, onTool, onServerToolEvent, extraSystemContext }) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const lastUserText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : (lastUser?.content || []).find(b => b.type === 'text')?.text;

  const search = await maybeSearch(model, lastUserText);
  // Optional caller-supplied standing context (e.g. a web org's or situation's own
  // context text) appended after the built-in persona — additive, backward-compatible;
  // callers that don't pass it (the mobile app) see no change in behavior.
  const system = systemPrompt() + searchContextBlock(search) + (extraSystemContext || '');
  const headers = buildHeaders();

  let conversation = messages;
  let fullText = '';
  const toolCalls = [];

  for (let round = 0; round < MAX_AGENTIC_ROUNDS; round++) {
    const { assistantContent, textThisRound, toolCallsThisRound, stopReason } = await runOneMessagesCall({
      model, maxTokens, system, headers, conversation, onText, onTool, onServerToolEvent,
    });

    fullText += textThisRound;
    toolCalls.push(...toolCallsThisRound);

    if (stopReason !== 'tool_use') break;

    if (round === MAX_AGENTIC_ROUNDS - 1) {
      console.warn('[claude.js] hit max agentic rounds cap; returning partial reply');
      break;
    }

    const clientToolUseBlocks = assistantContent.filter(b => b.type === 'tool_use');
    if (!clientToolUseBlocks.length) {
      console.warn('[claude.js] stop_reason=tool_use but no client tool_use block present; stopping');
      break;
    }

    const toolResultBlocks = clientToolUseBlocks.map(b => ({
      type: 'tool_result',
      tool_use_id: b.id,
      content: 'noted',
    }));

    conversation = [
      ...conversation,
      { role: 'assistant', content: assistantContent },
      { role: 'user', content: toolResultBlocks },
    ];
  }

  return { fullText, toolCalls };
}

module.exports = { streamCounterpartReply, systemPrompt, TOOLS };
