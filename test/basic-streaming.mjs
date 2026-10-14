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
  // Plans live outside the workspace, as they do by default: the two are never
  // the same directory, and that is what the CLI enforces.
  const plans = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-plans-'));
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
      await handler({ body, res, step: requests.length, waitForOutput, dir, plans });
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
    fs.writeFileSync(config, JSON.stringify({ planDir: plans, ...configOptions, workspace: dir, openai: {
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
    fs.rmSync(plans, { recursive: true, force: true });
  }
}

/**
 * Like session(), but keeps the child's stdin open so slash commands can be
 * driven one at a time — the CLI reads lines only while it is idle, so the
 * test must wait for a reply before sending the next command.
 */
async function interactive(handler, configOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-interactive-'));
  const plans = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-plans-'));
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
      await handler({ body, res, step: requests.length, dir, plans });
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
    fs.rmSync(plans, { recursive: true, force: true });
  };
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const config = path.join(dir, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ planDir: plans, ...configOptions, workspace: dir, openai: {
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
  // Memoized, so a test can finish() from a finally block as well as from the
  // happy path: a child left behind would keep the test runner alive for good.
  let finished = null;
  const finish = () => (finished ??= (async () => {
    child.stdin.end(); // the CLI is idle by now, so it sees EOF and exits
    const timeout = setTimeout(() => child.kill(), 5000);
    const [code] = await once(child, 'close').finally(() => clearTimeout(timeout));
    await cleanup();
    if (serverError) throw serverError;
    return { code, stdout, requests };
  })());
  return {
    send,
    waitNew,
    requests,
    /** Signal the CLI: 'SIGINT' is what Ctrl+C turns into for a piped stdin. */
    kill: (signal = 'SIGINT') => child.kill(signal),
    finish,
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
    // autoCompact off: this test is about the nudge, not the automatic summary.
  }, { contextSize: 2000, autoCompact: false });
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
    // autoCompact off, so /compact is the only thing that compacts here.
  }, { contextSize: 2000, autoCompact: false });

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

test('at 90% of the context window the conversation is compacted automatically', async () => {
  const big = `OLD ${'history '.repeat(1200)}`;
  const live = await interactive(({ res, step, body }) => {
    startSse(res);
    if (step === 2) { // the automatic compaction, before the next request is sent
      assert.match(body.messages.at(-1).content, /\[compaction request\]/);
      res.end(frame({ content: 'SUMMARY: inspected the fixture; nothing pending.' }, 'stop') + 'data: [DONE]\r\n\r\n');
    } else {
      res.end(frame({ content: step === 1 ? `IMPLEMENT PROMPT\n---\n${big}\n---` : 'REPLY-AFTER' }, 'stop') + 'data: [DONE]\r\n\r\n');
    }
  }, { contextSize: 2000 });

  live.send('/plan inspect the fixture');
  await live.waitNew('compacting automatically'); // as soon as the reply overflowed
  await live.waitNew('[compact] conversation:'); // no /compact needed
  live.send('/plan second question');
  await live.waitNew('REPLY-AFTER');
  const result = await live.finish();
  assert.equal(result.code, 0, result.stdout);
  // request 1: the plan turn · 2: the compaction · 3: the next question
  assert.match(result.requests[1].messages.at(-1).content, /\[compaction request\]/);
  const after = result.requests[2];
  assert.match(after.messages[1].content, /Earlier in this session \(compacted summary/);
  assert.match(after.messages[1].content, /SUMMARY: inspected the fixture/);
  assert.equal(JSON.stringify(after).includes('history history'), false, 'the old messages were dropped');
});

test('a request the server refuses for a full context is compacted and sent again', async () => {
  const big = `OLD ${'history '.repeat(1200)}`;
  const live = await interactive(({ res, step, body }) => {
    if (step === 2) { // "does not fit" — the window is full
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens" } }));
      return;
    }
    startSse(res);
    if (step === 1) {
      res.end(frame({ content: big }, 'stop') + 'data: [DONE]\r\n\r\n');
    } else if (step === 3) { // the compaction that refusal triggered
      assert.match(body.messages.at(-1).content, /\[compaction request\]/);
      res.end(frame({ content: 'SUMMARY: nothing pending.' }, 'stop') + 'data: [DONE]\r\n\r\n');
    } else {
      res.end(frame({ content: 'RETRY-OK' }, 'stop') + 'data: [DONE]\r\n\r\n');
    }
    // autoCompact off, so nothing compacts but the refusal handler below.
  }, { contextSize: 2000, autoCompact: false });

  live.send('/plan first question');
  await live.waitNew('[done] 1 step');
  live.send('/plan second question');
  await live.waitNew('compacting and sending it again'); // instead of losing the turn
  await live.waitNew('RETRY-OK');
  const result = await live.finish();
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.requests.length, 4, 'one refusal, one compaction, one retry');
  assert.match(result.requests[3].messages[1].content, /Earlier in this session \(compacted summary/);
  assert.match(result.requests[3].messages[1].content, /SUMMARY: nothing pending/);
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
  const result = await session(({ res, step, body, dir, plans }) => {
    planDir = plans; // outside the workspace: plan files are not part of the project
    startSse(res);
    if (step === 1) {
      // Tool descriptions carry the plan-mode rules.
      const tools = Object.fromEntries(body.tools.map((t) => [t.function.name, t.function.description]));
      assert.match(tools.write_file, /PLAN mode: only paths under \S+ may be written/);
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

test('a plan is recognised however the model decorates the IMPLEMENT PROMPT block', async () => {
  // The strict "IMPLEMENT PROMPT\n---\n…\n---" reading threw plans away: the
  // plan was plainly written, yet /implement had nothing to run.
  const replies = [
    ['I read the fixture.\n\n**IMPLEMENT PROMPT**\n***\nGoal: note the greeting.\n***\n\nShall I go on?', 'Goal: note the greeting.'],
    ['## Implement prompt:\n---\nGoal: tidy the tests.\n---', 'Goal: tidy the tests.'],
    ['Here it is:\n\n```\nIMPLEMENT PROMPT\n---\nGoal: quoted plan.\n---\n```', 'Goal: quoted plan.'],
    ['IMPLEMENT PROMPT\nGoal: no delimiters at all.', 'Goal: no delimiters at all.'],
  ];
  for (const [reply, expected] of replies) {
    const result = await session(({ res, step, body }) => {
      startSse(res);
      if (step === 1) res.end(frame({ content: reply }, 'stop'));
      else {
        // The implement prompt is the plan file's contents: the plan arrived.
        assert.match(body.messages[0].content, /^IMPLEMENT mode\./, reply);
        assert.ok(body.messages[0].content.endsWith(expected), `${reply}\n---\n${body.messages[0].content}`);
        res.end(frame({ content: 'DONE' }, 'stop'));
      }
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /saved plan → \S+plan-[\dT-]+\.md/, reply);
    assert.match(result.stdout, /\[implement\] plan: \S+\.md/, reply);
    assert.doesNotMatch(result.stdout, /no plan saved yet/, reply);
    assert.equal(result.requests.length, 2, reply);
  }
});

test('a plan written before the turn ends is not lost — an earlier reply counts', async () => {
  const result = await session(({ res, step, body }) => {
    startSse(res);
    if (step === 1) {
      // Prose and a tool call in the same reply, the plan already written.
      res.end(frame({ content: 'IMPLEMENT PROMPT\n---\nGoal: greet.\n---', tool_calls: [call('r', 'read_file', { path: 'fixture.txt' })] }, 'tool_calls'));
    } else if (step === 2) {
      assert.match(body.messages.find((m) => m.tool_call_id === 'r').content, /^file fixture\.txt — lines 1-1 of 1\n/);
      res.end(frame({ content: 'nothing more to add' }, 'stop')); // the turn ends on a later reply
    } else {
      assert.equal(step, 3);
      assert.match(body.messages[0].content, /^IMPLEMENT mode\./); // and the plan still ran
      res.end(frame({ content: 'DONE' }, 'stop'));
    }
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /saved plan → \S+plan-[\dT-]+\.md/);
  assert.match(result.stdout, /Goal: greet\./);
});

test('a plan cut off by the reply-token limit is saved and the cut is reported', async () => {
  const result = await session(({ res, step }) => {
    startSse(res);
    // finish_reason 'length': the reply stopped mid-block, no closing ---.
    if (step === 1) res.end(frame({ content: 'IMPLEMENT PROMPT\n---\nGoal: x\nSteps: 1' }, 'length'));
    else res.end(frame({ content: 'DONE' }, 'stop'));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\[truncated\] the reply hit the [\d.]+k? reply-token limit/, result.stdout);
  assert.match(result.stdout, /saved plan → \S+plan-[\dT-]+\.md/);
});

test('a PLAN reply without the block says so instead of leaving /implement empty-handed', async () => {
  const live = await interactive(({ res, step }) => {
    startSse(res);
    if (step === 1) res.end(frame({ content: 'The project looks fine, I would tidy the tests.' }, 'stop'));
    else res.end(frame({ content: 'DONE' }, 'stop'));
  });
  live.send('how is the project?');
  await live.waitNew('no IMPLEMENT PROMPT block in that reply');
  live.send('/implement');
  await live.waitNew('no plan saved yet — stay in /plan');
  await live.waitNew('/implement <instructions>');
  const result = await live.finish();
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.requests.length, 1, 'no implement turn ran');
});

test('paths are workspace-relative: outside paths are refused, results print relative paths', async () => {
  // the workspace is a fresh dir under os.tmpdir(), so "../x" escapes the project
  const outside = path.join(os.tmpdir(), 'basic-outside-target.txt');
  const result = await session(({ res, step, body }) => {
    startSse(res);
    if (step === 1) {
      res.end(frame({ tool_calls: [
        call('r1', 'read_file', { path: '../basic-outside-target.txt' }, 0),
        call('r2', 'read_file', { path: 'fixture.txt' }, 1),
      ] }, 'tool_calls'));
    } else if (step === 2) {
      const results = Object.fromEntries(body.messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content]));
      assert.match(results.r1, /^error: .* is outside the workspace/, results.r1);
      assert.match(results.r1, /[Pp]aths are relative to the workspace root/, results.r1);
      assert.match(results.r2, /^file fixture\.txt — lines 1-1 of 1\n {3}1\|héllo/, results.r2);
      res.end(frame({ content: 'IMPLEMENT PROMPT\n---\nGoal: x\n---' }, 'stop'));
    } else if (step === 3) {
      res.end(frame({ tool_calls: [call('w', 'write_file', { path: '../basic-outside-target.txt', content: 'pwned' })] }, 'tool_calls'));
    } else {
      const written = body.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
      assert.match(written, /^error: .*basic-outside-target\.txt is outside the workspace/m, written);
      res.end(frame({ content: 'DONE' }, 'stop'));
    }
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(outside), false, 'nothing may be written outside the workspace');
  assert.equal(result.requests.length, 4);
});

test('/implement accepts a plan file path or ad-hoc text, and /prompt shows the saved plan', async () => {
  const live = await interactive(({ res, step, body, plans }) => {
    startSse(res);
    if (step === 1) {
      assert.match(body.messages[0].content, /^IMPLEMENT mode\./);
      assert.match(body.messages[0].content, /saved at \S*basic-handwritten-\d+\.md\b/);
      assert.match(body.messages[0].content, /\n\nHand-written plan\.$/);
      res.end(frame({ content: 'FROM-FILE' }, 'stop'));
    } else if (step === 2) {
      assert.match(body.messages[0].content, /\n\nad hoc instructions$/);
      const file = body.messages[0].content.match(/saved at (\S+\.md)/)[1];
      assert.ok(file.startsWith(plans), file);
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

test('plans survive a restart: /plans lists them, /implement <n> runs one, and a new session resumes the last', async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-shared-plans-'));
  try {
    // Session one: a plan is written and implemented.
    const first = await session(({ res, step }) => {
      startSse(res);
      if (step === 1) res.end(frame({ content: 'IMPLEMENT PROMPT\n---\nGoal: resumed work.\n---' }, 'stop'));
      else res.end(frame({ content: 'FIRST-DONE' }, 'stop'));
    }, { planDir: shared });
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /saved plan → \S+plan-[\dT-]+\.md/);

    // Session two: the console reopens, remembers the plan, and runs it again.
    const live = await interactive(({ res, step, body }) => {
      startSse(res);
      if (step <= 2) {
        assert.match(body.messages[0].content, /^IMPLEMENT mode\./);
        assert.match(body.messages[0].content, /Goal: resumed work\./);
        res.end(frame({ content: `RESUMED-${step}` }, 'stop'));
        return;
      }
      res.end(frame({ content: 'UNUSED' }, 'stop'));
    }, { planDir: shared });

    await live.waitNew('workspace  (the project'); // the banner names the two apart
    await live.waitNew('plans      (outside the workspace)');
    await live.waitNew('last plan: '); // the previous session's plan is picked up
    live.send('/plans');
    await live.waitNew('plan directory (outside the workspace)');
    await live.waitNew('Goal: resumed work.'); // the listing shows what each plan is about
    live.send('/implement 1'); // by number, newest first
    await live.waitNew('RESUMED-1');
    live.send('/implement'); // and by memory
    await live.waitNew('RESUMED-2');
    const result = await live.finish();
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.requests.length, 2, 'the /plans listing sends no request');
  } finally {
    fs.rmSync(shared, { recursive: true, force: true });
  }
});

test('a planDir inside the workspace is moved out, so plans never land in the project', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-sepdir-'));
  const inside = path.join(dir, '.plans');
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(frame({ content: 'IMPLEMENT PROMPT\n---\nGoal: x\n---' }, 'stop') + 'data: [DONE]\r\n\r\n');
  });
  let child;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const config = path.join(dir, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ planDir: inside, workspace: dir, openai: {
      baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: '', model: 'mock',
    } }));
    child = spawn(process.execPath, [basic, '--config', config, '--once', 'inspect'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    await once(child, 'close');
    assert.match(stdout, /config planDir \S*\.plans is inside the workspace — using \S+ instead/);
    assert.equal(fs.existsSync(inside), false, 'no plan directory is created inside the project');
    const written = stdout.match(/saved plan → (\S+\.md)/)?.[1];
    assert.ok(written && !written.startsWith(dir), `plan written outside the project: ${written}`);
    fs.rmSync(written, { force: true }); // it went to the shared default directory
  } finally {
    child?.kill();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reading is token-lean: search_files finds code, list_files maps a directory, read_file reads a window', async () => {
  const result = await session(({ res, step, body, dir }) => {
    startSse(res);
    if (step === 1) {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/app.ts'), 'export const alpha = 1;\nexport const beta = 2;\n');
      fs.writeFileSync(path.join(dir, 'src/other.ts'), 'export const gamma = 3;\n');
      res.end(frame({ tool_calls: [
        call('s', 'search_files', { pattern: 'beta' }, 0),
        call('l', 'list_files', { path: '.', depth: 2 }, 1),
      ] }, 'tool_calls'));
    } else if (step === 2) {
      const results = Object.fromEntries(body.messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content]));
      // One call, one matching line — no file had to be read whole.
      assert.match(results.s, /^1 match\(es\) for \/beta\/ under/);
      assert.match(results.s, /src\/app\.ts:2: export const beta = 2;/);
      assert.doesNotMatch(results.s, /alpha/, 'only matching lines come back');
      assert.match(results.l, /# \. — \d+ dir\(s\), \d+ file\(s\)/);
      assert.match(results.l, /src\//);
      fs.writeFileSync(path.join(dir, 'big.ts'), Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n'));
      res.end(frame({ tool_calls: [call('r', 'read_file', { path: 'big.ts' })] }, 'tool_calls'));
    } else if (step === 3) {
      const read = body.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
      assert.match(read, /file big\.ts — lines 1-200 of 300/); // a window, not the file
      assert.match(read, /…\[100 more lines — read_file start_line=201/);
      assert.doesNotMatch(read, /\n 201\|/, 'the rest of the file stays out of the context');
      res.end(frame({ content: 'IMPLEMENT PROMPT\n---\nGoal: lean reads.\n---' }, 'stop'));
    } else {
      res.end(frame({ content: 'LEAN-DONE' }, 'stop'));
    }
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 4);
});

test('a whole read is capped, so a big file cannot flood the context', async () => {
  const result = await session(({ res, step, body, dir }) => {
    startSse(res);
    if (step === 1) {
      // 600 lines of 200 chars: more than one window's worth of characters.
      fs.writeFileSync(path.join(dir, 'dense.ts'), Array.from({ length: 600 }, (_, i) => `line ${i + 1} ${'y'.repeat(190)}`).join('\n'));
      res.end(frame({ tool_calls: [call('r', 'read_file', { path: 'dense.ts' })] }, 'tool_calls'));
    } else if (step === 2) {
      const read = body.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
      assert.ok(read.length < 18000, `one read is capped: ${read.length} chars`);
      assert.match(read, /…\[\d+ more lines — read_file start_line=\d+ to continue/);
      res.end(frame({ content: 'IMPLEMENT PROMPT\n---\nGoal: dense file.\n---' }, 'stop'));
    } else {
      res.end(frame({ content: 'DENSE-DONE' }, 'stop'));
    }
  });
  assert.equal(result.code, 0, result.stderr);
});

test('one over-long line is cut instead of eating the context', async () => {
  const result = await session(({ res, step, body, dir }) => {
    startSse(res);
    if (step === 1) {
      fs.writeFileSync(path.join(dir, 'min.js'), `${'x'.repeat(9000)}\nshort\n`);
      res.end(frame({ tool_calls: [call('r', 'read_file', { path: 'min.js' })] }, 'tool_calls'));
    } else if (step === 2) {
      const read = body.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
      assert.ok(read.length < 3000, `long line cut: ${read.length} chars`);
      assert.match(read, /… \(\+7000 chars\)/);
      assert.match(read, /short/);
      res.end(frame({ content: 'IMPLEMENT PROMPT\n---\nGoal: minified file.\n---' }, 'stop'));
    } else {
      res.end(frame({ content: 'MIN-DONE' }, 'stop'));
    }
  });
  assert.equal(result.code, 0, result.stderr);
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
  assert.match(result.stdout, /\[tool result\] read_file · ok · [\d.]+s · 2 lines\nfile .*fixture\.txt — lines 1-1 of 1\n   1\|héllo 🌍/);
});

test('compact mode trims older tool results from requests above 90% and asks for /compact, without touching history', async () => {
  // ~1.9k tokens across many lines: enough to cross 90% of 2000 on its own
  const huge = `${Array.from({ length: 60 }, (_, i) => `payload ${i} ${'x'.repeat(120)}`).join('\n')}\nEND-OF-PAYLOAD`;
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
    // autoCompact off: with it on, the conversation would be summarized
    // instead of trimmed, which is the test below.
  }, { contextSize: 2000, autoCompact: false });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 4);
  assert.match(result.stdout, /\[context\] ~[\d.]+k? of 2\.0k tokens \(\d+%\) — compact mode on: older tool results and reasoning are trimmed from each request \(this one ~[\d.]+k?\)\. Please run \/compact to summarize the conversation and free space for good\./);
  assert.match(result.stdout, /· compact mode: request trimmed ~[\d.]+k? → ~[\d.]+k? tokens/);
  assert.match(result.stdout, /STILL-WORKING/);
  // History is intact: step 4 saw the full "small" result, and the nudge is printed once per crossing.
  assert.equal(result.stdout.split('compact mode on').length - 1, 1);
});

/* ------------------------------------------------------------------ */
/* Ctrl+C interrupts and /reset                                        */
/* ------------------------------------------------------------------ */

test('/reset clears the conversation, so the next request starts fresh', async () => {
  const live = await interactive(({ res, step, body }) => {
    startSse(res);
    if (step === 2) {
      // After /reset the history holds nothing but the system prompt and the
      // new user message — the earlier turns are gone, not just trimmed.
      assert.equal(body.messages.length, 2);
      assert.equal(body.messages[0].role, 'system');
      assert.equal(body.messages[1].content, 'second question');
    }
    res.end(frame({ content: `REPLY-${step}` }, 'stop') + 'data: [DONE]\r\n\r\n');
  });

  let result = null;
  try {
    live.send('/plan first question');
    await live.waitNew('REPLY-1');
    live.send('/reset');
    await live.waitNew('conversation cleared');
    live.send('/plan second question');
    await live.waitNew('REPLY-2');
    result = await live.finish();
  } finally {
    if (!result) await live.finish().catch(() => {}); // a failed assertion must not leak the CLI
  }
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /\[reset\] conversation cleared — 2 messages dropped\. The next request starts fresh\./);
  assert.equal(result.requests.length, 2, '/reset must not talk to the model');
});

test('Ctrl+C stops an in-flight request without ending the session', async () => {
  const live = await interactive(({ res, step, body }) => {
    startSse(res);
    if (step === 1) {
      res.write(frame({ content: 'STREAMING-BEFORE-INTERRUPT' }));
      return; // never finish: the test interrupts this request instead
    }
    // The cut-short reply never entered the history, and the turn that owned
    // it did not ask again — only the new user message is here.
    assert.equal(body.messages.length, 3);
    assert.equal(body.messages.at(-1).content, 'after interrupt');
    assert.equal(body.messages.some((m) => m.role === 'assistant'), false, JSON.stringify(body.messages));
    res.end(frame({ content: 'REPLY-AFTER-INTERRUPT' }, 'stop') + 'data: [DONE]\r\n\r\n');
  });

  let result = null;
  try {
    live.send('/plan slow question');
    await live.waitNew('STREAMING-BEFORE-INTERRUPT'); // the request is in flight
    live.kill('SIGINT'); // Ctrl+C
    await live.waitNew('stopping the current execution');
    await live.waitNew('turn stopped — history is intact');
    live.send('/plan after interrupt'); // the session survived and still works
    await live.waitNew('REPLY-AFTER-INTERRUPT');

    live.kill('SIGINT'); // nothing is running now: Ctrl+C leaves the prompt
    await live.waitNew('interrupted — exiting');
    result = await live.finish();
  } finally {
    if (!result) await live.finish().catch(() => {}); // a failed assertion must not leak the CLI
  }
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.requests.length, 2);
});

test('Ctrl+C kills the command a tool started and ends the turn', async () => {
  const live = await interactive(({ res, step, body }) => {
    startSse(res);
    if (step === 1) {
      res.end(frame({ tool_calls: [call('sleep', 'run_command', { command: 'sleep 30', timeout_sec: 60 })] }, 'tool_calls'));
      return;
    }
    // The turn ended after the interrupted batch instead of asking again, and
    // the killed command answered with a result the model can read. The
    // history here is: system, user, assistant, tool, and the new user turn.
    assert.equal(body.messages.length, 5);
    assert.equal(body.messages.filter((m) => m.role === 'assistant').length, 1);
    assert.equal(body.messages.at(-1).content, 'after the kill');
    const killed = body.messages.find((m) => m.tool_call_id === 'sleep');
    assert.equal(killed.role, 'tool');
    assert.equal(killed.content, '(interrupted) exit null');
    res.end(frame({ content: 'REPLY-AFTER-KILL' }, 'stop') + 'data: [DONE]\r\n\r\n');
  });

  let result = null;
  try {
    live.send('/plan run a slow command');
    await live.waitNew('· running run_command…'); // the command is running
    live.kill('SIGINT'); // Ctrl+C
    await live.waitNew('stopping the current execution');
    await live.waitNew('turn stopped — history is intact');
    live.send('/plan after the kill');
    await live.waitNew('REPLY-AFTER-KILL');
    result = await live.finish();
  } finally {
    if (!result) await live.finish().catch(() => {}); // a failed assertion must not leak the CLI
  }
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.requests.length, 2, 'the interrupted turn sent no further request');
  assert.match(result.stdout, /\(interrupted\) exit null/);
});

test('--once exits 130 when Ctrl+C stops the run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-once-interrupt-'));
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-plans-'));
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(frame({ content: 'STILL-REQUESTING' })); // hold the stream open
  });
  let child;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const config = path.join(dir, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ planDir, workspace: dir, openai: {
      baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: '', model: 'mock',
    } }));
    child = spawn(process.execPath, [basic, '--config', config, '--once', 'slow task'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply in flight:\n${stdout}${stderr}`)), 5000);
      const check = () => {
        if (!stdout.includes('STILL-REQUESTING')) return;
        clearTimeout(timer);
        child.stdout.removeListener('data', check);
        resolve();
      };
      child.stdout.on('data', check);
    });
    child.kill('SIGINT'); // a TTY would deliver the same thing as Ctrl+C
    const timeout = setTimeout(() => child.kill(), 5000);
    const [code] = await once(child, 'close').finally(() => clearTimeout(timeout));
    assert.equal(code, 130, `${stdout}\n${stderr}`);
    assert.match(stdout, /stopping the current execution/);
    assert.match(stderr, /interrupted/);
  } finally {
    child?.kill();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(planDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* No step limit, and CRLF/LF handling                                 */
/* ------------------------------------------------------------------ */

test('a turn has no step limit: it runs past the old 40-step cap until the model finishes', async () => {
  const TOOL_STEPS = 45; // the plan request + 45 tool steps + the final reply
  const result = await session(({ res, step }) => {
    startSse(res);
    if (step === 1) {
      res.end(frame({ content: plan }, 'stop'));
    } else if (step <= 1 + TOOL_STEPS) {
      res.end(frame({ tool_calls: [call('r', 'read_file', { path: 'fixture.txt' })] }, 'tool_calls'));
    } else {
      assert.equal(step, 2 + TOOL_STEPS);
      res.end(frame({ content: 'LONG-DONE' }, 'stop'));
    }
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 2 + TOOL_STEPS, 'every step was requested — nothing stopped the turn early');
  assert.match(result.stdout, /step 45 · call 1\/1/, 'the step counter is a counter, not a budget');
  assert.match(result.stdout, /\[done\] 46 steps · 45 tool calls/);
  assert.match(result.stdout, /LONG-DONE/);
  assert.doesNotMatch(result.stdout + result.stderr, /max steps/);
});

test('CRLF and LF files keep their own line endings through reads, searches, edits and writes', async () => {
  const result = await session(({ res, step, body, dir }) => {
    startSse(res);
    if (step === 1) {
      fs.writeFileSync(path.join(dir, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
      fs.writeFileSync(path.join(dir, 'lf.txt'), 'one\ntwo\nthree\n');
      res.end(frame({ content: plan }, 'stop'));
    } else if (step === 2) {
      res.end(frame({ tool_calls: [
        call('read-crlf', 'read_file', { path: 'crlf.txt' }, 0),
        call('search-crlf', 'search_files', { pattern: 'two', path: '.' }, 1),
        // The model speaks LF for the CRLF file, and CRLF for the LF file:
        // both edits must land, and neither file may change style.
        call('edit-crlf', 'edit_file', { path: 'crlf.txt', old_text: 'two\nthree', new_text: 'TWO\nthree' }, 2),
        call('edit-lf', 'edit_file', { path: 'lf.txt', old_text: 'two\r\nthree', new_text: 'TWO\r\nthree' }, 3),
      ] }, 'tool_calls'));
    } else if (step === 3) {
      const results = Object.fromEntries(body.messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content]));
      assert.match(results['read-crlf'], /CRLF line endings \(shown as LF; edits keep CRLF\)/);
      assert.match(results['read-crlf'], /\n {3}2\|two\n/, 'lines are shown as LF');
      assert.doesNotMatch(results['read-crlf'], /\r/, 'no stray CR reaches the model');
      assert.match(results['search-crlf'], /crlf\.txt:2: two/);
      assert.doesNotMatch(results['search-crlf'], /\r/);
      assert.match(results['edit-crlf'], /^edited crlf\.txt \(CRLF line endings preserved\)/);
      assert.match(results['edit-lf'], /^edited lf\.txt/);
      assert.equal(fs.readFileSync(path.join(dir, 'crlf.txt'), 'utf8'), 'one\r\nTWO\r\nthree\r\n', 'CRLF file stayed CRLF');
      assert.equal(fs.readFileSync(path.join(dir, 'lf.txt'), 'utf8'), 'one\nTWO\nthree\n', 'LF file stayed LF');
      res.end(frame({ tool_calls: [
        call('write-crlf', 'write_file', { path: 'crlf.txt', content: 'a\nb\n' }, 0),
        call('write-new', 'write_file', { path: 'new.txt', content: 'a\r\nb\nc\r\n' }, 1),
      ] }, 'tool_calls'));
    } else {
      assert.equal(step, 4);
      assert.equal(fs.readFileSync(path.join(dir, 'crlf.txt'), 'utf8'), 'a\r\nb\r\n', 'an overwritten CRLF file keeps CRLF');
      const native = process.platform === 'win32' ? '\r\n' : '\n';
      assert.equal(
        fs.readFileSync(path.join(dir, 'new.txt'), 'utf8'),
        `a${native}b${native}c${native}`,
        'a new file gets the one OS style, never a mix'
      );
      res.end(frame({ content: 'EOL-DONE' }, 'stop'));
    }
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /EOL-DONE/);
});

test('/rewrite refines before planning, waits for confirmation, revises on feedback, and embeds the refined prompt in the plan file', async () => {
  const refinedV1 = 'Role: careful coding agent.\nGoal: inspect fixture.txt and report the greeting.';
  const refinedV2 = 'Role: careful coding agent.\nGoal: inspect fixture.txt and report the greeting.\nVerify: quote the exact line you read.';
  let planDirForTest;
  const live = await interactive(({ res, body, plans }) => {
    planDirForTest = plans;
    startSse(res);
    const system = body.messages[0]?.content || '';
    const last = body.messages.at(-1)?.content || '';
    if (system.includes('You are in REWRITE mode')) {
      const tools = Object.fromEntries((body.tools || []).map((t) => [t.function.name, t.function.description]));
      assert.match(tools.write_file, /REWRITE mode: only paths under \S+ may be written/);
      if (last.includes('Revise it using this feedback')) {
        assert.match(last, /make verification explicit/);
        assert.ok(JSON.stringify(body.messages).includes('report the greeting.'), 'the revision kept the first refined prompt in context');
        res.end(frame({ content: `REFINED PROMPT\n---\n${refinedV2}\n---` }, 'stop'));
      } else {
        assert.equal(last, 'fix the greeting thing');
        res.end(frame({ content: `REFINED PROMPT\n---\n${refinedV1}\n---` }, 'stop'));
      }
      return;
    }
    if (system.includes('You are in PLAN mode')) {
      // Planning received exactly the confirmed (revised) text, never the raw words.
      assert.equal(last, refinedV2);
      res.end(frame({ content: 'IMPLEMENT PROMPT\n---\nGoal: report the greeting in fixture.txt.\n---' }, 'stop'));
      return;
    }
    // IMPLEMENT mode: the plan file it runs from opens with the refined prompt.
    assert.match(body.messages[0].content, /^IMPLEMENT mode\./);
    assert.ok(body.messages[0].content.includes(`# Refined prompt\n\n${refinedV2}`), body.messages[0].content);
    assert.ok(body.messages[0].content.includes('Goal: report the greeting in fixture.txt.'), body.messages[0].content);
    res.end(frame({ content: 'REFINED-IMPLEMENTED' }, 'stop'));
  });

  let result = null;
  try {
    live.send('/rewrite fix the greeting thing');
    await live.waitNew('[refined]');
    live.send('/implement'); // a command cannot jump the confirmation gate
    await live.waitNew('a refined prompt is waiting for confirmation');
    live.send('make verification explicit');
    await live.waitNew('revising the refined prompt');
    await live.waitNew('[refined]');
    live.send(''); // blank line confirms
    await live.waitNew('saved plan');
    // The plan file itself opens with the refined prompt (no separate file).
    const saved = fs.readdirSync(planDirForTest).filter((n) => /^plan-.*\.md$/.test(n));
    assert.equal(saved.length, 1, saved.join(','));
    const planText = fs.readFileSync(path.join(planDirForTest, saved[0]), 'utf8');
    assert.ok(planText.startsWith(`# Refined prompt\n\n${refinedV2}`), planText);
    assert.ok(planText.includes('# Original request (superseded by the refined prompt above)\n\nfix the greeting thing'), planText);
    assert.ok(planText.includes('# Implement prompt\n\nGoal: report the greeting in fixture.txt.'), planText);
    live.send('/implement');
    await live.waitNew('REFINED-IMPLEMENTED');
    result = await live.finish();
  } finally {
    if (!result) await live.finish().catch(() => {}); // a failed assertion must not leak the CLI
  }
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.requests.length, 4, 'rewrite, revision, plan, implement');
  assert.match(result.stdout, /\[rewrite\] project read-only/);
  assert.match(result.stdout, /planning the confirmed refined prompt/);
});

