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
