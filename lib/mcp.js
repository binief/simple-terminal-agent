/* Minimal MCP (Model Context Protocol) stdio client: JSON-RPC 2.0 over ndjson.
   Supports initialize, tools/list and tools/call — enough to expose MCP tools to the model. */

import { spawn } from 'node:child_process';
const HTTP_TIMEOUT_MS = 120000;

function headersFromConfig(cfg) {
  const headers = { ...(cfg.headers || {}) };
  for (const [key, value] of Object.entries(cfg.env || {})) {
    if (key.toLowerCase().startsWith('http-') && value != null) headers[key.slice(5)] = String(value);
  }
  return headers;
}

async function readHttpResponse(response, id) {
  const type = response.headers.get('content-type') || '';
  if (!response.ok && response.status !== 202) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  if (response.status === 202) return undefined;
  if (type.includes('application/json')) return response.json();
  if (!response.body) return undefined;
  if (!type.includes('text/event-stream')) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || '';
    for (const event of events) {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') continue;
      try {
        const message = JSON.parse(data);
        if (message.id === id || message.id === String(id)) { await reader.cancel(); return message; }
      } catch { /* ignore non-JSON SSE events */ }
    }
    if (done) break;
  }
  throw new Error('HTTP MCP stream ended without a response');
}

class HttpRpcClient {
  constructor(name, cfg) {
    this.name = name;
    this.url = cfg.url || cfg.endpoint;
    this.headers = { Accept: 'application/json, text/event-stream', ...headersFromConfig(cfg) };
    this._id = 0;
    this.sessionId = null;
  }
  async _post(message, timeoutMs = HTTP_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { ...this.headers, 'Content-Type': 'application/json' };
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      const response = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(message), signal: controller.signal });
      const session = response.headers.get('mcp-session-id');
      if (session) this.sessionId = session;
      return await readHttpResponse(response, message.id);
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`mcp "${this.name}": HTTP request timed out after ${timeoutMs}ms`);
      throw e;
    } finally { clearTimeout(timer); }
  }
  async request(method, params = {}, timeoutMs = HTTP_TIMEOUT_MS) {
    const id = ++this._id;
    const message = await this._post({ jsonrpc: '2.0', id, method, params }, timeoutMs);
    if (!message) throw new Error(`mcp "${this.name}": ${method} returned no response`);
    if (message.error) throw new Error(message.error.message || JSON.stringify(message.error));
    return message.result;
  }
  async notify(method, params = {}) { await this._post({ jsonrpc: '2.0', method, params }); }
  async close() {
    if (!this.sessionId) return;
    try { await fetch(this.url, { method: 'DELETE', headers: { ...this.headers, 'Mcp-Session-Id': this.sessionId } }); } catch { /* best effort */ }
  }
}


class RpcClient {
  constructor(name, { command, args = [], env = {} }) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this._id = 0;
    this._pending = new Map();
    this._buf = '';
    this.child = null;
    this.stderrTail = '';
  }

  start() {
    this.child = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this._onData(d));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d).slice(-2000);
    });
    this.child.on('error', (e) => this._failAll(`process error: ${e.message}`));
    this.child.on('exit', (code) => this._failAll(`process exited with code ${code}`));
    this.child.stdin.on('error', () => { /* handled via exit */ });
  }

  _failAll(reason) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`mcp "${this.name}": ${reason}${this.stderrTail ? ` — stderr: ${this.stderrTail.trim().slice(-300)}` : ''}`));
    }
    this._pending.clear();
  }

  _onData(d) {
    this._buf += d;
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this._onMessage(msg);
    }
  }

  _onMessage(msg) {
    // Response to one of our requests
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this._pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
      return;
    }
    // Request from the server
    if (msg.id !== undefined && msg.method) {
      if (msg.method === 'ping') {
        this._send({ jsonrpc: '2.0', id: msg.id, result: {} });
      } else {
        this._send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not supported by coding-harness: ${msg.method}` },
        });
      }
      return;
    }
    // Notification from the server — ignore.
  }

  _send(obj) {
    if (!this.child || this.child.stdin.destroyed) return;
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n');
    } catch {
      /* stdin closed */
    }
  }

  request(method, params = {}, timeoutMs = 15000) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`mcp "${this.name}": ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params = {}) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  close() {
    try {
      this.child?.kill();
    } catch {
      /* already gone */
    }
  }
}

