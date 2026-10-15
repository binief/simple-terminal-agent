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

import {
  buildAgentSystemPrompt,
  COMPACT_TAG,
  compactionCut,
  createRepeatGuard,
  createSession,
  loadAgents,
  normalizeConfig,
  parseFrontmatter,
  REPEAT_TAG,
  resolveAgentTools,
  TURN_RULES,
} from '../agentic.mjs';
import { createTools } from '../lib/tools.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const agentic = path.join(repo, 'agentic.mjs');

/** An insertion: new_text wraps old_text, so applying it twice duplicates the line. */
const INSERT_B = { path: 'app.js', old_text: 'const a = 1;', new_text: 'const a = 1;\nconst b = 2;' };

/**
 * What a strict server (OpenAI) enforces: every tool message answers a
 * tool_calls message right before it, and no tool call is left unanswered.
 * Returns the problem, or null for valid chat.
 */
function historyError(messages) {
  let open = new Set();
  for (const [i, m] of messages.entries()) {
    if (m.role === 'tool') {
      if (!open.has(m.tool_call_id)) return `messages[${i}]: tool message ${m.tool_call_id} answers no preceding tool_calls`;
      open.delete(m.tool_call_id);
      continue;
    }
    if (open.size) return `messages[${i}]: tool_calls ${[...open].join(', ')} were never answered`;
    if (m.role === 'assistant' && !m.tool_calls?.length && m.content == null) return `messages[${i}]: assistant message with neither content nor tool_calls`;
    if (m.role === 'assistant' && m.tool_calls?.length) open = new Set(m.tool_calls.map((tc) => tc.id));
  }
  return open.size ? `tool_calls ${[...open].join(', ')} were never answered` : null;
}

/* ------------------------------ mock server ------------------------------ */
function decide(body) {
  const msgs = body.messages || [];
  const user = msgs.filter((m) => m.role === 'user').map((m) => m.content || '').join(' ');
  const system = msgs.filter((m) => m.role === 'system').map((m) => m.content || '').join(' ');
  const tools = (body.tools || []).map((t) => t.function.name);
  const toolMsgs = msgs.filter((m) => m.role === 'tool');
  const lastTool = String(toolMsgs.at(-1)?.content ?? '');
  if (user.includes(COMPACT_TAG)) return { text: 'SUMMARY: app.js already has const b = 2.' };
  // first, so it also answers a follow-up prompt in a session that ran another scenario
  if (user.includes('PROBE-TOOLS')) {
    return { text: `MOCK-DONE tools=${tools.join(',')} coder=${system.includes('# Coder')} researcher=${system.includes('# Researcher')}` };
  }
  // never stops by itself: read -> insert -> list, forever, whatever it is told
  // (IGNORES-STOP: it keeps calling tools even once none are offered)
  if (user.includes('LOOP-AFTER-DONE')) {
    if (!tools.length && !user.includes('IGNORES-STOP')) {
      const notes = toolMsgs.filter((m) => String(m.content).startsWith(REPEAT_TAG)).length;
      return { text: `MOCK-DONE final notes=${notes} stopped=${user.includes('Stopping the tool loop')}` };
    }
    const cycle = [
      { name: 'read_file', arguments: JSON.stringify({ path: 'app.js' }) },
      { name: 'edit_file', arguments: JSON.stringify(INSERT_B) },
      { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
    ];
    return { tool: cycle[toolMsgs.length % cycle.length] };
  }
  // listens: once told the edit is already applied, it finishes
  if (user.includes('REPEAT-THEN-STOP')) {
    if (lastTool.startsWith(REPEAT_TAG)) return { text: `MOCK-DONE listened tools=${tools.length > 0}` };
    return { tool: { name: 'edit_file', arguments: JSON.stringify(INSERT_B) } };
  }
  // never repeats a call and never finishes by itself: only the wrap-up nudge ends it
  if (user.includes('NEVER-DONE')) {
    if (user.includes('steps left')) return { text: `MOCK-DONE wrapped-up after=${toolMsgs.length}` };
    return { tool: { name: 'list_dir', arguments: JSON.stringify({ path: `dir${toolMsgs.length}` }) } };
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
      const invalid = historyError(body.messages || []);
      if (invalid) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `invalid chat history: ${invalid}` } }));
        return;
      }
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