test('config rewrite:true rewrites a --once task first, with the same read-only enforcement, and embeds it in the plan', async () => {
  const refined = 'Role: careful coding agent.\nGoal: inspect the fixture.\nVerify: read fixture.txt.';
  const result = await session(({ res, step, body, dir }) => {
    startSse(res);
    if (step === 1) {
      assert.match(body.messages[0].content, /You are in REWRITE mode/);
      assert.equal(body.messages.at(-1).content, 'inspect');
      res.end(frame({ tool_calls: [
        call('w', 'write_file', { path: 'component.ts', content: 'export const changed = true;' }, 0),
        call('r', 'read_file', { path: 'fixture.txt' }, 1),
      ] }, 'tool_calls'));
    } else if (step === 2) {
      const results = Object.fromEntries(body.messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content]));
      assert.match(results.w, /^error: REWRITE mode is read-only: .*component\.ts was not written/);
      assert.match(results.r, /^file fixture\.txt/);
      assert.equal(fs.existsSync(path.join(dir, 'component.ts')), false, 'rewrite mode must not create project files');
      res.end(frame({ content: `REFINED PROMPT\n---\n${refined}\n---` }, 'stop'));
    } else if (step === 3) {
      assert.match(body.messages[0].content, /You are in PLAN mode/);
      assert.equal(body.messages.at(-1).content, refined, 'planning received the refined prompt, not the raw task');
      res.end(frame({ content: 'IMPLEMENT PROMPT\n---\nGoal: inspect the fixture.\n---' }, 'stop'));
    } else {
      assert.equal(step, 4);
      assert.match(body.messages[0].content, /^IMPLEMENT mode\./);
      assert.ok(body.messages[0].content.includes(`# Refined prompt\n\n${refined}`), body.messages[0].content);
      assert.ok(body.messages[0].content.includes('# Original request (superseded by the refined prompt above)\n\ninspect'), body.messages[0].content);
      res.end(frame({ content: 'REWRITE-ONCE-DONE' }, 'stop'));
    }
  }, { rewrite: true });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 4, 'rewrite (2 steps), plan, implement');
  assert.match(result.stdout, /--once cannot ask for confirmation, so planning uses this refined prompt/);
  assert.match(result.stdout, /blocked by REWRITE mode/);
  assert.match(result.stdout, /REWRITE-ONCE-DONE/);
});

