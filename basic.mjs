#!/usr/bin/env node
/**
 * basic.mjs — tiny two-mode coding agent.
 *
 *   node basic.mjs              interactive
 *   node basic.mjs --once "…"   one shot (plan then implement)
 *
 * Modes
 *   plan      — analysis only. The project is READ-ONLY: write_file/edit_file
 *               refuse any path outside the plan directory and run_command
 *               only accepts read-only commands. The agent asks questions if
 *               unclear, then writes an IMPLEMENT PROMPT, which is saved to a
 *               plan file (a tmp directory, see planDir) instead of the project.
 *   implement — the only mode that changes project files. Its user prompt is
 *               the saved plan file; there is no extra system prompt.
 *
 * Context
 *   Once the conversation is estimated at >= 90% of contextSize, compact mode
 *   switches on: every request is sent with older tool results and reasoning
 *   trimmed, and the user is told to run /compact for a real summary.
 *
 * Config (optional JSON, --config path or BASIC_CONFIG):
 *   { openai: { baseURL, apiKey, model }, maxTokens: 4096, contextSize: 64000,
 *     workspace, planDir: "<os tmp>/basic-plans", planAllowCommands: ["make"],
 *     mcp: { servers: {
 *       name: { command, args?, env? }           // stdio
 *       name: { type: "http", url, headers? }    // HTTP
 *   } } }
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { calibrateTokens, classifyApiError, estimatePromptTokens, serverErrorSummary, smallerReplyTokenLimit, TOOL_CALL_PARSE_ERROR } from './lib/llm.js';
import { isReadOnlyCommand } from './lib/plan.js';
import { fmtDuration, s, spinner } from './lib/ui.js';

const OPENAI = {
  baseURL: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  apiKey: process.env.OPENAI_API_KEY || '',
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
};

let maxTokens = 4096;
let contextSize = 64000;
const MAX_TOOL_CALL_RETRIES = 3;
/** Estimated request size (as % of contextSize) that switches compact mode on. */
const COMPACT_AT_PERCENT = 90;
let contextWarned = false;
/** On above COMPACT_AT_PERCENT: requests go out with older tool output trimmed. */
let compactMode = false;

let workspace = process.cwd();
let mcp = emptyMcp();

/** 'plan' (read-only analysis) or 'implement' (the only mode that writes). */
let mode = 'plan';
/** Where PLAN mode is allowed to write: the saved plans and any working notes. */
let planDir = path.join(os.tmpdir(), 'basic-plans');
/** Extra commands PLAN mode may run (config planAllowCommands). */
let planAllowCommands = [];
/** /verbose: show full tool arguments and results instead of the compact preview. */
let verbose = process.env.BASIC_VERBOSE === '1';

function emptyMcp() {
  return { listTools: () => [], has: () => false, call: async () => '', closeAll() {} };
}

/* ----------------------------- files / shell ----------------------------- */

function resolvePath(p) {
  if (!p) throw new Error('path required');
  const abs = path.isAbsolute(p) ? p : path.join(workspace, p);
  return path.normalize(abs);
}

function isInside(dir, abs) {
  const rel = path.relative(path.resolve(dir), path.resolve(abs));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/* PLAN mode is enforced here, not just asked for in the prompt: a tool that
 * would change the project refuses before touching the disk, and the refusal
 * comes back as a tool result the model can read and act on. The only
 * writable place is planDir, so the plan (and any working notes) can still be
 * persisted. */
const PLAN_READ_ONLY = 'PLAN mode is read-only';

function guardWrite(abs) {
  if (mode !== 'plan' || isInside(planDir, abs)) return;
  throw new Error(
    `${PLAN_READ_ONLY}: ${abs} was not written. Project files change only in IMPLEMENT mode. ` +
    `Keep plans and working notes under ${planDir}, and finish with the IMPLEMENT PROMPT block.`
  );
}

function guardCommand(command) {
  if (mode !== 'plan') return;
  const verdict = isReadOnlyCommand(command, planAllowCommands);
  if (verdict.ok) return;
  throw new Error(
    `${PLAN_READ_ONLY}: \`${String(command ?? '').trim()}\` was not run (${verdict.reason}). ` +
    'Only read-only commands run in PLAN mode (ls, cat, grep, find, git status/log/diff, …); anything that changes the project waits for IMPLEMENT mode.'
  );
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
      guardWrite(abs);
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
      guardWrite(abs);
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
      guardCommand(command);
      return await runShell(command, timeout_sec || 60);
    },
  },
};

