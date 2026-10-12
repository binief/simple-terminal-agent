/* Standalone basic.mjs integration tests; no API credentials required. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const basic = fileURLToPath(new URL('../basic.mjs', import.meta.url));
const plan = 'IMPLEMENT PROMPT\n---\nInspect the fixture.\n---';
const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;

async function session(handler, configOptions = {}, { env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-stream-'));
  fs.writeFileSync(path.join(dir, 'fixture.txt'), 'héllo 🌍');
  const requests = [];
  let stdout = '';
  let stderr = '';
  let serverError;
  const waiters = [];
  const waitForOutput = (text) => {
    if (stdout.includes(text)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No live output: ${text}`)), 3000);
      waiters.push(() => {
        if (!stdout.includes(text)) return false;
        clearTimeout(timer);
        resolve();
        return true;
      });
    });
  };
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      assert.equal(body.stream, true);
      await handler({ body, res, step: requests.length, waitForOutput, dir });
    } catch (e) {
      serverError = e;
      res.destroy();
    }
  });
  let child;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const config = path.join(dir, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ planDir: path.join(dir, '.plans'), ...configOptions, workspace: dir, openai: {
      baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: '', model: 'mock',
    } }));
    child = spawn(process.execPath, [basic, '--config', config, '--once', 'inspect'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...envWith(env) },
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      stdout += data;
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]()) waiters.splice(i, 1);
    });
    child.stderr.on('data', (data) => { stderr += data; });
    const timeout = setTimeout(() => child.kill(), 10000);
    let code;
    try { [code] = await once(child, 'close'); } finally { clearTimeout(timeout); }
    if (serverError) throw serverError;
    return { code, stdout, stderr, requests };
  } finally {
    child?.kill();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Like session(), but keeps the child's stdin open so slash commands can be
 * driven one at a time — the CLI reads lines only while it is idle, so the
 * test must wait for a reply before sending the next command.
 */
