/* OpenAI-compatible chat completions client (fetch + SSE streaming). */

/** HTTP statuses worth a retry when nothing has been emitted yet. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
/** Total attempts per completion (1 try + 2 retries). */
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Rejections of the model's own output                                */
/* ------------------------------------------------------------------ */

/* Some servers parse the tool call out of the generated text themselves and
 * answer 500 when that fails. llama.cpp does it, and the usual cause is a
 * reply that ran into max_tokens while it was still writing a long string
 * argument — a whole file handed to write_file, typically:
 *
 *   {"error":{"code":500,"message":"Failed to parse tool call arguments as
 *   JSON: [json.exception.parse_error.101] parse error at line 1, column
 *   15045: … invalid string: missing closing quote; last read: '\"<div …
 *
 * That is a 5xx, but it is not transient: the same request regenerates the
 * same oversized reply, so the default three attempts only cost three full
 * generations before the turn dies. It is classified here instead, and the
 * callers recover by telling the model to make the call smaller.
 */

/** `err.kind` for "the server could not parse the tool call it generated". */
export const TOOL_CALL_PARSE_ERROR = 'tool_call_parse';

/** `err.kind` for "this request does not fit in the model's context window". */
export const CONTEXT_LENGTH_ERROR = 'context_length';

/*
 * How servers say "too many tokens". Wording differs per provider — OpenAI
 * (context_length_exceeded), Anthropic (prompt is too long), Ollama/vLLM
 * (maximum context length / requested tokens exceed), Gemini (input is too
 * long) — and some only report it in the message of a 400. A caller that
 * recognises it can compact the conversation and try again instead of dying.
 */
const CONTEXT_LENGTH_RE = new RegExp([
  'context[_\\s-]?length[_\\s-]?(?:exceeded|limit)?',
  'context[_\\s-]?window',
  'maximum[_\\s]context',
  'context[_\\s]size',
  'too[_\\s]many[_\\s]tokens',
  'token[_\\s]limit',
  'prompt[_\\s](?:is[_\\s])?too[_\\s]long',
  'input[_\\s](?:is[_\\s])?too[_\\s]long',
  'request[_\\s]exceeds',
  'exceeds[_\\s]the[_\\s](?:model|maximum)',
  'reduce[_\\s]the[_\\s](?:length|number[_\\s]of[_\\s]tokens)',
  'longer[_\\s]than[_\\s]the[_\\s]model',
].join('|'), 'i');

/** Is this the "your request is bigger than the context window" error? */
export function isContextLengthError(status, body) {
  return CONTEXT_LENGTH_RE.test(String(body ?? ''));
}

const TOOL_MENTION_RE = /tool[\s_-]*calls?/i;
const PARSE_FAILURE_RE = /failed to parse|parse[ _-]?error|parsing error|json\.exception|json ?decode|invalid json|not valid json/i;
/** Signatures of a JSON document that simply stops in the middle. */
const CUT_OFF_RE = /missing closing quote|unterminated string|unexpected end of (?:json )?input|eof while parsing|unexpected end of document/i;

/**
 * Classify an error body from the server.
 * @returns {?string} TOOL_CALL_PARSE_ERROR, or null for "nothing special".
 */
export function classifyApiError(status, body) {
  const text = String(body ?? '');
  if (!text) return null;
  const parseFailure = PARSE_FAILURE_RE.test(text);
  const cutOff = CUT_OFF_RE.test(text);
  // A parse failure that names tool calls is unambiguous; without that name,
  // demand both a 5xx and the truncated-string signature, so a 400 about our
  // own malformed request body is not mistaken for one.
  if (TOOL_MENTION_RE.test(text) && (parseFailure || cutOff)) return TOOL_CALL_PARSE_ERROR;
  if (Number(status) >= 500 && parseFailure && cutOff) return TOOL_CALL_PARSE_ERROR;
  // "This conversation does not fit" is its own thing: compacting helps, and
  // telling the model to make a smaller tool call does not.
  if (isContextLengthError(status, text)) return CONTEXT_LENGTH_ERROR;
  return null;
}

/**
 * The gist of a server error body, for a terminal: the `error.message` field
 * when the body is JSON, with llama.cpp's "last read:" tail dropped — that
 * tail is the entire broken tool call echoed back, kilobytes of the user's own
 * source file, and it tells nobody anything the first sentence did not.
 */
export function serverErrorSummary(body, limit = 240) {
  let text = String(body ?? '').trim();
  if (!text) return '';
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const data = JSON.parse(text);
      const err = data?.error ?? data?.message ?? null;
      const msg = typeof err === 'string' ? err : err?.message;
      if (typeof msg === 'string' && msg.trim()) text = msg;
    } catch {
      /* not JSON after all — keep the raw body */
    }
  }
  text = text.split(/;?\s*last read:/i)[0].replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Marker on the recovery instruction, so tests and mocks can key on it. */
