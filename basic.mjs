#!/usr/bin/env node
/**
 * basic.mjs — tiny two-mode coding agent.
 *
 *   node basic.mjs              interactive
 *   node basic.mjs --once "…"   one shot (plan then implement)
 *
 * Modes
 *   plan      — user gives context. Agent asks questions if unclear, then
 *               writes an IMPLEMENT PROMPT (the whole user message for implement).
 *   implement — runs that prompt with tools. No extra system prompt.
 *
 * Config (optional JSON, --config path or BASIC_CONFIG):
 *   { openai: { baseURL, apiKey, model }, maxTokens: 4096, contextSize: 64000,
 *     workspace, mcp: { servers: {
 *       name: { command, args?, env? }           // stdio
 *       name: { type: "http", url, headers? }    // HTTP
 *   } } }
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { calibrateTokens, classifyApiError, estimatePromptTokens, serverErrorSummary, smallerReplyTokenLimit, TOOL_CALL_PARSE_ERROR } from './lib/llm.js';
import { spinner } from './lib/ui.js';

const OPENAI = {
  baseURL: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  apiKey: process.env.OPENAI_API_KEY || '',
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
};

let maxTokens = 4096;
let contextSize = 64000;
const MAX_TOOL_CALL_RETRIES = 3;
/** Estimated request size (as % of contextSize) that earns a "run /compact" nudge. */
const COMPACT_AT_PERCENT = 90;
let contextWarned = false;

let workspace = process.cwd();
let mcp = emptyMcp();

function emptyMcp() {
  return { listTools: () => [], has: () => false, call: async () => '', closeAll() {} };
}

/* ----------------------------- files / shell ----------------------------- */

function resolvePath(p) {
  if (!p) throw new Error('path required');
  const abs = path.isAbsolute(p) ? p : path.join(workspace, p);
  return path.normalize(abs);
}

const BUILTIN = {
  read_file: {
    description: 'Read a text file. Optional start_line (1-based) and max_lines.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'integer' },
        max_lines: { type: 'integer' },
      },
      required: ['path'],
    },
    async run({ path: p, start_line, max_lines }) {
      const abs = resolvePath(p);
      const text = fs.readFileSync(abs, 'utf8');
      const lines = text.split(/\n/);
      const start = Math.max(1, start_line || 1);
      const take = Math.min(max_lines || 400, 800);
      const slice = lines.slice(start - 1, start - 1 + take);
      const numbered = slice.map((l, i) => `${String(start + i).padStart(4)}|${l}`).join('\n');
      return `file ${abs} (${lines.length} lines)\n${numbered}`;
    },
  },
  write_file: {
    description: 'Create or overwrite a text file. Keep calls small: for large new files write the first section, then append sections using edit_file in separate replies. For existing files prefer targeted edit_file calls.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    async run({ path: p, content }) {
      const abs = resolvePath(p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content ?? '', 'utf8');
      return `wrote ${abs} (${String(content ?? '').length} chars)`;
    },
  },
  edit_file: {
    description: 'Replace old_text with new_text in a file (first match).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
    async run({ path: p, old_text, new_text }) {
      const abs = resolvePath(p);
      const text = fs.readFileSync(abs, 'utf8');
      if (!text.includes(old_text)) throw new Error('old_text not found');
      fs.writeFileSync(abs, text.replace(old_text, () => new_text), 'utf8');
      return `edited ${abs}`;
    },
  },
  run_command: {
    description: 'Run a shell command in the workspace. Optional timeout_sec (default 60).',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_sec: { type: 'number' },
      },
      required: ['command'],
    },
    async run({ command, timeout_sec }) {
      return await runShell(command, timeout_sec || 60);
    },
  },
};

function runShell(command, timeoutSec) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? (process.env.ComSpec || 'cmd.exe') : 'bash', isWin ? ['/d', '/s', '/c', command] : ['-c', command], {
      cwd: workspace,
      env: process.env,
      windowsHide: true,
    });
    let out = '';
    const add = (d) => {
      out += d;
      if (out.length > 80_000) out = out.slice(-80_000);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const t = setTimeout(() => {
      child.kill();
      resolve(`(timeout ${timeoutSec}s)\n${out}`);
    }, timeoutSec * 1000);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve(`exit ${code}\n${out}`.trimEnd());
    });
    child.on('error', (e) => {
      clearTimeout(t);
      resolve(`error: ${e.message}`);
    });
  });
}

/* --------------------------------- MCP --------------------------------- */

