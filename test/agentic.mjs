/* agentic.mjs tests: agent .md loading/switching, config, tools, MCP-less loop.
 * Run: node --test test/agentic.mjs  (no API credentials — local mock server) */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadAgents, normalizeConfig, parseFrontmatter, resolveAgentTools } from '../agentic.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const agentic = path.join(repo, 'agentic.mjs');

/* ------------------------------ mock server ------------------------------ */
function decide(body) {
  const msgs = body.messages || [];
  const user = msgs.filter((m) => m.role === 'user').map((m) => m.content || '').join(' ');
  const system = msgs.filter((m) => m.role === 'system').map((m) => m.content || '').join(' ');
  const tools = (body.tools || []).map((t) => t.function.name);
  const toolMsgs = msgs.filter((m) => m.role === 'tool');
  if (user.includes('PROBE-TOOLS')) {
    return { text: `MOCK-DONE tools=${tools.join(',')} coder=${system.includes('# Coder')} researcher=${system.includes('# Researcher')}` };
  }
  if (user.includes('TRY-WRITE')) {
    if (!toolMsgs.length) return { tool: { name: 'write_file', arguments: JSON.stringify({ path: 'nope.txt', content: 'x' }) } };
    return { text: `MOCK-DONE refused=${/not available to agent/.test(toolMsgs.at(-1).content)}` };
  }
  if (user.includes('ADD-MCP')) {
    if (!toolMsgs.length) return { tool: { name: 'mcp_fake_add', arguments: JSON.stringify({ a: 2, b: 40 }) } };
    return { text: `MOCK-DONE add=${toolMsgs.at(-1).content}` };
  }
  if (!toolMsgs.length) return { tool: { name: 'write_file', arguments: JSON.stringify({ path: 'hello-agentic.txt', content: 'agentic-ok' }) } };
  return { text: `MOCK-DONE wrote=${/Wrote hello-agentic\.txt/.test(toolMsgs.at(-1).content)}` };
}
let server;
let port;
before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const d = decide(body);
      const msg = d.tool
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: d.tool.name, arguments: d.tool.arguments } }] }
        : { role: 'assistant', content: d.text };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: d.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server?.close());

/* -------------------------------- helpers -------------------------------- */
function fixture(t, { config = {}, agentFiles = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws);
  const agentsDir = path.join(dir, 'agents');
  fs.mkdirSync(agentsDir);
  for (const [name, content] of Object.entries(agentFiles || {
    'coder.md': "---\nname: coder\ndescription: 'Writes code.'\ntools: ['read', 'search', 'edit', 'execute']\n---\n# Coder\nWrite code.\n",
    'researcher.md': "---\nname: researcher\ndescription: 'Reads only.'\ntools: ['read', 'search']\n---\n# Researcher\nAnswer only.\n",
  })) fs.writeFileSync(path.join(agentsDir, name), content);
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    openai: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'mock' },
    maxContext: 32000, maxTokens: 1024, maxSteps: 10, streaming: false, agentsDir, ...config,
  }));
  return { dir, ws, agentsDir, cfgPath };
}
function run(t, args, { input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [agentic, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    if (input) child.stdin.end(input);
    else child.stdin.end();
    setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timeout: ${out} ${err}`)); }, 20000).unref();
  });
}

/* --------------------------------- units --------------------------------- */
test('frontmatter: Copilot-style scalars, lists and handoffs parse; body is the prompt', () => {
  const { data, body } = parseFrontmatter("---\nname: plan\ndescription: 'Plans.'\ntools: ['read', 'search', 'execute']\nhandoffs:\n  - label: Go\n    agent: coder\n    send: false\n---\n# PLAN\nDo it.\n");
  assert.equal(data.name, 'plan');
  assert.deepEqual(data.tools, ['read', 'search', 'execute']);
  assert.deepEqual(data.handoffs, [{ label: 'Go', agent: 'coder', send: false }]);
  assert.match(body, /^# PLAN/);
  assert.deepEqual(parseFrontmatter('# Plain\nPrompt.'), { data: {}, body: '# Plain\nPrompt.' });
});

test('agents load from a folder, sorted, README skipped, tools resolved read-only', (t) => {
  const { agentsDir } = fixture(t);
  fs.writeFileSync(path.join(agentsDir, 'README.md'), '# not an agent');
  const { agents, errors } = loadAgents(agentsDir);
  assert.deepEqual(errors, []);
  assert.deepEqual(agents.map((a) => a.name), ['coder', 'researcher']);
  assert.equal(agents[1].tools.readOnly, true);
  assert.ok(!agents[1].tools.builtins.includes('write_file'));
  assert.deepEqual(resolveAgentTools({ data: {} }).builtins.length, 6);
});

test('config: maxContext alias, env-style values and defaults normalize', () => {
  const cfg = normalizeConfig({ openai: { apiKey: 'k', model: 'm' }, maxContext: 12345 });
  assert.equal(cfg.contextSize, 12345);
  assert.equal(cfg.maxTokens, 4096);
  assert.deepEqual(cfg.mcp.servers, {});
});

/* ------------------------------ integration ------------------------------ */
test('--once with the coder agent writes the file and finishes', async (t) => {
  const { ws, cfgPath } = fixture(t);
  const r = await run(t, ['--config', cfgPath, '--dir', ws, '--agent', 'coder', '--once', 'make the file']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /MOCK-DONE wrote=true/);
  assert.equal(fs.readFileSync(path.join(ws, 'hello-agentic.txt'), 'utf8'), 'agentic-ok');
});

test('a read-only agent is offered no writers, and a stray write call is refused', async (t) => {
  const { ws, cfgPath } = fixture(t);
  const probe = await run(t, ['--config', cfgPath, '--dir', ws, '--agent', 'researcher', '--once', 'PROBE-TOOLS']);
  assert.match(probe.out, /researcher=true/);
  assert.doesNotMatch(probe.out, /write_file/);
  const attempt = await run(t, ['--config', cfgPath, '--dir', ws, '--agent', 'researcher', '--once', 'TRY-WRITE']);
  assert.match(attempt.out, /MOCK-DONE refused=true/);
  assert.ok(!fs.existsSync(path.join(ws, 'nope.txt')));
});

test('MCP servers from the config are exposed as mcp_<server>_<tool>', async (t) => {
  const fakeMcp = path.join(repo, 'test', 'fake-mcp.mjs');
  const { ws, cfgPath } = fixture(t, {
    config: { mcp: { servers: { fake: { command: process.execPath, args: [fakeMcp] } } } },
    agentFiles: { 'coder.md': "---\nname: coder\ntools: ['read', 'edit', 'execute', 'mcp']\n---\n# Coder\nWrite code.\n" },
  });
  const r = await run(t, ['--config', cfgPath, '--dir', ws, '--once', 'ADD-MCP']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /MOCK-DONE add=42/);
});

test('--list-agents and interactive /agent switching work without extra config', async (t) => {
  const { ws, cfgPath, agentsDir } = fixture(t);
  const list = await run(t, ['--agents', agentsDir, '--list-agents']);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /coder/);
  assert.match(list.out, /researcher/);
  const repl = await run(t, ['--config', cfgPath, '--dir', ws], { input: '/agent researcher\nPROBE-TOOLS\n/quit\n' });
  assert.equal(repl.code, 0, repl.err + repl.out);
  assert.match(repl.out, /agent: researcher/);
  assert.match(repl.out, /MOCK-DONE tools=[^\n]*read_file/);
  assert.doesNotMatch(repl.out, /MOCK-DONE tools=[^\n]*write_file/);
});
