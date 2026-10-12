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
 *   { openai: { baseURL, apiKey, model }, workspace, mcp: { servers: {
 *       name: { command, args?, env? }           // stdio
 *       name: { type: "http", url, headers? }    // HTTP
 *   } } }
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const OPENAI = {
  baseURL: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  apiKey: process.env.OPENAI_API_KEY || '',
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
};

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
    description: 'Create or overwrite a text file.',
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
      fs.writeFileSync(abs, text.replace(old_text, new_text), 'utf8');
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

async function chat(messages, { tools = true, temperature = 0.2 } = {}) {
  const body = {
    model: OPENAI.model,
    messages,
    temperature,
    max_tokens: 4096,
  };
  if (tools) {
    const t = openaiTools();
    if (t.length) body.tools = t;
  }
  const res = await fetch(`${OPENAI.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(OPENAI.apiKey ? { Authorization: `Bearer ${OPENAI.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json = await res.json();
  return json.choices?.[0]?.message || {};
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
  for (let i = 0; i < maxSteps; i++) {
    const msg = await chat(messages, { tools });
    messages.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) return msg.content || '';
    process.stdout.write(msg.content ? msg.content + '\n' : '');
    for (const c of calls) {
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch { args = {}; }
      process.stderr.write(`  tool ${c.function.name}\n`);
      let result;
      try { result = await runTool(c.function.name, args); }
      catch (e) { result = `error: ${e.message}`; }
      messages.push({ role: 'tool', tool_call_id: c.id, content: String(result).slice(0, 20000) });
    }
  }
  return '(stopped: max steps)';
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
  /tools           list tools
  /quit

Everything goes through plan, then implement.
Plan writes an IMPLEMENT PROMPT. Implement uses only that as the user prompt.`;

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
    if (t === '/plan' || t.startsWith('/plan ')) {
      mode = 'plan';
      const rest = t.slice(5).trim();
      console.log('[plan]');
      if (!rest) return;
      const { text, prompt } = await planTurn(planHistory, rest);
      if (prompt) lastPrompt = prompt;
      console.log(text);
      if (prompt) console.log('\n(saved IMPLEMENT PROMPT — /implement to run)');
      return;
    }
    if (t === '/implement' || t.startsWith('/implement ')) {
      const extra = t.slice(10).trim();
      const prompt = extra || lastPrompt;
      if (!prompt) { console.log('no IMPLEMENT PROMPT yet — stay in /plan'); return; }
      mode = 'implement';
      console.log('[implement]');
      const out = await implementTurn(prompt);
      console.log(out);
      mode = 'plan';
      console.log('[plan] back to plan');
      return;
    }
    if (mode === 'plan') {
      const { text, prompt } = await planTurn(planHistory, t);
      if (prompt) lastPrompt = prompt;
      console.log(text);
      if (prompt) console.log('\n(saved IMPLEMENT PROMPT — /implement to run)');
    }
  }

  if (opts.once) {
    const { text, prompt } = await planTurn(planHistory, opts.once);
    console.log(text);
    if (!prompt) {
      console.error('plan did not produce IMPLEMENT PROMPT');
      process.exitCode = 1;
      mcp.closeAll();
      return;
    }
    lastPrompt = prompt;
    console.log('\n[implement]\n');
    console.log(await implementTurn(prompt));
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