/** Tool descriptions carry the current mode's rules, so the model is told, not just refused. */
const MODE_NOTES = {
  plan: {
    write_file: () => ` PLAN mode: only paths under ${planDir} may be written (plans, working notes). Project files are read-only until IMPLEMENT mode.`,
    edit_file: () => ` PLAN mode: only files under ${planDir} may be edited. Project files are read-only until IMPLEMENT mode.`,
    run_command: () => ' PLAN mode: read-only commands only (ls, cat, grep, find, git status/log/diff, …); builds, installs and anything writing files are refused.',
  },
  implement: {},
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
  const notes = MODE_NOTES[mode] || {};
  const list = Object.entries(BUILTIN).map(([name, t]) => ({
    type: 'function',
    function: { name, description: t.description + (notes[name] ? notes[name]() : ''), parameters: t.parameters },
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

/**
 * Switch compact mode on (or off again) from the size of the conversation, and
 * tell the user once per crossing. Compact mode is a stopgap: it trims what
 * each request carries (see optimizePrompt) so work can continue, but only
 * /compact actually frees the history.
 */
function noteContext(messages) {
  const { used, percent } = contextUsage(messages);
  if (percent < COMPACT_AT_PERCENT) { contextWarned = false; compactMode = false; return; }
  compactMode = true;
  if (contextWarned) return;
  contextWarned = true;
  const trimmed = estimatePromptTokens(optimizePrompt(messages));
  console.log(
    `\n${tag('context', s.yellow)} ~${fmtTokens(used)} of ${fmtTokens(contextSize)} tokens ` +
    `${s.bold(`(${percent}%)`)} — ${s.bold('compact mode on')}: older tool results and reasoning are ` +
    `trimmed from each request (this one ~${fmtTokens(trimmed)}). ` +
    `Please run ${s.cyan('/compact')} to summarize the conversation and free space for good.`
  );
}

/** Older tool results are cut to this many characters in compact mode. */
const COMPACT_STUB_CHARS = 240;
/** Tool results of the latest step keep this much when the first pass is not enough. */
const COMPACT_RECENT_CHARS = 2000;

function trimToolResult(m, keep) {
  const text = String(m.content ?? '');
  if (text.length <= keep + 80) return m;
  return {
    ...m,
    content: `${text.slice(0, keep)}\n…[compact mode: ${text.length - keep} more chars of this tool result were trimmed from the request; re-run the tool if they matter]`,
  };
}

/**
 * The request to send when compact mode is on. The history itself is never
 * changed — only the copy that goes over the wire:
 *   1. Everything before the latest step (the last assistant message and its
 *      tool results) loses reasoning fields and has tool results cut to a stub.
 *      The system message and the first user message (the task) stay intact.
 *   2. If that is still over the line, the latest step's tool results are cut
 *      too, more generously, so the model keeps what it just asked for.
 */
function optimizePrompt(messages) {
  let latest = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { latest = i; break; }
  }
  const firstUser = messages.findIndex((m) => m.role === 'user');
  const pass1 = messages.map((m, i) => {
    if (i >= latest || m.role === 'system' || i === firstUser) return m;
    if (m.role === 'tool') return trimToolResult(m, COMPACT_STUB_CHARS);
    if (m.role === 'assistant' && (m.reasoning !== undefined || m.reasoning_content !== undefined)) {
      const { reasoning, reasoning_content, ...rest } = m; // eslint-disable-line no-unused-vars
      return rest;
    }
    return m;
  });
  if (contextUsage(pass1).percent < COMPACT_AT_PERCENT) return pass1;
  return pass1.map((m, i) => (i >= latest && m.role === 'tool' ? trimToolResult(m, COMPACT_RECENT_CHARS) : m));
}

// Keep labels on their own lines while writing tokens immediately.
// One colour per label, so a long transcript stays scannable: reasoning is
// dim, the answer is plain, tools are cyan (yellow when they change files).
// lib/ui.js turns every one of these into a no-op when colours are off.
const tag = (text, paint = s.bold) => paint(`[${text}]`);
const SECTIONS = {
  thinking: { tag: tag('thinking', s.magenta), text: s.dim },
  response: { tag: tag('response', s.green), text: (t) => t },
};
/** Tools that can change the project — the colour warns before the arguments scroll past. */
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'run_command']);

/* Compact tool display. The model always gets the full result (up to the
 * 20000-char cap); the console shows enough to follow along — a one-line
 * summary of the arguments, the first lines of the result and a count of what
 * was left out. /verbose shows everything. */
const ARGS_PREVIEW_CHARS = 200;
const ARG_VALUE_CHARS = 80;
const RESULT_PREVIEW_LINES = 8;
const RESULT_PREVIEW_COLS = 160;

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** `{"path":"a.js","content":"<first 40 chars>… (2345 chars, 61 lines)"}` */
function summarizeArgs(raw) {
  const text = raw || '{}';
  if (verbose) return text;
  let args;
  try { args = JSON.parse(text); } catch { return clip(text.replace(/\s*\n\s*/g, ' '), ARGS_PREVIEW_CHARS); }
  if (!args || typeof args !== 'object') return clip(text, ARGS_PREVIEW_CHARS);
  const compact = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v !== 'string' || v.length <= ARG_VALUE_CHARS) { compact[k] = v; continue; }
    const lines = v.split('\n').length;
    compact[k] = `${v.slice(0, 40).replace(/\n/g, '⏎')}… (${v.length} chars${lines > 1 ? `, ${lines} lines` : ''})`;
  }
  return clip(JSON.stringify(compact), ARGS_PREVIEW_CHARS);
}