class StdioRpc {
  constructor(name, { command, args = [], env = {} }) {
    this.name = name;
    this._id = 0;
    this._pending = new Map();
    this._buf = '';
    this.child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      this._buf += d;
      let i;
      while ((i = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, i).trim();
        this._buf = this._buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = this._pending.get(msg.id);
        if (!p) continue;
        this._pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    });
    this.child.on('exit', () => {
      for (const [, p] of this._pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`mcp ${this.name} exited`));
      }
      this._pending.clear();
    });
  }
  request(method, params = {}, timeoutMs = 30000) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`mcp ${this.name} ${method} timeout`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method, params = {}) {
    try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch { /* */ }
  }
  close() { try { this.child.kill(); } catch { /* */ } }
}

class HttpRpc {
  constructor(name, cfg) {
    this.name = name;
    this.url = cfg.url || cfg.endpoint;
    this.headers = { Accept: 'application/json, text/event-stream', ...(cfg.headers || {}) };
    this._id = 0;
    this.sessionId = null;
  }
  async request(method, params = {}, timeoutMs = 60000) {
    const id = ++this._id;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { ...this.headers, 'Content-Type': 'application/json' };
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      const res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      const type = res.headers.get('content-type') || '';
      let msg;
      if (type.includes('text/event-stream') && res.body) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          buf += dec.decode(value || new Uint8Array(), { stream: !done });
          const events = buf.split(/\r?\n\r?\n/);
          buf = events.pop() || '';
          for (const ev of events) {
            const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
            if (!data || data === '[DONE]') continue;
            try {
              const m = JSON.parse(data);
              if (m.id === id || m.id === String(id)) { await reader.cancel(); msg = m; break; }
            } catch { /* */ }
          }
          if (msg || done) break;
        }
      } else {
        msg = await res.json();
      }
      if (!msg) throw new Error(`mcp ${this.name} empty`);
      if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
      return msg.result;
    } finally { clearTimeout(timer); }
  }
  notify(method, params = {}) {
    const headers = { ...this.headers, 'Content-Type': 'application/json' };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    fetch(this.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method, params }) }).catch(() => {});
  }
  close() {}
}