test('repeat guard: an identical edit is never applied twice; reads and listings rerun only after a change', async (t) => {
  const { ws } = fixture(t);
  fs.writeFileSync(path.join(ws, 'app.js'), 'const a = 1;\nconsole.log(a);\n');
  const tools = createTools({ workspace: ws });
  const guard = createRepeatGuard({ cwd: ws });
  let step = 0;
  const call = (name, args) => guard.run(name, args, () => tools.execute(name, args), { step: ++step });
  const copies = () => fs.readFileSync(path.join(ws, 'app.js'), 'utf8').split('const b = 2;').length - 1;

  assert.equal((await call('read_file', { path: 'app.js' })).repeated, false);
  const applied = await call('edit_file', INSERT_B);
  assert.equal(applied.repeated, false);
  assert.match(applied.output, /^Replaced 1 occurrence/);
  // the same edit, path spelled differently and keys in another order: not applied
  const again = await call('edit_file', { new_text: INSERT_B.new_text, old_text: INSERT_B.old_text, path: './app.js' });
  assert.equal(again.repeated, true);
  assert.ok(again.output.startsWith(`${REPEAT_TAG} Not applied again`), again.output);
  assert.equal(copies(), 1);
  // the file changed since the first read, so reading it again runs — once
  assert.equal((await call('read_file', { path: 'app.js' })).repeated, false);
  assert.match((await call('read_file', { path: 'app.js' })).output, /Not read again/);
  // a listing reruns only once a write changed something
  assert.equal((await call('list_dir', { path: '.' })).repeated, false);
  assert.equal((await call('list_dir', { path: '.' })).repeated, true);
  assert.equal((await call('write_file', { path: 'new.txt', content: 'x' })).repeated, false);
  assert.equal((await call('list_dir', { path: '.' })).repeated, false);
  assert.match((await call('write_file', { path: 'new.txt', content: 'x' })).output, /Not written again/);
  assert.equal(guard.skipped, 4);
});

test('repeat guard: a command reruns only after a change, a failure gets one retry, MCP calls always run', async (t) => {
  const { ws } = fixture(t);
  const tools = createTools({ workspace: ws, commandTimeout: 30 });
  const guard = createRepeatGuard({ cwd: ws });
  const call = (name, args) => guard.run(name, args, () => tools.execute(name, args), { step: 1 });

  const passing = { command: 'node -e "process.exit(0)"' };
  assert.equal((await call('run_command', passing)).repeated, false);
  const skipped = await call('run_command', passing);
  assert.equal(skipped.repeated, true);
  assert.match(skipped.output, /already ran at step 1 \(exit code: 0\)/);
  await call('write_file', { path: 'f.txt', content: 'changed' });
  assert.equal((await call('run_command', passing)).repeated, false, 'a write re-arms the command');

  const failing = { command: 'node -e "process.exit(3)"' };
  assert.equal((await call('run_command', failing)).repeated, false);
  assert.equal((await call('run_command', failing)).repeated, false, 'one identical retry: failures can be transient');
  const third = await call('run_command', failing);
  assert.equal(third.repeated, true);
  assert.match(third.output, /already failed at step 1 \(exit code: 3\)/);

  let mcpRuns = 0;
  for (let i = 0; i < 3; i++) await guard.run('mcp_fake_add', { a: 1, b: 2 }, async () => { mcpRuns++; return '3'; }, { step: 1 });
  assert.equal(mcpRuns, 3, 'MCP side effects are unknown: never treated as a repeat');
});

test('repeat guard: after a compaction reads may repeat but edits may not; an applied insertion is not added again', async (t) => {
  const { ws } = fixture(t);
  const file = path.join(ws, 'app.js');
  fs.writeFileSync(file, 'const a = 1;\nconsole.log(a);\n');
  const tools = createTools({ workspace: ws });
  const call = (guard, name, args) => guard.run(name, args, () => tools.execute(name, args), { step: 1 });

  const guard = createRepeatGuard({ cwd: ws });
  await call(guard, 'edit_file', INSERT_B);
  await call(guard, 'read_file', { path: 'app.js' });
  guard.forgetReads(); // what a compaction does: the read result is gone from the conversation
  assert.equal((await call(guard, 'read_file', { path: 'app.js' })).repeated, false);
  assert.equal((await call(guard, 'edit_file', INSERT_B)).repeated, true, 'the file still holds the edit');

  // A new turn (fresh guard) that starts the task over: the insertion is already there.
  const redo = await call(createRepeatGuard({ cwd: ws }), 'edit_file', INSERT_B);
  assert.equal(redo.repeated, true);
  assert.match(redo.output, /already contains new_text/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'const a = 1;\nconst b = 2;\nconsole.log(a);\n');

  // ...but only when every old_text sits inside a copy: here foo(1) is a real target.
  fs.writeFileSync(path.join(ws, 'calls.js'), 'foo(1);\nfoo(1, 2);\n');
  const ambiguous = await call(createRepeatGuard({ cwd: ws }), 'edit_file', { path: 'calls.js', old_text: 'foo(1', new_text: 'foo(1, 2' });
  assert.equal(ambiguous.repeated, false);
  assert.match(ambiguous.output, /occurs 2 times/);

  // A replacement redone in a new turn fails — and says the change looks applied.
  const swap = { path: 'app.js', old_text: 'console.log(a);', new_text: 'console.log(a, b);' };
  await call(createRepeatGuard({ cwd: ws }), 'edit_file', swap);
  const redoSwap = await call(createRepeatGuard({ cwd: ws }), 'edit_file', swap);
  assert.match(redoSwap.output, /old_text not found[\s\S]*new_text already appears in app\.js/);
});

