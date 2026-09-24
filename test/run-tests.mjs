/* End-to-end tests for coding-harness. Run: npm test */

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const proj = path.dirname(here);
const harness = path.join(proj, 'harness.js');
const mockOpenai = path.join(here, 'mock-openai.mjs');
const fakeMcp = path.join(here, 'fake-mcp.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    if (extra) console.log('       ' + String(extra).replace(/\n/g, '\n       ').slice(0, 800));
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), out: String(stdout) + String(stderr) });
    });
  });
}

function startMockOpenai() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mockOpenai], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('mock server did not start')), 10000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /PORT (\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]) });
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (c) => reject(new Error('mock server exited early: ' + c)));
  });
}

function writeConfig(name, obj) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

function baseConfig(port) {
  return {
    openai: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'mock-model' },
    contextSize: 16000,
    maxTokens: 1024,
    temperature: 0,
    streaming: false,
    commandTimeout: 15,
    mcp: { servers: {} },
  };
}

async function main() {
  console.log(`coding-harness tests (tmp: ${tmp})`);

  /* ---------------- 0. built-in tools unit smoke ---------------- */
  console.log('\n[built-in tools]');
  const { createTools } = await import(pathToFileURL(path.join(proj, 'lib', 'tools.js')).href);
  const workA = path.join(tmp, 'workA');
  fs.mkdirSync(workA, { recursive: true });
  const tools = createTools({ workspace: workA, commandTimeout: 15, shell: null });

  let r = await tools.execute('write_file', { path: 'a/b.txt', content: 'one\ntwo\nthree' });
  check('write_file creates file', r.includes('Wrote'), r);
  r = await tools.execute('read_file', { path: 'a/b.txt' });
  check('read_file returns content', r.includes('two') && r.includes('lines 1-3 of 3'), r);
  r = await tools.execute('edit_file', { path: 'a/b.txt', old_text: 'two', new_text: 'TWO' });
  check('edit_file replaces', r.includes('Replaced 1'), r);
  r = await tools.execute('read_file', { path: 'a/b.txt' });
  check('edit_file wrote through', r.includes('TWO') && !r.includes('\ntwo'), r);
  r = await tools.execute('edit_file', { path: 'a/b.txt', old_text: 'nope', new_text: 'x' });
  check('edit_file reports missing text', r.startsWith('Error:'), r);
  r = await tools.execute('search_files', { pattern: 'TWO' });
  check('search_files finds match', r.includes('a/b.txt:2:'), r);
  r = await tools.execute('list_dir', { path: 'a' });
  check('list_dir lists', r.includes('b.txt'), r);
  r = await tools.execute('run_command', { command: process.platform === 'win32' ? 'echo hello' : 'echo hello && echo world' });
  check('run_command captures stdout', r.includes('hello') && r.includes('exit code: 0'), r);
  r = await tools.execute('run_command', { command: process.platform === 'win32' ? 'ver > nul' : 'exit 3' });
  check('run_command reports exit code', r.includes('exit code: 3'), r);
  r = await tools.execute('run_command', { command: 'this-command-should-not-exist-xyz' });
  check('run_command surfaces failures', r.length > 0, r);

  /* ---------------- start mock API ---------------- */
  const { child: mock, port } = await startMockOpenai();
  const workB = path.join(tmp, 'workB');
  fs.mkdirSync(workB, { recursive: true });

  /* ---------------- 1. non-streaming tool round-trip ---------------- */
  console.log('\n[chat, streaming off]');
  const cfg1 = writeConfig('cfg1.json', { ...baseConfig(port), workspace: workB });
  let res = await run(process.execPath, [harness, '--config', cfg1, '--no-stream', '--once', 'please write the file'], { cwd: workB });
  check('run exits 0', res.code === 0, res.out);
  check('shows user message', res.out.includes('You'), res.out);
  check('shows tool write_file', res.out.includes('write_file'), res.out);
  check('shows tool run_command', res.out.includes('run_command'), res.out);
  check('shows tool result (cat output)', res.out.includes('harness-ok'), res.out);
  check('shows final assistant reply', res.out.includes('MOCK-DONE'), res.out);
  check('file actually written in workspace', fs.readFileSync(path.join(workB, 'hello-harness.txt'), 'utf8') === 'harness-ok');

  /* ---------------- 2. streaming tool round-trip ---------------- */
  console.log('\n[chat, streaming on]');
  const cfg2 = writeConfig('cfg2.json', { ...baseConfig(port), streaming: true, workspace: workB });
  res = await run(process.execPath, [harness, '--config', cfg2, '--once', 'do it again, stream please'], { cwd: workB });
  check('stream run exits 0', res.code === 0, res.out);
  check('stream shows streamed reply', res.out.includes('MOCK-DONE'), res.out);
  check('stream shows tool calls', res.out.includes('write_file') && res.out.includes('run_command'), res.out);

  /* ---------------- 3. MCP tools ---------------- */
  console.log('\n[MCP]');
  const cfg3 = writeConfig('cfg3.json', {
    ...baseConfig(port),
    workspace: workB,
    mcp: { servers: { fake: { command: process.execPath, args: [fakeMcp] } } },
  });
  res = await run(process.execPath, [harness, '--config', cfg3, '--once', 'ADD2 please'], { cwd: workB });
  check('mcp run exits 0', res.code === 0, res.out);
  check('mcp server connected', res.out.includes('connected "fake"'), res.out);
  check('mcp tool advertised', res.out.includes('mcp_fake_add'), res.out);
  check('mcp tool called by model', res.out.includes('mcp_fake_add') && res.out.includes('a'), res.out);
  check('mcp tool result used', res.out.includes('MOCK-DONE add=42'), res.out);

  /* ---------------- 4. CLI plumbing ---------------- */
  console.log('\n[cli]');
  res = await run(process.execPath, [harness, '--help']);
  check('--help works', res.code === 0 && res.out.includes('Commands'), res.out);
  const cfgInit = path.join(tmp, 'sub', 'cfg-init.json');
  res = await run(process.execPath, [harness, '--config', cfgInit, '--init']);
  check('--init creates config', res.code === 0 && fs.existsSync(cfgInit), res.out);

  mock.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
