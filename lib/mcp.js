/* Minimal MCP (Model Context Protocol) stdio client: JSON-RPC 2.0 over ndjson.
   Supports initialize, tools/list and tools/call — enough to expose MCP tools to the model. */

import { spawn } from 'node:child_process';

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
 * Each server: { command, args?, env?, protocolVersion? }.
 * Returns a facade: { listTools, has, call, describe, closeAll }.
 * Individual server failures are reported via onLog and skipped.
 */
export async function connectMcpServers(mcpConfig, { onLog } = {}) {
  const registry = new Map(); // qualified name -> { server, name, client, description, schema }
  const connected = [];

  for (const [name, cfg] of Object.entries(mcpConfig?.servers || {})) {
    if (!cfg || !cfg.command) {
      onLog?.('error', `mcp: server "${name}" has no "command" — skipped`);
      continue;
    }
    let client;
    try {
      client = new RpcClient(name, cfg);
      client.start();
      const init = await client.request('initialize', {
        protocolVersion: cfg.protocolVersion || '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'coding-harness', version: '1.0.0' },
      });
      client.notify('notifications/initialized');
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