function qualify(serverName, toolName) {
  return (`mcp_${serverName}_${toolName}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/**
 * Connect all MCP servers from config (`mcp.servers`).
 * Each server: { command, args?, env?, protocolVersion? } for stdio, or
 * { type: 'http', url, headers? } for Streamable HTTP MCP servers.
 * Returns a facade: { listTools, has, call, describe, closeAll }.
 * Individual server failures are reported via onLog and skipped.
 */
export async function connectMcpServers(mcpConfig, { onLog } = {}) {
  const registry = new Map(); // qualified name -> { server, name, client, description, schema }
  const connected = [];

  for (const [name, cfg] of Object.entries(mcpConfig?.servers || {})) {
    const isHttp = Boolean(cfg && (cfg.type === 'http' || cfg.transport === 'http' || cfg.url || cfg.endpoint));
    if (!cfg || (isHttp ? !(cfg.url || cfg.endpoint) : !cfg.command)) {
      const required = isHttp ? 'url' : 'command';
      onLog?.('error', `mcp: server "${name}" has no "${required}" — skipped`);
      continue;
    }
    let client;
    try {
      client = isHttp ? new HttpRpcClient(name, cfg) : new RpcClient(name, cfg);
      if (client.start) client.start();
      const init = await client.request('initialize', {
        protocolVersion: cfg.protocolVersion || '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'coding-harness', version: '1.0.0' },
      });
      await client.notify('notifications/initialized');
      const tools = [];
      let cursor;
      do {
        const page = await client.request('tools/list', cursor ? { cursor } : {});
        tools.push(...(page?.tools || []));
        cursor = page?.nextCursor;
      } while (cursor);
      for (const t of tools) {
        registry.set(qualify(name, t.name), {
          server: name,
          name: t.name,
          client,
          description: t.description || `MCP tool ${t.name} from server "${name}"`,
          schema: t.inputSchema || { type: 'object', properties: {} },
        });
      }
      connected.push({ name, client, count: tools.length, info: init?.serverInfo });
      onLog?.(
        'info',
        `mcp: connected "${name}" (${init?.serverInfo?.name || '?'} ${init?.serverInfo?.version || ''}) — ${tools.length} tool(s)`
      );
    } catch (e) {
      client?.close();
      onLog?.('error', `mcp: failed to start "${name}": ${e.message}`);
    }
  }

  return {
    get size() {
      return registry.size;
    },
    listTools: () =>
      [...registry.entries()].map(([qualified, e]) => ({
        name: qualified,
        description: `${e.description} (mcp server: ${e.server})`,
        parameters: e.schema,
      })),
    has: (name) => registry.has(name),
    describe: () =>
      connected.map((c) => `${c.name}: ${[...registry.values()].filter((e) => e.server === c.name).map((e) => qualify(c.name, e.name)).join(', ')}`).join(' · '),
    async call(qualified, args) {
      const entry = registry.get(qualified);
      if (!entry) throw new Error(`unknown MCP tool "${qualified}"`);
      const res = await entry.client.request(
        'tools/call',
        { name: entry.name, arguments: args || {} },
        120000
      );
      const parts = (res?.content || []).map((c) => {
        if (c.type === 'text') return c.text;
        if (c.type === 'image') return '[image content omitted]';
        return JSON.stringify(c);
      });
      let text = parts.join('\n');
      if (res?.isError) text = `Error: ${text}`;
      return text || '(no content)';
    },
    closeAll() {
      for (const c of connected) c.client.close();
    },
  };
}