/** First lines of a tool result, each clipped, plus how much was omitted. */
function previewResult(content, { truncatedFrom = 0 } = {}) {
  const text = String(content);
  const note = truncatedFrom ? s.dim(`(result truncated to ${text.length} chars for the model, ${truncatedFrom} total)`) : '';
  if (verbose) return [text, note].filter(Boolean).join('\n');
  const lines = text.split('\n');
  const shown = lines.slice(0, RESULT_PREVIEW_LINES).map((l) => `  ${clip(l, RESULT_PREVIEW_COLS)}`);
  const more = lines.length - RESULT_PREVIEW_LINES;
  if (more > 0) shown.push(s.dim(`  … +${more} more lines (${text.length} chars; the model gets the full result, /verbose shows it)`));
  if (note) shown.push(`  ${note}`);
  return shown.join('\n');
}

function consoleStream() {
  let section = null;
  let newline = true;
  return {
    write(label, text) {
      if (!text) return;
      const style = SECTIONS[label];
      if (section !== label) {
        if (!newline) process.stdout.write('\n');
        process.stdout.write(`${style?.tag || tag(label)}\n`);
        section = label;
      }
      process.stdout.write(style?.text ? style.text(text) : text);
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
      // Tool-call arguments stream silently; keep the indicator honest about it.
      if (calls.size && waiting.update) {
        const names = [...calls.values()].map((c) => c.function.name).filter(Boolean);
        waiting.update(`composing tool call${names.length > 1 ? 's' : ''} ${names.join(', ') || '…'}…`);
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
  // Compact mode never edits the history, only what this request carries.
  const outbound = compactMode ? optimizePrompt(messages) : messages;
  if (outbound !== messages && !quiet) {
    const before = estimatePromptTokens(messages);
    const after = estimatePromptTokens(outbound);
    if (after < before) console.log(s.dim(`    · compact mode: request trimmed ~${fmtTokens(before)} → ~${fmtTokens(after)} tokens`));
  }
  const body = {
    model: OPENAI.model,
    messages: outbound,
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
  return await readChatResponse(res, waiting, { quiet, sent: outbound });
}

async function runTool(name, args) {
  if (BUILTIN[name]) return await BUILTIN[name].run(args || {});
  if (mcp.has(name)) return await mcp.call(name, args || {});
  throw new Error(`unknown tool ${name}`);
}

const planSystem = () => `You are in PLAN mode. You analyse and plan; you do not implement anything.
The project is READ-ONLY in this mode and the tools enforce it:
- write_file and edit_file refuse every path outside ${planDir}. Use that directory for working notes if you need them.
- run_command only runs read-only commands (ls, cat, grep, find, git status/log/diff, …). Builds, installs and anything that writes files are refused.
Inspect the workspace with read_file and read-only commands until you understand the task.
The user describes a coding task. If anything important is missing, ask short questions.
When you have enough, output ONLY a prompt the implement agent will receive as its user message.
That prompt must contain: goal, files to touch, steps, constraints, how to verify.
Wrap it exactly like this:

IMPLEMENT PROMPT
---
<the full prompt>
---

The block is saved to a plan file under ${planDir}; IMPLEMENT mode runs from that file and is the only mode that changes project files.
No other work.`;

/** One line at the end of a turn, so it is obvious the agent is idle again. */
function turnSummary(stats, startedAt) {
  const bits = [`${stats.steps} step${stats.steps === 1 ? '' : 's'}`];
  if (stats.calls) {
    const detail = [];
    if (stats.writes) detail.push(`${stats.writes} file write${stats.writes === 1 ? '' : 's'}`);
    if (stats.commands) detail.push(`${stats.commands} command${stats.commands === 1 ? '' : 's'}`);
    if (stats.blocked) detail.push(`${stats.blocked} blocked by PLAN mode`);
    if (stats.failed) detail.push(`${stats.failed} failed`);
    bits.push(`${stats.calls} tool call${stats.calls === 1 ? '' : 's'}${detail.length ? ` (${detail.join(', ')})` : ''}`);
  }
  bits.push(fmtDuration(Date.now() - startedAt));
  return `${tag('done', s.green)} ${s.dim(bits.join(' · '))}`;
}

async function loop(messages, { maxSteps = 40, tools = true } = {}) {
  let replyLimit = maxTokens;
  const startedAt = Date.now();
  const stats = { steps: 0, calls: 0, writes: 0, commands: 0, blocked: 0, failed: 0 };
  for (let i = 0; i < maxSteps; i++) {
    stats.steps = i + 1;
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
        console.error(`${tag(`retry ${retries + 1}/${MAX_TOOL_CALL_RETRIES}`, s.yellow)} ${e.message}\n${s.dim(`Requesting one smaller tool call (max ${replyLimit} tokens); no tools from the rejected reply ran.`)}`);
        messages.push({ role: 'user', content: toolCallRecovery(replyLimit) });
      }
    }
    messages.push(msg);
    noteContext(messages); // the reply itself can be what pushed us over the line
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      console.log(turnSummary(stats, startedAt));
      return msg.content || '';
    }
    for (const [k, c] of calls.entries()) {
      const name = c.function.name;
      const mutating = MUTATING_TOOLS.has(name);
      const paint = mutating ? s.yellow : s.cyan;
      // Header: what is about to run, how far along the turn is, compact arguments.
      console.log(
        `\n${paint('⚙')} ${tag(name === 'read_file' ? 'read' : 'tool', paint)} ${s.bold(name)} ` +
        `${s.dim(`· step ${i + 1}/${maxSteps} · call ${k + 1}/${calls.length}${mode === 'plan' && mutating ? ' · plan mode: project read-only' : ''}`)}\n` +
        `  ${s.dim(summarizeArgs(c.function.arguments))}`
      );
      const running = spinner(`running ${name}…`);
      let result;
      try {
        const args = JSON.parse(c.function.arguments || '{}');
        result = await runTool(name, args);
      } catch (e) { result = `error: ${e.message}`; }
      finally { running.stop(); }
      const full = String(result);
      const content = full.slice(0, 20000);
      const failed = content.startsWith('error:');
      const blocked = failed && content.includes(PLAN_READ_ONLY);
      stats.calls++;
      if (blocked) stats.blocked++;
      else if (failed) stats.failed++;
      else if (name === 'run_command') stats.commands++;
      else if (mutating) stats.writes++;
      const lines = content ? content.split('\n').length : 0;
      const mark = blocked ? s.yellow('⊘') : failed ? s.red('✗') : s.green('✓');
      const status = blocked ? 'blocked' : failed ? 'failed' : 'ok';
      console.log(
        `${mark} ${tag('tool result', failed ? s.red : s.green)} ${s.bold(name)} ` +
        `${s.dim(`· ${status} · ${fmtDuration(running.elapsedMs())} · ${lines} line${lines === 1 ? '' : 's'}`)}\n` +
        previewResult(content, { truncatedFrom: full.length > content.length ? full.length : 0 })
      );
      messages.push({ role: 'tool', tool_call_id: c.id, content });
    }
  }
  console.log(`${s.dim('(stopped: max steps)')}\n${turnSummary(stats, startedAt)}`);
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
    console.log(s.dim('nothing to compact yet — the conversation is still empty'));
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
    console.log(`${tag('compact', s.red)} compaction failed: ${e.message} — history kept as is`);
    return null;
  }
  spin.stop();
  if (!summary) {
    console.log(s.dim('compaction produced an empty summary — history kept as is'));
    return null;
  }
  const rebuilt = [systemMsg, { role: 'user', content: `${COMPACT_SUMMARY_PREFIX}\n${summary}` }, ...tail];
  const after = estimatePromptTokens(rebuilt);
  if (after >= before) {
    console.log(s.dim(`compacting would not free anything (${fmtTokens(before)} → ${fmtTokens(after)}) — history kept as is`));
    return null;
  }
  history.length = 0;
  history.push(...rebuilt);
  contextWarned = false;
  compactMode = false; // noteContext re-evaluates before the next request
  return { before, after };
}