async function connectMcp(servers, log = console.error) {
  const registry = new Map();
  const clients = [];
  for (const [name, cfg] of Object.entries(servers || {})) {
    const http = Boolean(cfg && (cfg.type === 'http' || cfg.transport === 'http' || cfg.url || cfg.endpoint));
    if (!cfg || (http ? !(cfg.url || cfg.endpoint) : !cfg.command)) {
      log(`mcp skip ${name}: missing ${http ? 'url' : 'command'}`);
      continue;
    }
    let client;
    try {
      client = http ? new HttpRpc(name, cfg) : new StdioRpc(name, cfg);
      await client.request('initialize', {
        protocolVersion: cfg.protocolVersion || '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'basic', version: '0.1.0' },
      });
      client.notify('notifications/initialized');
      const listed = await client.request('tools/list', {});
      for (const t of listed?.tools || []) {
        const q = (`mcp_${name}_${t.name}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        registry.set(q, { name: t.name, client, description: t.description || t.name, schema: t.inputSchema || { type: 'object' } });
      }
      clients.push(client);
      log(`mcp ${name}: ${(listed?.tools || []).length} tool(s)`);
    } catch (e) {
      client?.close();
      log(`mcp ${name} failed: ${e.message}`);
    }
  }
  return {
    listTools: () => [...registry.entries()].map(([n, e]) => ({
      name: n,
      description: e.description,
      parameters: e.schema,
    })),
    has: (n) => registry.has(n),
    async call(n, args) {
      const e = registry.get(n);
      if (!e) throw new Error(`unknown mcp tool ${n}`);
      const res = await e.client.request('tools/call', { name: e.name, arguments: args || {} }, 120000);
      const text = (res?.content || []).map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
      return res?.isError ? `Error: ${text}` : (text || '(no content)');
    },
    closeAll() { for (const c of clients) c.close(); },
  };
}

/* ------------------------------ LLM + tools ------------------------------ */

function openaiTools() {
  const list = Object.entries(BUILTIN).map(([name, t]) => ({
    type: 'function',
    function: { name, description: t.description, parameters: t.parameters },
  }));
  for (const t of mcp.listTools()) {
    list.push({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    });
  }
  return list;
}

function fmtTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * How full the context window would be for the request we are about to send.
 * Estimates are calibrated against the prompt_tokens servers report, so the
 * number tracks the real tokenizer instead of raw chars/4.
 */
function contextUsage(messages) {
  const used = estimatePromptTokens(messages);
  return { used, percent: Math.round((used / Math.max(1, contextSize)) * 100) };
}

/** Tell the user to compact before an oversized request, once per crossing. */
function noteContext(messages) {
  const { used, percent } = contextUsage(messages);
  if (percent < COMPACT_AT_PERCENT) { contextWarned = false; return; }
  if (contextWarned) return;
  contextWarned = true;
  console.log(
    `\n[context] ~${fmtTokens(used)} of ${fmtTokens(contextSize)} tokens (${percent}%) — ` +
    'run /compact to summarize the conversation and free space, or the request may be rejected.'
  );
}

// Keep labels on their own lines while writing tokens immediately.
function consoleStream() {
  let section = null;
  let newline = true;
  return {
    write(label, text) {
      if (!text) return;
      if (section !== label) {
        if (!newline) process.stdout.write('\n');
        process.stdout.write(`[${label}]\n`);
        section = label;
      }
      process.stdout.write(text);
      newline = text.endsWith('\n');
    },
    end() { if (!newline) process.stdout.write('\n'); },
  };
}

// SSE frames and UTF-8 characters can both span network chunks.
async function* streamEvents(body) {
  if (!body) throw new Error('LLM returned an empty stream');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const dataOf = (event) => event.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const data = dataOf(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (data) yield data;
      }
      if (done) {
        const data = dataOf(buffer);
        if (data) yield data;
        break;
      }
    }
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

function llmError(payload, status = 500) {
  const body = typeof payload === 'string' ? payload : JSON.stringify({ error: payload });
  const error = new Error(`LLM error (${status}): ${serverErrorSummary(body)}`);
  error.kind = classifyApiError(status, body);
  return error;
}

function invalidToolCall(reason) {
  const error = new Error(`Invalid or incomplete tool call: ${reason}. No tools from this reply were executed.`);
  error.kind = TOOL_CALL_PARSE_ERROR;
  return error;
}

// Validate the ENTIRE batch before adding history or executing any tools.
function validateToolCalls(msg) {
  for (const call of msg.tool_calls || []) {
    if (!call.id || !call.function?.name) throw invalidToolCall('missing id or name');
    let args;
    try { args = JSON.parse(call.function.arguments); }
    catch { throw invalidToolCall('arguments are not complete JSON'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw invalidToolCall('arguments must be a JSON object');
    }
  }
  return msg;
}

function toolCallRecovery(limit) {
  return `[tool call recovery] Your previous reply contained invalid or incomplete tool-call JSON and was discarded. No tools from that reply ran and no files were changed by it.
It may have exceeded the output budget. The next reply is limited to ${limit} tokens; keep the entire reply, including all arguments, well below ${Math.floor(limit * 2)} characters. Send only one small tool call per reply, then wait for its result.
For existing files, use targeted edit_file calls rather than rewriting the whole file. For a large new file, write_file only the first section; then append each section in a separate edit_file reply (old_text = unique ending lines, new_text = those lines plus the next section).
Return valid JSON with properly escaped strings and closing quotes/braces. Do not repeat the oversized call.`;
}

// waiting = the "still working" indicator to clear as soon as anything prints,
// so the spinner never fights the streamed text for the same terminal row.
// quiet = no streaming to the console (internal requests such as /compact).
async function readChatResponse(res, waiting, { quiet = false, sent = [] } = {}) {
  const output = quiet ? { write() {}, end() {} } : consoleStream();
  // Feed the server's own prompt_tokens back into the estimator when offered.
  const calibrate = (usage) => { if (usage?.prompt_tokens) calibrateTokens(sent, usage.prompt_tokens); };
  const show = (delta) => {
    const thinking = delta.reasoning_content || delta.reasoning || '';
    const content = delta.content || '';
    if (thinking || content) waiting.stop();
    // Only display reasoning explicitly supplied by the provider.
    output.write('thinking', thinking);
    output.write('response', content);
  };
  try {
    // Some OpenAI-compatible servers ignore stream: true and return JSON.
    if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
      const json = await res.json();
      waiting.stop();
      calibrate(json.usage);
      if (json.error) throw llmError(json.error);
      const msg = json.choices?.[0]?.message;
      if (!msg) throw new Error('LLM returned no message');
      show(msg);
      if (json.choices[0].finish_reason === 'length' && msg.tool_calls?.length) {
        throw invalidToolCall('output token limit reached');
      }
      return validateToolCalls(msg);
    }
    const msg = { role: 'assistant', content: null };
    const calls = new Map();
    let finished = false;
    let finishReason = null;
    for await (const data of streamEvents(res.body)) {
      if (data.trim() === '[DONE]') { finished = true; break; }
      const chunk = JSON.parse(data);
      if (chunk.error) throw llmError(chunk.error);
      calibrate(chunk.usage);
      const choice = chunk.choices?.find((c) => c.index === 0 || c.index === undefined);
      if (!choice) continue; // e.g. usage-only chunks
      const delta = choice.delta || {};
      show(delta);
      for (const field of ['content', 'reasoning_content', 'reasoning']) {
        if (typeof delta[field] === 'string') msg[field] = (msg[field] || '') + delta[field];
      }
      for (const part of delta.tool_calls || []) {
        const index = part.index ?? 0;
        if (!calls.has(index)) calls.set(index, { id: '', type: 'function', function: { name: '', arguments: '' } });
        const call = calls.get(index);
        if (part.id) call.id += part.id;
        if (part.type) call.type = part.type;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
      }
      if (choice.finish_reason) { finished = true; finishReason = choice.finish_reason; }
    }
    if ((!finished || finishReason === 'length') && calls.size) {
      throw invalidToolCall('stream ended before tool calls were complete');
    }
    if (!finished) throw new Error('LLM stream ended before completion');
    if (calls.size) {
      msg.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    }
    return validateToolCalls(msg);
  } finally {
    waiting.stop(); // e.g. error paths and replies with no visible text
    output.end();
  }
}

async function chat(messages, { tools = true, temperature = 0.2, replyLimit = maxTokens, quiet = false } = {}) {
  const body = {
    model: OPENAI.model,
    messages,
    temperature,
    max_tokens: replyLimit,
    stream: true,
  };
  if (tools) {
    const t = openaiTools();
    if (t.length) body.tools = t;
  }
  // Shown from the moment the request goes out until the first token lands,
  // so a slow model never looks like a hung prompt.
  const waiting = quiet ? { stop() {} } : spinner('thinking…');
  let res;
  try {
    res = await fetch(`${OPENAI.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(OPENAI.apiKey ? { Authorization: `Bearer ${OPENAI.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    waiting.stop();
    throw e;
  }
  if (!res.ok) {
    waiting.stop();
    throw llmError(await res.text(), res.status);
  }
  return await readChatResponse(res, waiting, { quiet, sent: messages });
}

async function runTool(name, args) {
  if (BUILTIN[name]) return await BUILTIN[name].run(args || {});
  if (mcp.has(name)) return await mcp.call(name, args || {});
  throw new Error(`unknown tool ${name}`);
}

const PLAN_SYSTEM = `You are in PLAN mode. You do not implement anything.
The user describes a coding task. If anything important is missing, ask short questions.
When you have enough, output ONLY a prompt the implement agent will receive as its user message.
That prompt must contain: goal, files to touch, steps, constraints, how to verify.
Wrap it exactly like this:

IMPLEMENT PROMPT
---
<the full prompt>
---

No other work. No tools needed unless you must inspect the workspace to plan.`;

async function loop(messages, { maxSteps = 40, tools = true } = {}) {
  let replyLimit = maxTokens;
  for (let i = 0; i < maxSteps; i++) {
    noteContext(messages); // nudge before the request, never while a tool runs
    let msg;
    for (let retries = 0; ; retries++) {
      try {
        msg = await chat(messages, { tools, replyLimit });
        break;
      } catch (e) {
        if (e.kind !== TOOL_CALL_PARSE_ERROR) throw e;
        if (retries >= MAX_TOOL_CALL_RETRIES) {
          throw new Error(`Tool call still invalid after ${MAX_TOOL_CALL_RETRIES} smaller-output retries. Stop and request smaller, targeted edits; check the server output limit and config maxTokens. ${e.message}`);
        }
        replyLimit = smallerReplyTokenLimit(replyLimit);
        console.error(`[retry ${retries + 1}/${MAX_TOOL_CALL_RETRIES}] ${e.message}\nRequesting one smaller tool call (max ${replyLimit} tokens); no tools from the rejected reply ran.`);
        messages.push({ role: 'user', content: toolCallRecovery(replyLimit) });
      }
    }
    messages.push(msg);
    noteContext(messages); // the reply itself can be what pushed us over the line
    const calls = msg.tool_calls || [];
    if (!calls.length) return msg.content || '';
    for (const c of calls) {
      const name = c.function.name;
      console.log(`\n[${name === 'read_file' ? 'read' : 'tool'}] ${name}\n${c.function.arguments || '{}'}`);
      const running = spinner(`running ${name}…`);
      let result;
      try {
        const args = JSON.parse(c.function.arguments || '{}');
        result = await runTool(name, args);
      } catch (e) { result = `error: ${e.message}`; }
      finally { running.stop(); }
      const content = String(result).slice(0, 20000);
      console.log(`[tool result] ${name}\n${content}`);
      if (String(result).length > content.length) console.log('(result truncated to 20000 chars)');
      messages.push({ role: 'tool', tool_call_id: c.id, content });
    }
  }
  console.log('(stopped: max steps)');
  return '(stopped: max steps)';
}

const COMPACT_PROMPT = `[compaction request]
Summarize this session so work can continue without the earlier messages.
Include:
- The user's current request (verbatim if it is short).
- Every file inspected or changed, and what changed.
- Commands run and their results, especially failures.
- Decisions, constraints, and anything still pending.
Be concise and factual, short bullet points, no preamble. Do not call tools.`;

const COMPACT_SUMMARY_PREFIX =
  'Earlier in this session (compacted summary — the raw messages were dropped to free context):';

/** Trailing messages that can be replayed verbatim after a compaction. */
function compactTail(messages, keep = 2) {
  const tail = [];
  for (let i = messages.length - 1; i >= 0 && tail.length < keep; i--) {
    const m = messages[i];
    // Never orphan an assistant tool_calls message from its tool results.
    if (m.role === 'tool' || (m.role === 'assistant' && m.tool_calls)) break;
    tail.unshift(m);
  }
  return tail;
}

/**
 * Replace a conversation with a model-written summary plus the freshest
 * messages. Mutates history in place; returns token counts, or null when
 * nothing was freed (the caller keeps the original messages).
 */
async function compactHistory(history) {
  if (history.length <= 2) {
    console.log('nothing to compact yet — the conversation is still empty');
    return null;
  }
  const before = estimatePromptTokens(history);
  const [systemMsg, ...rest] = history;
  const tail = compactTail(rest);
  const spin = spinner('compacting conversation…');
  let summary = '';
  try {
    const msg = await chat([...history, { role: 'user', content: COMPACT_PROMPT }], { tools: false, quiet: true });
    summary = String(msg.content || '').trim();
  } catch (e) {
    spin.stop();
    console.log(`compaction failed: ${e.message} — history kept as is`);
    return null;
  }
  spin.stop();
  if (!summary) {
    console.log('compaction produced an empty summary — history kept as is');
    return null;
  }
  const rebuilt = [systemMsg, { role: 'user', content: `${COMPACT_SUMMARY_PREFIX}\n${summary}` }, ...tail];
  const after = estimatePromptTokens(rebuilt);
  if (after >= before) {
    console.log(`compacting would not free anything (${fmtTokens(before)} → ${fmtTokens(after)}) — history kept as is`);
    return null;
  }
  history.length = 0;
  history.push(...rebuilt);
  contextWarned = false;
  return { before, after };
}

function extractImplementPrompt(text) {
  const m = String(text || '').match(/IMPLEMENT PROMPT\s*\n---\s*\n([\s\S]*?)\n---/);
  return m ? m[1].trim() : null;
}

async function planTurn(history, userText) {
  history.push({ role: 'user', content: userText });
  const text = await loop(history, { tools: true });
  const prompt = extractImplementPrompt(text);
  return { text, prompt };
}

async function implementTurn(prompt) {
  // Everything is the user prompt. No system message.
  const history = [{ role: 'user', content: prompt }];
  return await loop(history, { tools: true });
}

/* --------------------------------- CLI --------------------------------- */

function loadConfig(p) {
  if (!p || !fs.existsSync(p)) return;
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (cfg.openai) Object.assign(OPENAI, cfg.openai);
  if (cfg.workspace) workspace = path.resolve(cfg.workspace);
  if (cfg.maxTokens !== undefined) {
    if (!Number.isInteger(cfg.maxTokens) || cfg.maxTokens < 256) {
      throw new Error('config maxTokens must be an integer >= 256');
    }
    maxTokens = cfg.maxTokens;
  }
  if (cfg.contextSize !== undefined) {
    if (!Number.isInteger(cfg.contextSize) || cfg.contextSize < 2000) {
      throw new Error('config contextSize must be an integer >= 2000');
    }
    contextSize = cfg.contextSize;
  }
  return cfg;
}

function parseArgs(argv) {
  const o = { once: null, config: process.env.BASIC_CONFIG || null, dir: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') o.once = argv[++i];
    else if (a === '--config' || a === '-c') o.config = argv[++i];
    else if (a === '--dir' || a === '-d') o.dir = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const HELP = `basic.mjs — plan then implement.

  node basic.mjs [--config file] [--dir path]
  node basic.mjs --once "task"

  /plan [text]     plan mode (default). extra text is context.
  /implement       run last IMPLEMENT PROMPT
  /prompt          print last IMPLEMENT PROMPT
  /compact         summarize the conversation to free context
  /tools           list tools
  /quit

Everything goes through plan, then implement.
Plan writes an IMPLEMENT PROMPT. Implement uses only that as the user prompt.
Responses stream live. Console labels: [response], [thinking] (when supplied by
the API), [read]/[tool] with arguments, and [tool result] (up to 20000 chars).
While work is in progress a live line (thinking…, running <tool>…) shows elapsed
time; it is erased as soon as the next output starts.
Config maxTokens sets the reply budget (default 4096, minimum 256).
Config contextSize sets the model's context window (default 64000, minimum 2000).
It drives the size estimate shown when the conversation reaches 90% full, which
suggests /compact before the server starts rejecting requests.
/compact asks the model to summarize the conversation, then keeps the summary
and the newest messages — the originals are dropped, so run it deliberately.
Invalid tool-call JSON is retried up to 3 times with smaller-call instructions.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
  const cfg = loadConfig(opts.config);
  if (opts.dir) workspace = path.resolve(opts.dir);
  mcp = await connectMcp(cfg?.mcp?.servers);

  const planHistory = [{ role: 'system', content: PLAN_SYSTEM }];
  let lastPrompt = null;
  let mode = 'plan';

  async function handle(line) {
    const t = line.trim();
    if (!t) return;
    if (t === '/quit' || t === '/exit') process.exit(0);
    if (t === '/help') { console.log(HELP); return; }
    if (t === '/tools') {
      console.log(openaiTools().map((x) => x.function.name).join(', '));
      return;
    }
    if (t === '/prompt') {
      console.log(lastPrompt || '(none yet)');
      return;
    }
    if (t === '/compact') {
      const freed = await compactHistory(planHistory);
      if (freed) console.log(`[compact] conversation: ${fmtTokens(freed.before)} → ${fmtTokens(freed.after)} tokens`);
      return;
    }
    if (t === '/plan' || t.startsWith('/plan ')) {
      mode = 'plan';
      const rest = t.slice(5).trim();
      console.log('[plan]');
      if (!rest) return;
      const { prompt } = await planTurn(planHistory, rest);
      if (prompt) lastPrompt = prompt;
      if (prompt) console.log('\n(saved IMPLEMENT PROMPT — /implement to run)');
      return;
    }
    if (t === '/implement' || t.startsWith('/implement ')) {
      const extra = t.slice(10).trim();
      const prompt = extra || lastPrompt;
      if (!prompt) { console.log('no IMPLEMENT PROMPT yet — stay in /plan'); return; }
      mode = 'implement';
      console.log('[implement]');
      await implementTurn(prompt);
      mode = 'plan';
      console.log('[plan] back to plan');
      return;
    }
    if (mode === 'plan') {
      const { prompt } = await planTurn(planHistory, t);
      if (prompt) lastPrompt = prompt;
      if (prompt) console.log('\n(saved IMPLEMENT PROMPT — /implement to run)');
    }
  }

  if (opts.once) {
    const { prompt } = await planTurn(planHistory, opts.once);
    if (!prompt) {
      console.error('plan did not produce IMPLEMENT PROMPT');
      process.exitCode = 1;
      mcp.closeAll();
      return;
    }
    lastPrompt = prompt;
    console.log('\n[implement]\n');
    await implementTurn(prompt);
    mcp.closeAll();
    return;
  }

  console.log(`basic.mjs  model=${OPENAI.model}  dir=${workspace}  mode=plan`);
  console.log('describe the task. agent plans, then /implement.\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => rl.question(`${mode}> `, async (line) => {
    try { await handle(line); }
    catch (e) { console.error(e.message); }
    ask();
  });
  rl.on('close', () => { mcp.closeAll(); process.exit(0); });
  ask();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