export const OVERSIZED_TOOL_CALL_TAG = '[tool call too large]';

/** Reduce the generated-reply cap after a server rejects a truncated tool call. */
export function smallerReplyTokenLimit(maxTokens) {
  const current = Math.max(256, Math.floor(Number(maxTokens) || 0));
  return Math.max(256, Math.floor(current / 2));
}

/**
 * What to tell the model after the server threw its cut-off tool call away.
 * Both loops (agent and subagent) recover the same way, and the text is only
 * meaningful next to the error it answers, so it lives here rather than in a
 * prompt module neither of them would share.
 *
 * `maxTokens` is the cap that was in force for the rejected reply. On recovery,
 * callers pass the smaller cap for the next reply too. The character budget is
 * deliberately pessimistic (~3 chars per token): a call comfortably under the
 * limit is worth more than one that fits exactly.
 */
export function oversizedToolCallNudge(maxTokens, retryMaxTokens = null) {
  const limit = Math.max(1, Math.round(Number(maxTokens) || 0));
  const retryLimit = retryMaxTokens == null ? limit : Math.max(256, Math.round(Number(retryMaxTokens) || 0));
  const budget = Math.max(1, Math.floor((retryLimit * 3) / 1000));
  return [
    `[system] ${OVERSIZED_TOOL_CALL_TAG} The server rejected your last reply: the tool call ran past the ${limit}-token reply limit, its arguments were cut off mid-JSON, and the whole reply was discarded. Nothing ran and nothing was written.`,
    `The next reply is capped at ${retryLimit} tokens. Do not re-issue that call as it was — keep the whole reply, arguments included, well under roughly ${budget}k characters.`,
    'For a large file: call write_file with the first section only, wait for its result, then make one edit_file per following section in a separate reply (old_text = the last lines you just wrote, new_text = those lines plus the next section). Do not batch section writes in one reply; all its tool calls share one token budget.',
    'For a change to an existing file: use targeted edit_file calls, never a full rewrite.',
  ].join('\n');
}

/** Backoff before attempt N: honor Retry-After (capped), else a short linear ramp. */
function backoffMs(res, attempt) {
  const ra = res ? Number(res.headers.get('retry-after')) : NaN;
  if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 8000);
  return Math.min(600 * attempt, 3000);
}

/* ------------------------------------------------------------------ */
/* Token estimation, calibrated against the server                     */
/* ------------------------------------------------------------------ */

/* chars/4 is a guess that is wrong in a different direction for every
 * tokenizer, language and code style — and every request already comes back
 * with the true prompt size in `usage.prompt_tokens`. Instead of shipping a
 * BPE vocabulary (megabytes, for a harness whose selling point is zero
 * dependencies), the raw guess is fitted to the numbers the server reports:
 *
 *   reported ≈ scale · raw + offset
 *
 * `scale` absorbs the per-character error of the guess, `offset` absorbs the
 * fixed per-request cost the raw guess cannot see at all — chat-template
 * scaffolding and, above all, the JSON schemas of the tools, which are sent
 * with every request and are worth hundreds of tokens.
 *
 * Until enough samples exist the fit is the identity, so an uncalibrated
 * session behaves exactly as before.
 */

/** How many (raw, reported) pairs the fit is based on. */
const MAX_SAMPLES = 24;
/* Sanity bounds. The lower bound on scale is 1 on purpose: calibration may
 * only ever revise the estimate upward. chars/4 already ignores the tool
 * schemas and the chat template, and under-counting is the dangerous
 * direction — it compacts too late and the request overflows — while
 * over-counting merely compacts early. It also means a server that reports
 * nonsense can never shrink our estimate below the old behaviour. */
const MIN_SCALE = 1;
const MAX_SCALE = 3;
const MAX_OFFSET = 8000;
/** Below this spread in prompt sizes, scale and offset cannot be separated. */
const MIN_SPREAD = 0.02;
/* A sample this far from the guess is not a tokenizer difference, it is a
 * server reporting something else (a constant, a cached-token count, a
 * different unit). Those are dropped rather than fitted. */
const MIN_PLAUSIBLE_RATIO = 0.25;
const MAX_PLAUSIBLE_RATIO = 8;

const samples = [];
let fit = { scale: 1, offset: 0, samples: 0 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The uncalibrated chars/4 guess. Exported for the calibration tests. */
export function rawEstimateTokens(messages) {
  let n = 0;
  for (const m of messages) {
    n += 4;
    if (typeof m.content === 'string') n += Math.ceil(m.content.length / 4);
    if (m.tool_calls) n += Math.ceil(JSON.stringify(m.tool_calls).length / 4);
  }
  return n;
}

/** Ordinary least squares through the samples, with the degenerate cases handled. */
function refit() {
  const n = samples.length;
  if (!n) return { scale: 1, offset: 0, samples: 0 };
  const mx = samples.reduce((s, p) => s + p[0], 0) / n;
  const my = samples.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of samples) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
  }
  // One sample, or a session whose prompts are all the same size: a line
  // through two unknowns is not determined, so fit a pure ratio instead.
  if (n < 3 || sxx < (mx * MIN_SPREAD) ** 2) {
    return { scale: clamp(mx > 0 ? my / mx : 1, MIN_SCALE, MAX_SCALE), offset: 0, samples: n };
  }
  const scale = clamp(sxy / sxx, MIN_SCALE, MAX_SCALE);
  return { scale, offset: clamp(my - scale * mx, 0, MAX_OFFSET), samples: n };
}