function extractImplementPrompt(text) {
  const m = String(text || '').match(/IMPLEMENT PROMPT\s*\n---\s*\n([\s\S]*?)\n---/);
  return m ? m[1].trim() : null;
}

/* ------------------------------- plan files ------------------------------ */

/* PLAN mode's deliverable is persisted outside the project: the IMPLEMENT
 * PROMPT goes to a timestamped file under planDir, and IMPLEMENT mode reads
 * its brief from that file. The project itself is untouched until then. */

function savePlan(prompt) {
  fs.mkdirSync(planDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let file = path.join(planDir, `plan-${stamp}.md`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(planDir, `plan-${stamp}-${n}.md`);
  fs.writeFileSync(file, `${String(prompt).trim()}\n`, 'utf8');
  return file;
}

function readPlan(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) throw new Error(`plan file ${file} is empty`);
  return text;
}

/** The whole user message for IMPLEMENT mode: the saved plan, and where it lives. */
function implementPrompt(file) {
  return `IMPLEMENT mode. The plan below was written in PLAN mode and saved at ${file}; it is your complete brief. ` +
    'Carry it out now — project files may be read and modified in this mode. Re-read that file if the plan drops out of context.\n\n' +
    readPlan(file);
}

async function planTurn(history, userText) {
  mode = 'plan';
  history.push({ role: 'user', content: userText });
  const text = await loop(history, { tools: true });
  const prompt = extractImplementPrompt(text);
  const planFile = prompt ? savePlan(prompt) : null;
  return { text, prompt, planFile };
}

async function implementTurn(planFile) {
  // The plan file is the user prompt. No system message.
  const history = [{ role: 'user', content: implementPrompt(planFile) }];
  mode = 'implement';
  try {
    return await loop(history, { tools: true });
  } finally {
    mode = 'plan';
  }
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
  if (cfg.planDir !== undefined) {
    if (typeof cfg.planDir !== 'string' || !cfg.planDir.trim()) throw new Error('config planDir must be a non-empty string');
    planDir = path.resolve(cfg.planDir);
  }
  if (cfg.planAllowCommands !== undefined) {
    if (!Array.isArray(cfg.planAllowCommands)) throw new Error('config planAllowCommands must be an array of strings');
    planAllowCommands = cfg.planAllowCommands.map(String);
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

  /plan [text]       plan mode (default). extra text is context.
  /implement [file]  run the last saved plan (or the given plan file / ad-hoc text)
  /prompt            print the last saved plan and its path
  /compact           summarize the conversation to free context
  /verbose           toggle full tool arguments/results (default: compact preview)
  /tools             list tools
  /quit

Everything goes through plan, then implement.
PLAN mode is analysis only — the project is read-only. write_file/edit_file
refuse any path outside the plan directory and run_command only runs read-only
commands (ls, cat, grep, git status/log/diff, …). When the plan is ready the
IMPLEMENT PROMPT is saved to a plan file under the plan directory
(config planDir, default <os tmp>/basic-plans). IMPLEMENT mode is the only mode
that changes project files; its user prompt is that plan file.
Responses stream live. Console labels: [response], [thinking] (when supplied by
the API), ⚙ [read]/[tool] with a step/call counter and a one-line argument
summary, then ✓/✗/⊘ [tool result] with status, duration and the first lines of
the result (the model always gets the full result, up to 20000 chars).
[done] closes every turn with step/tool counts and elapsed time.
Labels are coloured on a terminal — [thinking] is dim, reads are cyan, tools that
can change files are yellow, failed tool results are red. NO_COLOR turns this
off; FORCE_COLOR=1 turns it on for piped output too.
While work is in progress a live line (thinking…, composing tool call <name>…,
running <tool>…) shows elapsed time; it is erased when the next output starts.
Config maxTokens sets the reply budget (default 4096, minimum 256).
Config contextSize sets the model's context window (default 64000, minimum 2000).
Once the conversation is estimated at 90% of it, compact mode switches on: each
request is sent with older tool results and reasoning trimmed so work can go
on, and you are asked to run /compact, which actually frees the history.
/compact asks the model to summarize the conversation, then keeps the summary
and the newest messages — the originals are dropped, so run it deliberately.
Invalid tool-call JSON is retried up to 3 times with smaller-call instructions.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
  const cfg = loadConfig(opts.config);
  if (opts.dir) workspace = path.resolve(opts.dir);
  mcp = await connectMcp(cfg?.mcp?.servers);

  const planHistory = [{ role: 'system', content: planSystem() }];
  let lastPlanFile = null;

  const savedNote = (file) => `\n${s.green('saved plan')} → ${file} — ${s.dim('/implement to run it')}`;

  async function handle(line) {
    const t = line.trim();
    if (!t) return;
    if (t === '/quit' || t === '/exit') process.exit(0);
    if (t === '/help') { console.log(HELP); return; }
    if (t === '/tools') {
      console.log(openaiTools().map((x) => x.function.name).join(', '));
      return;
    }
    if (t === '/verbose') {
      verbose = !verbose;
      console.log(s.dim(`tool output: ${verbose ? 'verbose (full arguments and results)' : 'compact preview'}`));
      return;
    }
    if (t === '/prompt') {
      if (!lastPlanFile) { console.log(s.dim('(no plan saved yet)')); return; }
      console.log(`${s.dim(`plan file: ${lastPlanFile}`)}\n${readPlan(lastPlanFile)}`);
      return;
    }
    if (t === '/compact') {
      const freed = await compactHistory(planHistory);
      if (freed) console.log(`${tag('compact', s.cyan)} conversation: ${fmtTokens(freed.before)} → ${fmtTokens(freed.after)} tokens`);
      return;
    }
    if (t === '/plan' || t.startsWith('/plan ')) {
      mode = 'plan';
      const rest = t.slice(5).trim();
      console.log(`${tag('plan', s.magenta)} ${s.dim(`project read-only · plans go to ${planDir}`)}`);
      if (!rest) return;
      const { planFile } = await planTurn(planHistory, rest);
      if (planFile) lastPlanFile = planFile;
      if (planFile) console.log(savedNote(planFile));
      return;
    }
    if (t === '/implement' || t.startsWith('/implement ')) {
      const extra = t.slice(10).trim();
      let planFile = lastPlanFile;
      if (extra) {
        // A path to an existing plan file, or ad-hoc text that becomes one.
        const candidate = resolvePath(extra);
        planFile = fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : savePlan(extra);
      }
      if (!planFile) { console.log(s.dim('no plan saved yet — stay in /plan')); return; }
      lastPlanFile = planFile;
      console.log(`${tag('implement', s.cyan)} ${s.dim(`plan: ${planFile}`)}`);
      await implementTurn(planFile);
      console.log(`${tag('plan', s.magenta)} ${s.dim('back to plan — project read-only again')}`);
      return;
    }
    if (mode === 'plan') {
      const { planFile } = await planTurn(planHistory, t);
      if (planFile) lastPlanFile = planFile;
      if (planFile) console.log(savedNote(planFile));
    }
  }

  if (opts.once) {
    const { planFile } = await planTurn(planHistory, opts.once);
    if (!planFile) {
      console.error(s.red('plan did not produce IMPLEMENT PROMPT'));
      process.exitCode = 1;
      mcp.closeAll();
      return;
    }
    lastPlanFile = planFile;
    console.log(savedNote(planFile));
    console.log(`\n${tag('implement', s.cyan)} ${s.dim(`plan: ${planFile}`)}\n`);
    await implementTurn(planFile);
    mcp.closeAll();
    return;
  }

  console.log(`${s.bold('basic.mjs')}  ${s.dim(`model=${OPENAI.model}  dir=${workspace}  mode=plan`)}`);
  console.log(s.dim(`plan mode is read-only; plans are saved under ${planDir}`));
  console.log(`${s.dim('describe the task. agent plans, then')} ${s.cyan('/implement')}${s.dim('.')}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => rl.question(`${s.cyan(`${mode}>`)} `, async (line) => {
    try { await handle(line); }
    catch (e) { console.error(s.red(e.message)); }
    ask();
  });
  rl.on('close', () => { mcp.closeAll(); process.exit(0); });
  ask();
}

main().catch((e) => {
  console.error(s.red(e.stack || String(e))); // stack: unexpected errors need the trail
  process.exit(1);
});
