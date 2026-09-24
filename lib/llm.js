/* OpenAI-compatible chat completions client (fetch + SSE streaming). */

/** HTTP statuses worth a retry when nothing has been emitted yet. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
/** Total attempts per completion (1 try + 2 retries). */
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Backoff before attempt N: honor Retry-After (capped), else a short linear ramp. */
function backoffMs(res, attempt) {
  const ra = res ? Number(res.headers.get('retry-after')) : NaN;
  if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 8000);
  return Math.min(600 * attempt, 3000);
}

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
 * Returns { message, usage, finishReason, elapsedMs, ttftMs }:
 *   message      assistant message in OpenAI format
 *   usage        { prompt_tokens, completion_tokens, total_tokens } or null when the
 *                server did not report it (callers can then estimate)
 *   finishReason why the model stopped: 'stop', 'tool_calls', 'length' (the token
 *                limit cut the reply off mid-way), 'content_filter', or null
 *   elapsedMs    wall time of the request
 *   ttftMs       time to the first streamed token (null when not streaming)
 *
 * Transient failures (network errors, 408/429/5xx) are retried up to MAX_ATTEMPTS
 * times — but never once anything has been streamed to the caller, so output is
 * never duplicated.
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

  let lastStreamError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await post(makeBody(true));
      // A few gateways reject unknown fields: retry once without stream_options.
      if (!res.ok && stream && (res.status === 400 || res.status === 422)) {
        await res.text().catch(() => '');
        res = await post(makeBody(false));
      }
    } catch (e) {
      // cannot reach the server at all — transient by nature
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(null, attempt));
        continue;
      }
      throw e;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(res, attempt));
        continue;
      }
      throw new Error(`API error ${res.status} ${res.statusText} from ${url}: ${text.slice(0, 500)}`);
    }

    if (!stream) {
      const data = await res.json();
      const choice = data?.choices?.[0];
      if (!choice?.message) throw new Error(`unexpected response shape: ${JSON.stringify(data).slice(0, 400)}`);
      return {
        message: normalizeMessage(choice.message),
        usage: data?.usage || null,
        finishReason: choice.finish_reason ?? null,
        elapsedMs: Date.now() - startedAt,
        ttftMs: null,
      };
    }

    // Streaming: only retry while nothing has been emitted to the caller.
    const state = { emitted: false };
    try {
      const streamed = await readSse(
        res,
        (t) => {
          if (ttftMs === null) ttftMs = Date.now() - startedAt;
          onDelta?.(t);
        },
        state
      );
      return { ...streamed, elapsedMs: Date.now() - startedAt, ttftMs };
    } catch (e) {
      lastStreamError = e;
      if (!state.emitted && attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(null, attempt));
        continue;
      }
      throw e;
    }
  }
  throw lastStreamError || new Error(`request failed after ${MAX_ATTEMPTS} attempts`);
}

async function readSse(res, onDelta, state = { emitted: false }) {
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buf = '';
  let content = '';
  let usage = null;
  let finishReason = null;
  /** @type {Map<number, {id: string, name: string, arguments: string}>} */
  const toolMap = new Map();

  const handleChunk = (chunk) => {
    // final usage-only chunk (stream_options.include_usage) has no choices
    if (chunk?.usage) usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta;
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content.length) {
      content += delta.content;
      state.emitted = true;
      onDelta?.(delta.content);
    }
    for (const tc of delta.tool_calls || []) {
      state.emitted = true;
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
    return { message: buildMessage(), usage, finishReason };
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

