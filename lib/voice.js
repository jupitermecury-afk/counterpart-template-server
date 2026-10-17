// Spoken replies. The voice page sends depth "spoken": the reply will be read aloud, so it should
// sound like a person talking (short, plain, no markup), and it can run on a cheaper model.
// Everything else about how the counterpart works is unchanged — same persona, tools, and state.

// Switchable without a deploy: set VOICE_MODEL in the environment.
const VOICE_MODEL = process.env.VOICE_MODEL || 'claude-haiku-5-5';

// The ceiling is generous on purpose: a document the counterpart builds with its tools counts
// against it, and a cut-off tool call is worse than a long one. Brevity comes from the instruction.
const SPOKEN_MAX_TOKENS = 3000;

const SPOKEN_CONTEXT = `

THIS IS A SPOKEN CONVERSATION. The person is talking to you by voice and your reply will be read aloud, so speak the way a thoughtful person speaks.
- Keep every reply under about sixty words, three or four short sentences, unless they ask for more. Never give a list of questions: ask exactly one.
- Plain sentences only. No markdown, headings, bullet points, numbered lists, tables, or emoji. Say numbers and dates the way you would say them aloud.
- If they ask for something long (a letter, a plan, a document), say in a sentence what you are making, create it with your tools so it appears in their documents, and give only a short spoken summary. Do not read it out.
- Your tools work exactly as they do in writing, and you must keep using them. When the person says they have decided or will do something ("I've decided...", "I'll send...", "let's go with..."), call log_decision in that same reply, even if your spoken answer is about something else. When you state a fact you cannot confirm, call flag_verification. When you identify something that needs doing, call update_held_thread.`;

// depthTokens: the normal { brief, standard, deep } ceilings; model: the normal chat model.
function turnSettings(depth, { model, depthTokens }) {
  if (depth === 'spoken') {
    return { model: VOICE_MODEL, maxTokens: SPOKEN_MAX_TOKENS, context: SPOKEN_CONTEXT, spoken: true };
  }
  return { model, maxTokens: depthTokens[depth] || depthTokens.standard, context: '', spoken: false };
}

module.exports = { turnSettings, VOICE_MODEL, SPOKEN_MAX_TOKENS, SPOKEN_CONTEXT };