test('/rewrite on and off switch the phase per session, and /cancel drops a refined prompt unplanned', async () => {
  const live = await interactive(({ res, body }) => {
    startSse(res);
    const system = body.messages[0]?.content || '';
    if (system.includes('You are in REWRITE mode')) {
      res.end(frame({ content: 'REFINED PROMPT\n---\nGoal: a refined task.\n---' }, 'stop'));
      return;
    }
    assert.match(system, /You are in PLAN mode/, 'with rewrite off the task goes straight to planning');
    res.end(frame({ content: 'IMPLEMENT PROMPT\n---\nGoal: direct task.\n---' }, 'stop'));
  });

  let result = null;
  try {
    live.send('/rewrite');
    await live.waitNew('rewrite is off');
    live.send('/rewrite on');
    await live.waitNew('on — new tasks are refined and confirmed before planning');
    live.send('a vague task');
    await live.waitNew('[refined]');
    live.send('/cancel');
    await live.waitNew('refined prompt dropped — nothing was planned');
    live.send('/rewrite off');
    await live.waitNew('off — new tasks go straight to planning');
    live.send('a direct task');
    await live.waitNew('saved plan');
    result = await live.finish();
  } finally {
    if (!result) await live.finish().catch(() => {}); // a failed assertion must not leak the CLI
  }
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.requests.length, 2, 'one rewrite (cancelled) and one direct plan; /rewrite on/off/cancel call no model');
});

