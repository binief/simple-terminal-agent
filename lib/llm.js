/* OpenAI-compatible chat completions client (fetch + SSE streaming). */

/** Rough token estimate (chars/4) used for context budgeting. */
export function estimateTokens(messages) {
  let n = 0;
  for (const m of messages) {
    n += 4;
    if (typeof m.content === 'string') n += Math.ceil(m.content.length / 4);
    if (m.tool_calls) n += Math.ceil(JSON.stringify(m.tool_calls).length / 4);
  }
  return n;
}

function normalizeMessage(msg) {
  const out = {
    role: msg.role || 'assistant',
    content: typeof msg.content === 'string' && msg.content.length ? msg.content : msg.content ?? null,
  };
  if (msg.tool_calls?.length) {
    out.content = typeof msg.content === 'string' ? msg.content : null;
    out.tool_calls = msg.tool_calls.map((tc, i) => {
      const fn = tc.function || {};
      const args = fn.arguments;
      return {
        id: tc.id || `call_${i + 1}`,
        type: 'function',
        function: {
          name: fn.name || '',
          arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        },
      };
    });
  }
  return out;
}

/**
 * One chat completion turn.
 * - config: { openai: {baseURL, apiKey, model}, temperature, streaming, ... }
 * - messages: OpenAI chat format
 * - tools: [{name, description, parameters}]
 * - maxTokens: cap for the completion
 * - onDelta(text): called with streamed text fragments when streaming
 * Returns { message, usage, elapsedMs, ttftMs }:
 *   message    assistant message in OpenAI format
 *   usage      { prompt_tokens, completion_tokens, total_tokens } or null when the
 *              server did not report it (callers can then estimate)
 *   elapsedMs  wall time of the request
 *   ttftMs     time to the first streamed token (null when not streaming)
 */
export async function chatCompletion({ config, messages, tools = [], maxTokens = 4096, onDelta }) {
  const base = String(config.openai.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const stream = Boolean(config.streaming && onDelta);
  const startedAt = Date.now();
  let ttftMs = null;

  const makeBody = (withUsage) => {
    const body = {
      model: config.openai.model,
      messages,
      temperature: config.temperature,
      max_tokens: maxTokens,
      stream,
    };
    if (tools.length) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }
    // Ask for token usage in the stream too; harmless when unsupported.
    if (stream && withUsage) body.stream_options = { include_usage: true };
    return body;
  };

  const headers = { 'content-type': 'application/json' };
  if (config.openai.apiKey) headers.authorization = `Bearer ${config.openai.apiKey}`;

  const post = async (body) => {
    try {
      return await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) {
      throw new Error(`cannot reach ${url}: ${e.cause?.message || e.message}`);
    }
  };

  let res = await post(makeBody(true));
  // A few gateways reject unknown fields: retry once without stream_options.
  if (!res.ok && stream && (res.status === 400 || res.status === 422)) {
    await res.text().catch(() => '');
    res = await post(makeBody(false));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API error ${res.status} ${res.statusText} from ${url}: ${text.slice(0, 500)}`);
  }

  if (!stream) {
    const data = await res.json();
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new Error(`unexpected response shape: ${JSON.stringify(data).slice(0, 400)}`);
    return { message: normalizeMessage(msg), usage: data?.usage || null, elapsedMs: Date.now() - startedAt, ttftMs: null };
  }

  const streamed = await readSse(res, (t) => {
    if (ttftMs === null) ttftMs = Date.now() - startedAt;
    onDelta?.(t);
  });
  return { ...streamed, elapsedMs: Date.now() - startedAt, ttftMs };
}

async function readSse(res, onDelta) {
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buf = '';
  let content = '';
  let usage = null;
  /** @type {Map<number, {id: string, name: string, arguments: string}>} */
  const toolMap = new Map();

  const handleChunk = (chunk) => {
    // final usage-only chunk (stream_options.include_usage) has no choices
    if (chunk?.usage) usage = chunk.usage;
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content.length) {
      content += delta.content;
      onDelta?.(delta.content);
    }
    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? 0;
      if (!toolMap.has(idx)) toolMap.set(idx, { id: '', name: '', arguments: '' });
      const slot = toolMap.get(idx);
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.arguments += tc.function.arguments;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        return finish();
      }
      if (!payload) continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk?.error) throw new Error(`stream error: ${JSON.stringify(chunk.error)}`);
      handleChunk(chunk);
    }
  }
  return finish();

  function finish() {
    return { message: buildMessage(), usage };
  }

  function buildMessage() {
    const msg = { role: 'assistant', content: content || null };
    if (toolMap.size) {
      msg.content = content || null;
      msg.tool_calls = [...toolMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, slot], k) => ({
          id: slot.id || `call_${k + 1}`,
          type: 'function',
          function: {
            name: slot.name,
            arguments: slot.arguments || '{}',
          },
        }));
    }
    return normalizeMessage(msg);
  }
}