/**
 * Record what the server actually charged for a prompt we estimated.
 * `messages` must be exactly what was sent, `reported` the server's
 * prompt_tokens. Ignored when either is unusable.
 */
export function calibrateTokens(messages, reported) {
  const raw = rawEstimateTokens(messages || []);
  const actual = Number(reported);
  if (!(raw > 0) || !Number.isFinite(actual) || actual <= 0) return fit;
  const ratio = actual / raw;
  if (ratio < MIN_PLAUSIBLE_RATIO || ratio > MAX_PLAUSIBLE_RATIO) return fit;
  samples.push([raw, actual]);
  if (samples.length > MAX_SAMPLES) samples.shift();
  fit = refit();
  return fit;
}

/** The current fit: { scale, offset, samples }. */
export function tokenCalibration() {
  return { ...fit };
}

/** Forget every sample (new session, new model, tests). */
export function resetTokenCalibration() {
  samples.length = 0;
  fit = { scale: 1, offset: 0, samples: 0 };
}

/**
 * Size of a set of messages in tokens — the per-message cost only, so subsets
 * of a conversation can be added up without counting the per-request overhead
 * several times. Use estimatePromptTokens() for "how big is this request".
 */
export function estimateTokens(messages) {
  const raw = rawEstimateTokens(messages);
  return raw > 0 ? Math.ceil(raw * fit.scale) : 0;
}

/** Size of a whole request: the messages plus the fixed per-request overhead. */
export function estimatePromptTokens(messages) {
  const n = estimateTokens(messages);
  return n > 0 ? n + Math.round(fit.offset) : 0;
}

/**
 * Error for a non-2xx response. `kind` is TOOL_CALL_PARSE_ERROR when the
 * server threw away the model's own reply (see above) and null otherwise;
 * callers branch on it instead of grepping the message.
 */
function apiError(url, status, statusText, body) {
  const kind = classifyApiError(status, body);
  const summary = serverErrorSummary(body);
  const err = new Error(
    kind === TOOL_CALL_PARSE_ERROR
      ? `the server discarded the model's reply (HTTP ${status}): the tool call it generated was cut off before its arguments were complete JSON, so nothing was executed — ${summary}`
      : `API error ${status} ${statusText} from ${url}: ${summary}`
  );
  err.kind = kind;
  err.status = status;
  return err;
}

/** Same classification for an error delivered inside the SSE stream. */
function streamError(payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const status = Number(payload?.code ?? payload?.status ?? payload?.error?.code) || 500;
  const kind = classifyApiError(status, body);
  const err = new Error(
    kind === TOOL_CALL_PARSE_ERROR
      ? `the server discarded the model's reply mid-stream: the tool call it generated was cut off before its arguments were complete JSON, so nothing was executed — ${serverErrorSummary(body)}`
      : `stream error: ${serverErrorSummary(body, 500)}`
  );
  err.kind = kind;
  err.status = status;
  return err;
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
 * never duplicated. A 5xx that is really the server rejecting the model's own
 * cut-off tool call is not transient and is thrown straight away, tagged with
 * `err.kind === TOOL_CALL_PARSE_ERROR` for the caller to recover from.
 */
export async function chatCompletion({ config, messages, tools = [], maxTokens = 4096, onDelta, signal }) {
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
      return await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (e) {
      // An abort is the caller cancelling (Ctrl+C), not a network failure:
      // it must pass through untouched, not read like "cannot reach".
      if (e?.name === 'AbortError' || signal?.aborted) throw e;
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
      // An abort is a cancellation, not a transient failure: no backoff, no retry.
      if (e?.name === 'AbortError' || signal?.aborted) throw e;
      // cannot reach the server at all — transient by nature
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(null, attempt));
        continue;
      }
      throw e;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = apiError(url, res.status, res.statusText, text);
      // A reply the server itself could not parse is deterministic: retrying
      // spends another full generation to arrive at the same 500.
      if (!err.kind && RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(res, attempt));
        continue;
      }
      throw err;
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
      if (e?.name === 'AbortError' || signal?.aborted) throw e;
      if (!e?.kind && !state.emitted && attempt < MAX_ATTEMPTS) {
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
      if (chunk?.error) throw streamError(chunk.error);
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