test('--help documents the rewrite phase and its config switch', () => {
  const r = spawnSync(process.execPath, [basic, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\/rewrite \[task\]/);
  assert.match(r.stdout, /config\s+rewrite: true/);
  assert.match(r.stdout, /--rewrite\|--no-rewrite|--rewrite/);
});

test('config rewrite must be a boolean', async () => {
  const result = await session(({ res }) => res.end('{}'), { rewrite: 'yes' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /config rewrite must be true or false/);
});

test('config lineEndings forces the style new files are written with', async () => {
  const result = await session(({ res, step, body, dir }) => {
    startSse(res);
    if (step === 1) {
      res.end(frame({ content: plan }, 'stop'));
    } else if (step === 2) {
      res.end(frame({ tool_calls: [call('w', 'write_file', { path: 'forced.txt', content: 'one\ntwo\n' })] }, 'tool_calls'));
    } else {
      assert.equal(step, 3);
      const written = body.messages.find((m) => m.tool_call_id === 'w');
      assert.match(written.content, /^wrote forced\.txt \(\d+ chars, CRLF line endings\)/);
      assert.equal(fs.readFileSync(path.join(dir, 'forced.txt'), 'utf8'), 'one\r\ntwo\r\n');
      res.end(frame({ content: 'FORCED-DONE' }, 'stop'));
    }
  }, { lineEndings: 'crlf' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /FORCED-DONE/);
});