async function interactive(handler, configOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-interactive-'));
  fs.writeFileSync(path.join(dir, 'fixture.txt'), 'héllo 🌍');
  const requests = [];
  let stdout = '';
  let cursor = 0;
  let serverError;
  const waiters = [];
  const settle = () => {
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]()) waiters.splice(i, 1);
  };
  /** Wait for text printed *after* the last settled marker, then move past it. */
  const waitNew = (text, ms = 5000) => {
    const hit = () => {
      const at = stdout.indexOf(text, cursor);
      if (at < 0) return false;
      cursor = at + text.length;
      return true;
    };
    if (hit()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No output ${JSON.stringify(text)} in:\n${stdout}`)), ms);
      waiters.push(() => (hit() ? (clearTimeout(timer), resolve(), true) : false));
    });
  };
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      await handler({ body, res, step: requests.length, dir });
    } catch (e) {
      serverError = e;
      if (process.env.DEBUG_TESTS) console.error('handler error:', e);
      res.destroy();
    }
  });
  let child;
  const send = (line) => child.stdin.write(`${line}\n`);
  const cleanup = async () => {
    child?.kill();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const config = path.join(dir, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ planDir: path.join(dir, '.plans'), ...configOptions, workspace: dir, openai: {
      baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: '', model: 'mock',
    } }));
    child = spawn(process.execPath, [basic, '--config', config], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => { stdout += data; settle(); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => { stdout += data; settle(); });
    await waitNew('mode=plan');
  } catch (e) {
    await cleanup();
    throw e;
  }
  return {
    send,
    waitNew,
    requests,
    async finish() {
      child.stdin.end(); // the CLI is idle by now, so it sees EOF and exits
      const timeout = setTimeout(() => child.kill(), 5000);
      const [code] = await once(child, 'close').finally(() => clearTimeout(timeout));
      await cleanup();
      if (serverError) throw serverError;
      return { code, stdout, requests };
    },
  };
}

// A clean colour environment, so a NO_COLOR in the caller's shell cannot
// silently change what these tests see.
function envWith(extra = {}) {
  const env = { ...process.env };
  for (const key of ['NO_COLOR', 'FORCE_COLOR', 'TERM']) delete env[key];
  return { ...env, ...extra };
}

/** What lib/ui.js styles one string as, in a throwaway process with `env`. */
function styledIn(env) {
  const ui = new URL('../lib/ui.js', import.meta.url).href;
  const code = `import { s } from ${JSON.stringify(ui)}; process.stdout.write(s.cyan('x'))`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: envWith(env) }).stdout.toString();
}

// Split every byte, including UTF-8 characters and CRLF separators.
async function bytes(res, text) {
  for (const byte of Buffer.from(text)) {
    res.write(Buffer.from([byte]));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function startSse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(': keepalive\r\n\r\n');
}

test('live reasoning/text, fragmented parallel tools, results and history', async () => {
  const result = await session(async ({ res, step, body, waitForOutput }) => {
    startSse(res);
    if (step === 1) {
      await bytes(res, frame({ reasoning_content: 'Inspect 🌍 first.' }));
      // The server will not finish until the console has printed the delta.
      await waitForOutput('Inspect 🌍 first.');
      await bytes(res, frame({ content: 'IMPLEMENT PROMPT\n---\n' }));
      await waitForOutput('IMPLEMENT PROMPT\n---\n');
      res.end(frame({ content: 'Inspect the fixture.\n---' }, 'stop') + 'data: [DONE]\r\n\r\n');
    } else if (step === 2) {
      res.write(frame({ reasoning: 'Reading now.' }));
      res.write(frame({ content: 'Inspecting files.' }));
      res.write(frame({ tool_calls: [
        { index: 1, id: 'bad', type: 'function', function: { name: 'read_', arguments: '{"path":"missing' } },
        { index: 0, id: 'good', type: 'function', function: { name: 'read_', arguments: '{"path":' } },
        { index: 2, id: 'unknown', type: 'function', function: { name: 'unknown_tool', arguments: '{}' } },
      ] }));
      await bytes(res, frame({ tool_calls: [
        { index: 0, function: { name: 'file', arguments: '"fixture.txt"}' } },
        { index: 1, function: { name: 'file', arguments: '.txt"}' } },
      ] }));
      res.end(frame({}, 'tool_calls') + 'data: {"choices":[],"usage":{"total_tokens":42}}\r\n\r\ndata: [DONE]\r\n\r\n');
    } else {
      assert.equal(step, 3);
      const assistant = body.messages[1];
      assert.equal(assistant.role, 'assistant');
      assert.equal(assistant.content, 'Inspecting files.');
      assert.equal(assistant.reasoning, 'Reading now.');
      assert.deepEqual(assistant.tool_calls.map((c) => c.id), ['good', 'bad', 'unknown']);
      assert.match(body.messages[2].content, /héllo 🌍/);
      assert.equal(body.messages[2].tool_call_id, 'good');
      assert.match(body.messages[3].content, /^error:.*ENOENT/);
      assert.match(body.messages[4].content, /unknown tool/);
      // A final frame without a blank line or [DONE] must still be handled.
      res.end(frame({ content: 'Finished uniquely.' }, 'stop').trimEnd());
    }
  });
  assert.equal(result.code, 0, result.stderr);
  for (const text of ['Inspecting files.', 'Finished uniquely.', plan]) {
    assert.equal(result.stdout.split(text).length - 1, 1, result.stdout);
  }
  for (const text of ['[thinking]', '[response]', '[read] read_file', '[tool] unknown_tool', '[tool result] read_file', 'héllo 🌍', 'error:']) {
    assert.ok(result.stdout.includes(text), result.stdout);
  }
  // Piped output gets one non-animated progress line per wait, not a frame stream.
  assert.ok(result.stdout.includes('· thinking…'), result.stdout);
  assert.ok(result.stdout.includes('· running read_file…'), result.stdout);
  assert.doesNotMatch(result.stdout + result.stderr, /\x1b\[/, 'no escapes when stdout is a pipe');
});

test('JSON-only compatible servers still display reasoning and responses once', async () => {
  const result = await session(({ res, step }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: {
      role: 'assistant', reasoning_content: 'JSON thinking.', content: step === 1 ? plan : 'JSON done.',
    } }] }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.split('JSON done.').length - 1, 1);
  assert.match(result.stdout, /\[thinking\]\nJSON thinking\./);
});

for (const [name, payload, expected] of [
  ['provider stream error', 'data: {"error":{"message":"provider unavailable"}}\n\n', /provider unavailable/],
  ['malformed JSON', 'data: not-json\n\n', /SyntaxError/],
  ['premature EOF', frame({ content: 'partial answer' }), /stream ended before completion/],
]) {
  test(name, async () => {
    const result = await session(({ res }) => { startSse(res); res.end(payload); });
    assert.equal(result.code, 1);
    assert.match(result.stderr, expected);
    assert.equal(result.requests.length, 1);
  });
}

const rejected = { code: 500, message: 'Failed to parse tool call arguments as JSON: invalid string: missing closing quote; last read: \'"<div class="container-fluid">' };
const writeCall = (id, filename, content) => ({
  id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: filename, content }) },
});

for (const transport of ['http', 'sse', 'json', 'arguments', 'json-arguments', 'length', 'eof']) {
  test(`recovers rejected tool calls (${transport}) without executing a partial batch`, async () => {
    const result = await session(({ res, step, body, dir }) => {
      if (step === 1) {
        startSse(res);
        res.end(frame({ content: plan }, 'stop'));
      } else if (step === 2) {
        const calls = [writeCall('valid', 'must-not-exist.txt', 'not executed'), writeCall('broken', 'bad.txt', 'partial')];
        if (transport.endsWith('arguments')) calls[1].function.arguments = '{"path":"bad.txt","content":"unterminated';
        if (transport === 'http') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: rejected }));
        } else if (transport === 'json-arguments') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }] }));
        } else if (transport === 'json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: rejected }));
        } else {
          startSse(res);
          // Even a valid first tool must not run if anything in the reply fails.
          res.write(frame({ tool_calls: calls.map((call, index) => ({ index, ...call })) }));
          if (transport === 'sse') res.end(`data: ${JSON.stringify({ error: rejected })}\n\n`);
          else if (transport === 'eof') res.end();
          else res.end(frame({}, transport === 'length' ? 'length' : 'tool_calls') + 'data: [DONE]\n\n');
        }
      } else if (step === 3) {
        assert.equal(body.max_tokens, 2048);
        assert.equal(body.messages.some((m) => m.role === 'assistant' || m.role === 'tool'), false);
        const nudge = body.messages.at(-1).content;
        assert.match(nudge, /one small tool call/);
        assert.match(nudge, /targeted edit_file/);
        assert.match(nudge, /2048 tokens/);
        assert.equal(fs.existsSync(path.join(dir, 'must-not-exist.txt')), false);
        assert.equal(fs.existsSync(path.join(dir, 'bad.txt')), false);
        startSse(res);
        res.end(frame({ tool_calls: [{ index: 0, ...writeCall('recovered', 'small.txt', 'first section') }] }, 'tool_calls'));
      } else {
        assert.equal(step, 4);
        assert.equal(body.max_tokens, 2048); // Keep the smaller budget after success.
        assert.equal(fs.readFileSync(path.join(dir, 'small.txt'), 'utf8'), 'first section');
        assert.equal(body.messages.at(-1).tool_call_id, 'recovered');
        startSse(res);
        res.end(frame({ content: 'Recovered successfully.' }, 'stop'));
      }
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 4);
    assert.match(result.stdout, /Recovered successfully/);
    assert.match(result.stderr, /retry 1\/3/);
    assert.doesNotMatch(result.stdout + result.stderr, /container-fluid|last read:/);
  });
}

test('persistent invalid tool calls stop after three retries, respecting the token floor', async () => {
  const result = await session(({ res }) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: rejected }));
  }, { maxTokens: 1024 });
  assert.equal(result.code, 1);
  assert.deepEqual(result.requests.map((r) => r.max_tokens), [1024, 512, 256, 256]);
  assert.match(result.stderr, /after 3 smaller-output retries/);
  assert.doesNotMatch(result.stdout + result.stderr, /container-fluid|last read:/);
});

test('unrelated HTTP errors are not retried as oversized tool calls', async () => {
  const result = await session(({ res }) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'upstream unavailable' } }));
  });
  assert.equal(result.code, 1);
  assert.equal(result.requests.length, 1);
  assert.match(result.stderr, /upstream unavailable/);
  assert.doesNotMatch(result.stderr, /retry/);
});


test('section edits preserve literal dollar sequences', async () => {
  const result = await session(({ res, step, dir }) => {
    startSse(res);
    if (step === 1) res.end(frame({ content: plan }, 'stop'));
    else if (step === 2) {
      res.end(frame({ tool_calls: [{ index: 0, id: 'edit', type: 'function', function: {
        name: 'edit_file', arguments: JSON.stringify({ path: 'fixture.txt', old_text: 'héllo 🌍', new_text: 'héllo 🌍\n$& $1 $$' }),
      } }] }, 'tool_calls'));
    } else {
      assert.equal(step, 3);
      assert.equal(fs.readFileSync(path.join(dir, 'fixture.txt'), 'utf8'), 'héllo 🌍\n$& $1 $$');
      res.end(frame({ content: 'Edit complete.' }, 'stop'));
    }
  });
  assert.equal(result.code, 0, result.stderr);
});

test('contextSize drives a /compact nudge once the window is nearly full', async () => {
  const result = await session(({ res, step }) => {
    // A plan big enough to fill most of a 2k-token window (also the implement
    // prompt, so the nudge can be observed in both modes).
    const content = step === 1 ? `IMPLEMENT PROMPT\n---\n${'filler '.repeat(1400)}\n---` : 'done';
    startSse(res);
    res.end(frame({ content }, 'stop') + 'data: [DONE]\r\n\r\n');
  }, { contextSize: 2000 });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\[context\] ~[\d.]+k? of 2\.0k tokens \(\d+%\)/);
  assert.match(result.stdout, /run \/compact to summarize/);
});

test('context config below the floor is rejected', async () => {
  const result = await session(({ res }) => res.end('{}'), { contextSize: 100 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /contextSize must be an integer >= 2000/);
});

test('/compact summarizes the conversation, keeps the tail and drops the originals', async () => {
  const big = `OLD ${'history '.repeat(1200)}`;
  const live = await interactive(({ res, step }) => {
    startSse(res);
    if (step === 1) {
      res.end(frame({ content: `IMPLEMENT PROMPT\n---\n${big}\n---` }, 'stop') + 'data: [DONE]\r\n\r\n');
    } else if (step === 2) {
      res.end(frame({ content: 'REPLY-TWO' }, 'stop') + 'data: [DONE]\r\n\r\n');
    } else if (step === 3) {
      res.end(frame({ content: 'SUMMARY: inspected the fixture; nothing pending.' }, 'stop') + 'data: [DONE]\r\n\r\n');
    } else {
      res.end(frame({ content: 'REPLY-AFTER' }, 'stop') + 'data: [DONE]\r\n\r\n');
    }
  }, { contextSize: 2000 });

  live.send('/plan inspect the fixture');
  await live.waitNew(big.slice(0, 8)); // the reply with the oversized history lands
  await live.waitNew('[context]'); // 90% nudge printed right after that reply
  live.send('/plan second question');
  await live.waitNew('REPLY-TWO');
  live.send('/compact');
  await live.waitNew('[compact] conversation:'); // the summary itself is never echoed
  live.send('/plan after compact');
  await live.waitNew('REPLY-AFTER');

  const result = await live.finish();
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /\[compact\] conversation: [\d.]+k? → [\d.]+k? tokens/);
  const compactRequest = result.requests[2];
  assert.match(compactRequest.messages.at(-1).content, /\[compaction request\]/);
  const after = result.requests[3];
  assert.match(after.messages[1].content, /Earlier in this session \(compacted summary/);
  assert.match(after.messages[1].content, /SUMMARY: inspected the fixture/);
  assert.equal(JSON.stringify(after).includes('history history'), false, 'the old messages were dropped');
});

test('tool calls, reasoning and tool results are coloured on a terminal', async () => {
  const result = await session(({ res, step }) => {
    startSse(res);
    if (step === 1) {
      res.write(frame({ reasoning_content: 'weighing options' }));
      res.end(frame({ content: plan }, 'stop') + 'data: [DONE]\r\n\r\n');
    } else if (step === 2) {
      res.end(frame({ tool_calls: [
        { index: 0, id: 'w', type: 'function', function: {
          name: 'write_file', arguments: JSON.stringify({ path: 'out.txt', content: 'x' }) } },
        { index: 1, id: 'r', type: 'function', function: {
          name: 'read_file', arguments: JSON.stringify({ path: 'gone.txt' }) } },
      ] }, 'tool_calls'));
    } else {
      res.end(frame({ content: 'COLOUR-DONE' }, 'stop'));
    }
  }, {}, { env: { FORCE_COLOR: '1' } });

  assert.equal(result.code, 0, result.stdout);
  const out = result.stdout;
  assert.ok(out.includes('\x1b[35m[thinking]\x1b[0m'), 'thinking tag is magenta');
  assert.ok(out.includes('\x1b[2mweighing options\x1b[0m'), 'reasoning text is dim');
  assert.ok(out.includes('\x1b[33m[tool]\x1b[0m \x1b[1mwrite_file\x1b[0m'), 'a write tool is yellow and bold');
  assert.ok(out.includes('\x1b[2m{"path":"out.txt"'), 'arguments are dim');
  assert.ok(out.includes('\x1b[36m[read]\x1b[0m \x1b[1mread_file\x1b[0m'), 'a read tool is cyan');
  assert.ok(out.includes('\x1b[32m[tool result]\x1b[0m \x1b[1mwrite_file\x1b[0m'), 'a good result is green');
  assert.ok(out.includes('\x1b[31m[tool result]\x1b[0m \x1b[1mread_file\x1b[0m'), 'a failed result is red');
  assert.ok(out.includes('\x1b[32m[response]\x1b[0m'), 'the response tag is green');
});

test('colour follows NO_COLOR, FORCE_COLOR and the TTY check', () => {
  assert.equal(styledIn({}), 'x', 'a pipe gets no colour by default');
  assert.equal(styledIn({ FORCE_COLOR: '1' }), '\x1b[36mx\x1b[0m', 'FORCE_COLOR=1 colours piped output');
  assert.equal(styledIn({ FORCE_COLOR: '1', NO_COLOR: '1' }), 'x', 'NO_COLOR wins over FORCE_COLOR');
  assert.equal(styledIn({ FORCE_COLOR: '0' }), 'x', 'FORCE_COLOR=0 means off');
});

/* ------------------------------------------------------------------ */
/* Mode restrictions, plan persistence, compact display, compact mode  */
/* ------------------------------------------------------------------ */

const call = (id, name, args, index = 0) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('PLAN mode refuses project writes and shell writes, allows the plan dir; IMPLEMENT runs from the saved plan file', async () => {
  let planDir;
  const result = await session(({ res, step, body, dir }) => {
    planDir = path.join(dir, '.plans');
    startSse(res);
    if (step === 1) {
      // Tool descriptions carry the plan-mode rules.
      const tools = Object.fromEntries(body.tools.map((t) => [t.function.name, t.function.description]));
      assert.match(tools.write_file, /PLAN mode: only paths under .*\.plans/);
      assert.match(tools.run_command, /PLAN mode: read-only commands only/);
      assert.match(body.messages[0].content, /READ-ONLY in this mode/);
      res.end(frame({ tool_calls: [
        call('w', 'write_file', { path: 'component.ts', content: 'export const changed = true;' }, 0),
        call('e', 'edit_file', { path: 'fixture.txt', old_text: 'héllo', new_text: 'bye' }, 1),
        call('c', 'run_command', { command: 'echo pwned > fixture.txt' }, 2),
        call('ok-cmd', 'run_command', { command: 'ls' }, 3),
        call('notes', 'write_file', { path: path.join(planDir, 'notes.md'), content: 'context: fixture.txt holds a greeting' }, 4),
      ] }, 'tool_calls'));
    } else if (step === 2) {
      const results = Object.fromEntries(body.messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content]));
      assert.match(results.w, /^error: PLAN mode is read-only: .*component\.ts was not written/);
      assert.match(results.e, /^error: PLAN mode is read-only/);
      assert.match(results.c, /^error: PLAN mode is read-only: `echo pwned > fixture\.txt` was not run \(it redirects output/);
      assert.match(results['ok-cmd'], /^exit 0\n[\s\S]*fixture\.txt/);
      assert.match(results.notes, /^wrote .*notes\.md/);
      assert.equal(fs.existsSync(path.join(dir, 'component.ts')), false, 'plan mode must not create project files');
      assert.equal(fs.readFileSync(path.join(dir, 'fixture.txt'), 'utf8'), 'héllo 🌍', 'plan mode must not modify project files');
      assert.equal(fs.readFileSync(path.join(planDir, 'notes.md'), 'utf8'), 'context: fixture.txt holds a greeting');
      res.end(frame({ content: 'IMPLEMENT PROMPT\n---\nGoal: add component.ts exporting changed = true.\n---' }, 'stop'));
    } else if (step === 3) {
      // Implement mode: the user prompt is the plan file, and tools are unrestricted again.
      assert.equal(body.messages.length, 1);
      assert.equal(body.messages[0].role, 'user');
      assert.match(body.messages[0].content, /^IMPLEMENT mode\. The plan below was written in PLAN mode and saved at (.*plan-[\dT-]+\.md)/);
      const file = body.messages[0].content.match(/saved at (\S+\.md)/)[1];
      assert.ok(file.startsWith(planDir), file);
      assert.equal(fs.readFileSync(file, 'utf8'), 'Goal: add component.ts exporting changed = true.\n');
      assert.match(body.messages[0].content, /\n\nGoal: add component\.ts exporting changed = true\.$/);
      const tools = Object.fromEntries(body.tools.map((t) => [t.function.name, t.function.description]));
      assert.doesNotMatch(tools.write_file, /PLAN mode/);
      res.end(frame({ tool_calls: [
        call('w2', 'write_file', { path: 'component.ts', content: 'export const changed = true;' }, 0),
        call('c2', 'run_command', { command: 'echo built > build.log' }, 1),
      ] }, 'tool_calls'));
    } else {
      assert.equal(step, 4);
      assert.equal(fs.readFileSync(path.join(dir, 'component.ts'), 'utf8'), 'export const changed = true;');
      assert.equal(fs.readFileSync(path.join(dir, 'build.log'), 'utf8').trim(), 'built');
      res.end(frame({ content: 'IMPLEMENTED' }, 'stop'));
    }
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 4);
  assert.match(result.stdout, /saved plan → \S+plan-[\dT-]+\.md/);
  assert.match(result.stdout, /\[implement\] plan: \S+\.md/);
  assert.match(result.stdout, /⊘ \[tool result\] write_file · blocked/);
  assert.match(result.stdout, /✓ \[tool result\] run_command · ok/);
  assert.match(result.stdout, /\[done\] 2 steps · 5 tool calls \(1 file write, 1 command, 3 blocked by PLAN mode\)/);
  assert.match(result.stdout, /\[done\] 2 steps · 2 tool calls \(1 file write, 1 command\)/);
});

test('/implement accepts a plan file path or ad-hoc text, and /prompt shows the saved plan', async () => {
  const live = await interactive(({ res, step, body, dir }) => {
    startSse(res);
    if (step === 1) {
      assert.match(body.messages[0].content, /^IMPLEMENT mode\./);
      assert.match(body.messages[0].content, /saved at \S*basic-handwritten-\d+\.md;/);
      assert.match(body.messages[0].content, /\n\nHand-written plan\.$/);
      res.end(frame({ content: 'FROM-FILE' }, 'stop'));
    } else if (step === 2) {
      assert.match(body.messages[0].content, /\n\nad hoc instructions$/);
      const file = body.messages[0].content.match(/saved at (\S+\.md)/)[1];
      assert.ok(file.startsWith(path.join(dir, '.plans')), file);
      res.end(frame({ content: 'FROM-TEXT' }, 'stop'));
    }
  });
  live.send('/prompt');
  await live.waitNew('(no plan saved yet)');
  live.send('/implement');
  await live.waitNew('no plan saved yet — stay in /plan');
  const handwritten = path.join(os.tmpdir(), `basic-handwritten-${process.pid}.md`);
  fs.writeFileSync(handwritten, 'Hand-written plan.\n');
  try {
    live.send(`/implement ${handwritten}`);
    await live.waitNew('FROM-FILE');
    await live.waitNew('back to plan');
    live.send('/implement ad hoc instructions');
    await live.waitNew('FROM-TEXT');
    live.send('/prompt');
    await live.waitNew('plan file: '); // /prompt follows whichever plan ran last
    await live.waitNew('ad hoc instructions');
    const result = await live.finish();
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.requests.length, 2);
  } finally {
    fs.rmSync(handwritten, { force: true });
  }
});

test('tool arguments and results are shown compactly; the model still gets everything', async () => {
  const big = Array.from({ length: 60 }, (_, i) => `line ${i + 1} ${'x'.repeat(200)}`).join('\n');
  const result = await session(({ res, step, body, dir }) => {
    startSse(res);
    if (step === 1) {
      fs.writeFileSync(path.join(dir, 'big.txt'), big);
      res.end(frame({ content: plan }, 'stop'));
    } else if (step === 2) {
      res.end(frame({ tool_calls: [
        call('r', 'read_file', { path: 'big.txt' }, 0),
        call('w', 'write_file', { path: 'copy.txt', content: big }, 1),
      ] }, 'tool_calls'));
    } else {
      assert.equal(step, 3);
      const read = body.messages.find((m) => m.tool_call_id === 'r').content;
      assert.equal(read.split('\n').length, 61, 'the model receives the whole file');
      assert.match(read, /line 60 x{200}/);
      res.end(frame({ content: 'COMPACT-DONE' }, 'stop'));
    }
  });
  assert.equal(result.code, 0, result.stderr);
  const out = result.stdout;
  // Arguments: long strings are summarized, not dumped.
  assert.match(out, /\{"path":"copy\.txt","content":"line 1 xxxx[^"]*… \(\d+ chars, 60 lines\)"\}/);
  assert.doesNotMatch(out, /x{200}/, 'no 200-char line reaches the console');
  // Results: a few lines plus a count of what was left out.
  assert.match(out, /✓ \[tool result\] read_file · ok · [\d.]+s · 61 lines/);
  assert.match(out, /… \+53 more lines \(\d+ chars; the model gets the full result, \/verbose shows it\)/);
  assert.equal(out.split('line 1 ').length - 1, 2, 'first line shown once per preview (read + args)');
  assert.equal(out.includes('line 60'), false);
  assert.match(out, /· composing tool call(s)? read_file, write_file…/);
});

test('/verbose shows full tool arguments and results', async () => {
  const live = await interactive(({ res, step }) => {
    startSse(res);
    if (step === 1) res.end(frame({ tool_calls: [call('r', 'read_file', { path: 'fixture.txt', max_lines: 5 })] }, 'tool_calls'));
    else res.end(frame({ content: 'VERBOSE-DONE' }, 'stop'));
  });
  live.send('/verbose');
  await live.waitNew('tool output: verbose');
  live.send('/implement read the fixture');
  await live.waitNew('VERBOSE-DONE');
  const result = await live.finish();
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /\{"path":"fixture\.txt","max_lines":5\}/);
  assert.match(result.stdout, /\[tool result\] read_file · ok · [\d.]+s · 2 lines\nfile .*fixture\.txt \(1 lines\)\n   1\|héllo 🌍/);
});

test('compact mode trims older tool results from requests above 90% and asks for /compact, without touching history', async () => {
  const huge = `${'payload '.repeat(900)}END-OF-PAYLOAD`; // ~1.8k tokens: enough to cross 90% of 2000 on its own
  const result = await session(({ res, step, body, dir }) => {
    startSse(res);
    if (step === 1) {
      fs.writeFileSync(path.join(dir, 'huge.txt'), huge);
      res.end(frame({ content: plan }, 'stop'));
    } else if (step === 2) {
      res.end(frame({ reasoning_content: 'read it', tool_calls: [call('big', 'read_file', { path: 'huge.txt' })] }, 'tool_calls'));
    } else if (step === 3) {
      // Compact mode switched on before this request: the only tool result is
      // in the latest step, so it gets the generous cut.
      const tool = body.messages.find((m) => m.tool_call_id === 'big');
      assert.ok(tool.content.length < 2300, `latest-step result trimmed: ${tool.content.length}`);
      assert.match(tool.content, /…\[compact mode: \d+ more chars of this tool result were trimmed/);
      assert.equal(body.messages[1].reasoning_content, 'read it', 'latest step keeps its reasoning');
      res.end(frame({ tool_calls: [call('small', 'read_file', { path: 'fixture.txt' })] }, 'tool_calls'));
    } else {
      assert.equal(step, 4);
      // Now the big result is an older step: stub size, reasoning dropped,
      // while the latest step's result travels untouched.
      const big = body.messages.find((m) => m.tool_call_id === 'big');
      assert.ok(big.content.length < 500, `older result cut to a stub: ${big.content.length}`);
      assert.doesNotMatch(big.content, /END-OF-PAYLOAD/);
      assert.equal(body.messages[1].reasoning_content, undefined, 'older reasoning dropped from the request');
      assert.match(body.messages.find((m) => m.tool_call_id === 'small').content, /héllo 🌍/);
      assert.equal(body.messages[0].role, 'user'); // the task itself is never trimmed
      assert.match(body.messages[0].content, /Inspect the fixture\./);
      res.end(frame({ content: 'STILL-WORKING' }, 'stop'));
    }
  }, { contextSize: 2000 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 4);
  assert.match(result.stdout, /\[context\] ~[\d.]+k? of 2\.0k tokens \(\d+%\) — compact mode on: older tool results and reasoning are trimmed from each request \(this one ~[\d.]+k?\)\. Please run \/compact to summarize the conversation and free space for good\./);
  assert.match(result.stdout, /· compact mode: request trimmed ~[\d.]+k? → ~[\d.]+k? tokens/);
  assert.match(result.stdout, /STILL-WORKING/);
  // History is intact: step 4 saw the full "small" result, and the nudge is printed once per crossing.
  assert.equal(result.stdout.split('compact mode on').length - 1, 1);
});
