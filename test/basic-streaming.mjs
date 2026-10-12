/* Standalone basic.mjs integration tests; no API credentials required. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const basic = fileURLToPath(new URL('../basic.mjs', import.meta.url));
const plan = 'IMPLEMENT PROMPT\n---\nInspect the fixture.\n---';
const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;

async function session(handler, configOptions = {}) {
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
    fs.writeFileSync(config, JSON.stringify({ ...configOptions, workspace: dir, openai: {
      baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: '', model: 'mock',
    } }));
    child = spawn(process.execPath, [basic, '--config', config, '--once', 'inspect'], {
      stdio: ['ignore', 'pipe', 'pipe'],
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
    fs.writeFileSync(config, JSON.stringify({ ...configOptions, workspace: dir, openai: {
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
  assert.doesNotMatch(result.stdout, /\x1b\[K/, 'no terminal redraws when stdout is a pipe');
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