test('compaction never splits a tool call from its results, so the summary request and the history stay valid', async () => {
  const config = normalizeConfig({ openai: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'mock' }, streaming: false });
  const builtins = { cwd: os.tmpdir(), listTools: () => [], execute: async () => 'ok' };
  const session = createSession({ config, builtins, mcp: null, log: () => {} });
  const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });
  session.history.push(
    { role: 'user', content: 'task' },
    { role: 'assistant', content: null, tool_calls: [call('r1', 'read_file')] },
    { role: 'tool', tool_call_id: 'r1', content: 'x'.repeat(8000) },
    { role: 'assistant', content: null, tool_calls: [call('a', 'read_file'), call('b', 'read_file')] },
    { role: 'tool', tool_call_id: 'a', content: 'A' },
    { role: 'tool', tool_call_id: 'b', content: 'B' },
    { role: 'assistant', content: null, tool_calls: [call('c', 'edit_file')] },
    { role: 'tool', tool_call_id: 'c', content: 'Replaced 1 occurrence(s) in app.js' },
  );
  // four messages back is inside the a/b group: the cut moves back to the call that owns it
  assert.equal(compactionCut(session.history), 4);
  assert.equal(await session.compact(), true); // the mock answers invalid chat with a 400
  assert.equal(historyError(session.history), null);
  assert.match(session.history[1].content, /compacted summary[\s\S]*do not redo it/);
  assert.deepEqual(session.history.slice(2).map((m) => m.role), ['assistant', 'tool', 'tool', 'assistant', 'tool']);
});

test('every agent is told how a turn ends — promptMode: replace included — and the agent body stays last', () => {
  const config = normalizeConfig({ openai: { apiKey: 'k', model: 'm' } });
  const cwd = os.tmpdir();
  const appended = buildAgentSystemPrompt({ config, cwd, agent: { name: 'coder', description: '', data: {}, body: '# Coder\nWrite code.' } });
  assert.ok(appended.includes(TURN_RULES));
  assert.ok(appended.indexOf(TURN_RULES) < appended.indexOf('# Coder'));
  const replaced = buildAgentSystemPrompt({ config, cwd, agent: { name: 'mine', description: '', data: { promptMode: 'replace' }, body: '# Mine\nOnly this.' } });
  assert.ok(replaced.startsWith('# Mine'));
  assert.ok(replaced.includes(TURN_RULES));
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

test('a model that keeps redoing finished work is stopped: the edit lands once and it answers well before maxSteps', async (t) => {
  const { ws, cfgPath } = fixture(t);
  fs.writeFileSync(path.join(ws, 'app.js'), 'const a = 1;\nconsole.log(a);\n');
  const r = await run(t, ['--config', cfgPath, '--dir', ws, '--agent', 'coder', '--once', 'LOOP-AFTER-DONE']);
  assert.equal(r.code, 0, r.err + r.out);
  // read, edit, list, re-read (the file changed) — then edit, list and read are repeats:
  // three replies of nothing but repeats stop the tool loop, and the answer comes without tools
  assert.match(r.out, /MOCK-DONE final notes=3 stopped=true/);
  assert.match(r.out, /repeats-skipped=3/);
  assert.doesNotMatch(r.out, /step limit/);
  assert.equal(fs.readFileSync(path.join(ws, 'app.js'), 'utf8'), 'const a = 1;\nconst b = 2;\nconsole.log(a);\n');
});

test('a model that calls tools even after they were taken away still ends the turn, with a notice', async (t) => {
  const { ws, cfgPath } = fixture(t);
  fs.writeFileSync(path.join(ws, 'app.js'), 'const a = 1;\nconsole.log(a);\n');
  // REPL, so a second prompt proves the history left behind is valid chat (the mock 400s otherwise)
  const r = await run(t, ['--config', cfgPath, '--dir', ws, '--agent', 'coder'], { input: 'LOOP-AFTER-DONE IGNORES-STOP\nPROBE-TOOLS\n/quit\n' });
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /\(stopped: the model kept repeating tool calls that had already run/);
  assert.doesNotMatch(r.out, /step limit|API error/);
  assert.match(r.out, /MOCK-DONE tools=/);
  assert.equal(fs.readFileSync(path.join(ws, 'app.js'), 'utf8'), 'const a = 1;\nconst b = 2;\nconsole.log(a);\n');
});

test('the repeat note reaches the model: one that listens finishes by itself, tools still offered', async (t) => {
  const { ws, cfgPath } = fixture(t);
  fs.writeFileSync(path.join(ws, 'app.js'), 'const a = 1;\nconsole.log(a);\n');
  const r = await run(t, ['--config', cfgPath, '--dir', ws, '--agent', 'coder', '--once', 'REPEAT-THEN-STOP']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /MOCK-DONE listened tools=true/);
  assert.equal(fs.readFileSync(path.join(ws, 'app.js'), 'utf8'), 'const a = 1;\nconst b = 2;\nconsole.log(a);\n');
});

test('three steps before maxSteps the model is told to wrap up', async (t) => {
  const { ws, cfgPath } = fixture(t);
  const r = await run(t, ['--config', cfgPath, '--dir', ws, '--agent', 'coder', '--once', 'NEVER-DONE']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /MOCK-DONE wrapped-up after=7/); // maxSteps 10 in the fixture
});
