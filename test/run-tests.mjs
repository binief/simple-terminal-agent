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

/** Run the harness as an interactive session, feeding `input` on stdin. */
function runWithInput(args, input, opts = {}) {
  return new Promise((resolve) => {
    const { cwd, env, ...rest } = opts;
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...rest,
    });
    let out = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) child.kill();
    }, 60000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, out: out + String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done = true;
      resolve({ code: code ?? 1, out });
    });
    child.stdin.end(input);
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

  // windowed reads are enforced: peek by default, hard caps per call, continuation hints
  const big = Array.from({ length: 1200 }, (_, i) => `line-${i + 1}`).join('\n');
  await tools.execute('write_file', { path: 'big.txt', content: big });
  r = await tools.execute('read_file', { path: 'big.txt' });
  check('read_file peeks 200 lines by default', r.includes('lines 1-200 of 1200'), r.slice(0, 200));
  check('read_file hints at the remainder', r.includes('1000 more lines') && r.includes('search_files'), r.slice(-200));
  r = await tools.execute('read_file', { path: 'big.txt', limit: 5000 });
  check('read_file clamps limit to 500 lines per call', r.includes('lines 1-500 of 1200') && r.includes('clamped to 500'), r.slice(0, 200));
  r = await tools.execute('read_file', { path: 'big.txt', offset: 1101 });
  check('read_file pages with offset', r.includes('lines 1101-1200 of 1200') && !r.includes('more lines'), r.slice(0, 200));
  r = await tools.execute('read_file', { path: 'big.txt', offset: 2000 });
  check('read_file rejects past-the-end offsets', r.startsWith('Error:') && r.includes('past the end'), r);
  await tools.execute('write_file', { path: 'dense.txt', content: 'x'.repeat(50_000) + '\nsecond' });
  r = await tools.execute('read_file', { path: 'dense.txt' });
  check('read_file hard-cuts an oversized line', r.includes('[line truncated'), r.slice(-300));
  check('read_file result stays inside the char budget', r.length < 45_000, String(r.length));
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

  /* ---------------- 0b. line endings (Windows CRLF / old Mac CR) ---------------- */
  console.log('\n[line endings]');
  const eolDir = path.join(tmp, 'eol');
  fs.mkdirSync(eolDir, { recursive: true });
  const eolTools = createTools({ workspace: eolDir, commandTimeout: 15, shell: null });
  const readRaw = (p) => fs.readFileSync(path.join(eolDir, p), 'utf8');

  fs.writeFileSync(path.join(eolDir, 'win.txt'), 'alpha\r\nbeta\r\ngamma\r\n');
  r = await eolTools.execute('read_file', { path: 'win.txt' });
  check('read_file normalizes CRLF to LF', r.includes('alpha\nbeta\ngamma') && !r.includes('\r'), r);
  check('read_file reports CRLF', r.includes('CRLF'), r);
  r = await eolTools.execute('edit_file', { path: 'win.txt', old_text: 'beta', new_text: 'BETA' });
  check('edit_file matches LF old_text in a CRLF file', r.startsWith('Replaced 1'), r);
  check('edit_file writes CRLF back', readRaw('win.txt') === 'alpha\r\nBETA\r\ngamma\r\n', JSON.stringify(readRaw('win.txt')));
  r = await eolTools.execute('edit_file', { path: 'win.txt', old_text: 'alpha\r\nBETA', new_text: 'one\ntwo' });
  check('edit_file accepts CRLF old_text too', r.startsWith('Replaced 1'), r);
  check('multiline replacement keeps CRLF', readRaw('win.txt') === 'one\r\ntwo\r\ngamma\r\n', JSON.stringify(readRaw('win.txt')));
  r = await eolTools.execute('search_files', { pattern: 'two' });
  check('search_files reads CRLF files', r.includes('win.txt:2:'), r);
  r = await eolTools.execute('write_file', { path: 'win.txt', content: 'a\nb\n' });
  check('write_file keeps the file CRLF style', readRaw('win.txt') === 'a\r\nb\r\n', JSON.stringify(readRaw('win.txt')));
  r = await eolTools.execute('write_file', { path: 'fresh.txt', content: 'a\nb' });
  check('write_file uses the OS newline for new files', readRaw('fresh.txt') === 'a' + os.EOL + 'b', JSON.stringify(readRaw('fresh.txt')));

  fs.writeFileSync(path.join(eolDir, 'cr.txt'), 'a\rb\rc\r');
  r = await eolTools.execute('read_file', { path: 'cr.txt' });
  check('CR-only file is normalized', r.includes('a\nb\nc') && r.includes('CR line'), r);
  r = await eolTools.execute('edit_file', { path: 'cr.txt', old_text: 'b', new_text: 'B' });
  check('edit_file handles CR-only files', r.startsWith('Replaced 1') && readRaw('cr.txt') === 'a\rB\rc\r', JSON.stringify(readRaw('cr.txt')));

  // multi-line old_text that only differs by invisible trailing whitespace / \r
  fs.writeFileSync(path.join(eolDir, 'ws.txt'), 'alpha   \r\nbeta\r\ngamma\r\n');
  r = await eolTools.execute('edit_file', { path: 'ws.txt', old_text: 'alpha\nbeta', new_text: 'done' });
  check('edit_file falls back to whitespace-tolerant matching', r.startsWith('Replaced 1') && r.includes('trailing whitespace'), r);
  check('whitespace-tolerant edit keeps CRLF', readRaw('ws.txt') === 'done\r\ngamma\r\n', JSON.stringify(readRaw('ws.txt')));

  fs.writeFileSync(path.join(eolDir, 'dollar.txt'), 'value here\n');
  r = await eolTools.execute('edit_file', { path: 'dollar.txt', old_text: 'value here', new_text: 'cost $& $1 100%' });
  check('replacement keeps $ sequences literal', readRaw('dollar.txt') === 'cost $& $1 100%\n', JSON.stringify(readRaw('dollar.txt')));

  const lfTools = createTools({ workspace: eolDir, commandTimeout: 15, shell: null, lineEndings: 'lf' });
  fs.writeFileSync(path.join(eolDir, 'win.txt'), 'a\r\nb\r\n');
  r = await lfTools.execute('write_file', { path: 'win.txt', content: 'a\nb\n' });
  check('lineEndings: "lf" overrides the file style', readRaw('win.txt') === 'a\nb\n', JSON.stringify(readRaw('win.txt')));
  const crlfTools = createTools({ workspace: eolDir, commandTimeout: 15, shell: null, lineEndings: 'crlf' });
  r = await crlfTools.execute('edit_file', { path: 'dollar.txt', old_text: 'cost', new_text: 'price' });
  check('lineEndings: "crlf" forces CRLF on edit', readRaw('dollar.txt') === 'price $& $1 100%\r\n', JSON.stringify(readRaw('dollar.txt')));

  const { loadConfig, maskConfig } = await import(pathToFileURL(path.join(proj, 'lib', 'config.js')).href);
  const cfgEolPath = writeConfig('cfg-eol.json', { ...baseConfig(1), lineEndings: 'banana' });
  const { config: cfgEol } = loadConfig(cfgEolPath);
  check('unknown lineEndings falls back to auto', cfgEol.lineEndings === 'auto', JSON.stringify(cfgEol.lineEndings));

  /* ---------------- 0d. search ignores (junk dirs, .gitignore) ---------------- */
  console.log('\n[search ignores]');
  const { isSkippedDirName, isSkippedFileName, globToRegExp, parseGitignore } = await import(
    pathToFileURL(path.join(proj, 'lib', 'ignore.js')).href
  );
  check(
    'junk/cache directories are skipped by name',
    ['.angular', '.cache', 'node_modules', '.venv', '.next', 'dist', 'coverage', 'cmake-build-debug', 'pkg.egg-info'].every(isSkippedDirName),
    'one of them is not skipped'
  );
  check(
    'source directories are kept',
    ['src', 'app', 'lib', 'bin', 'docs', 'test', '.github', 'vendor'].every((n) => !isSkippedDirName(n)),
    'a source directory would be skipped'
  );
  check(
    'binary/media files are skipped',
    ['.png', '.jpg', '.mp4', '.zip', '.exe', '.woff2', '.sqlite3'].every((ext) => isSkippedFileName('file' + ext)),
    'a binary file would be grepped'
  );
  check(
    'source files are kept',
    ['main.ts', 'app.tsx', 'index.js', 'style.scss', 'data.json', 'ci.yml', 'notes.md'].every((n) => !isSkippedFileName(n)),
    'a source file would be skipped'
  );
  check('glob: "**"/ matches at any depth', globToRegExp('**/x.js').test('a/b/x.js') && globToRegExp('**/x.js').test('x.js'), 'no');
  check('glob: "*" stops at a slash', globToRegExp('a/*.js').test('a/b.js') && !globToRegExp('a/*.js').test('a/b/c.js'), 'no');
  check('glob: "?" is one character', globToRegExp('a?.js').test('ab.js') && !globToRegExp('a?.js').test('a/.js'), 'no');

  const gi = parseGitignore('# comment\n\nbuild/\n!keep.js\n/anchored.txt\n**/deep/*.log\n');
  check('gitignore: comments and blank lines are dropped', gi.length === 4, JSON.stringify(gi.map((x) => x.re.source)));
  check('gitignore: a trailing slash means directories only', gi[0].dirOnly === true && gi[0].negated === false, JSON.stringify(gi[0]));
  check('gitignore: "!" negates', gi[1].negated === true, JSON.stringify(gi[1]));
  check('gitignore: a leading slash anchors the pattern', gi[2].anchored === true && gi[2].re.test('anchored.txt') && !gi[2].re.test('sub/anchored.txt'), JSON.stringify(gi[2]));

  const proj2 = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(proj2, '.git', 'info'), { recursive: true });
  const put = (rel, text) => {
    const f = path.join(proj2, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  put('src/app.js', "const target = 'FIND-ME';\n");
  put('.angular/cache/cache.js', 'FIND-ME angular cache\n');
  put('node_modules/pkg/index.js', 'FIND-ME dependency\n');
  put('dist/bundle.js', 'FIND-ME bundle\n');
  put('coverage/index.html', 'FIND-ME coverage\n');
  put('ignored/secret.js', 'FIND-ME ignored\n');
  put('src/generated.gen.js', 'FIND-ME generated\n');
  put('src/logo.png', 'FIND-ME image\n');
  put('src/app.local.js', 'FIND-ME local\n');
  put('nested/thing.local.js', 'FIND-ME nested\n');
  put('.gitignore', 'ignored/\n*.gen.js\n*.local.js\n');
  put('src/.gitignore', '!app.local.js\n'); // a nested file can re-include what the root ignored

  const searchTools = createTools({ workspace: proj2, commandTimeout: 15, shell: null });
  r = await searchTools.execute('search_files', { pattern: 'FIND-ME' });
  check('search_files finds source matches', r.includes('src/app.js:1:'), r);
  check('search_files skips .angular/cache', !r.includes('.angular'), r);
  check('search_files skips node_modules', !r.includes('node_modules'), r);
  check('search_files skips build output', !r.includes('dist/') && !r.includes('coverage/'), r);
  check('search_files honours .gitignore', !r.includes('ignored/secret.js') && !r.includes('generated.gen.js'), r);
  check('a nested .gitignore can re-include a path', r.includes('src/app.local.js') && !r.includes('nested/thing.local.js'), r);
  check('search_files skips binary files', !r.includes('logo.png'), r);
  r = await searchTools.execute('search_files', { pattern: 'FIND-ME', include_ignored: true });
  check('include_ignored searches caches and dependencies', r.includes('.angular/cache/cache.js') && r.includes('node_modules/pkg/index.js'), r);
  check('include_ignored searches .gitignore paths', r.includes('ignored/secret.js') && r.includes('generated.gen.js'), r);
  r = await searchTools.execute('search_files', { pattern: 'NO-SUCH-TEXT-XYZ' });
  check('a search with no hits says what was skipped', r.startsWith('No matches') && r.includes('include_ignored'), r);
  r = await searchTools.execute('search_files', { pattern: 'FIND-ME', path: 'ignored' });
  check('searching inside a skipped directory explicitly still works', r.includes('ignored/secret.js'), r);

  const extraTools = createTools({ workspace: proj2, commandTimeout: 15, shell: null, searchIgnore: ['vendor-cache/', '!ignored'] });
  put('vendor-cache/dep.js', 'FIND-ME vendored\n');
  r = await extraTools.execute('search_files', { pattern: 'FIND-ME' });
  check('config searchIgnore skips extra paths', !r.includes('vendor-cache'), r);
  check('config searchIgnore can re-include a path', r.includes('ignored/secret.js'), r);

  /* ---------------- 0e. multiline input rules ---------------- */
  console.log('\n[multiline input]');
  const { createComposer, splitContinuation, createEscapeEnterScanner, createInputReader } = await import(
    pathToFileURL(path.join(proj, 'lib', 'input.js')).href
  );
  const compose = (specs) => {
    const c = createComposer();
    const out = [];
    for (const spec of specs) {
      const [text, opts] = Array.isArray(spec) ? spec : [spec];
      const message = c.push(text, opts || {});
      if (message != null) out.push(message);
    }
    return out;
  };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  check('a plain line is one message', eq(compose(['hello']), ['hello']), JSON.stringify(compose(['hello'])));
  check('a blank line alone sends nothing', compose(['   ']).length === 0, JSON.stringify(compose(['   '])));
  check('a trailing backslash keeps composing', eq(compose(['first \\', 'second']), ['first \nsecond']), JSON.stringify(compose(['first \\', 'second'])));
  check('an escaped backslash is literal', eq(compose(['a\\\\']), ['a\\\\']), JSON.stringify(compose(['a\\\\'])));
  check('splitContinuation strips the continuation backslash', eq(splitContinuation('a \\'), { text: 'a ', continued: true }), JSON.stringify(splitContinuation('a \\')));
  check('splitContinuation leaves an escaped backslash alone', splitContinuation('a\\\\').continued === false, JSON.stringify(splitContinuation('a\\\\')));
  check(
    'Shift+Enter lines stay in the draft',
    eq(compose([['a', { continuation: true }], ['b', { continuation: true }], ['']]), ['a\nb']),
    JSON.stringify(compose([['a', { continuation: true }], ['b', { continuation: true }], ['']]))
  );
  check('blank lines inside a draft survive', eq(compose(['head \\', '\\', '  indented']), ['head \n\n  indented']), JSON.stringify(compose(['head \\', '\\', '  indented'])));
  check('a draft keeps first-line indentation', eq(compose(['  code \\', 'more']), ['  code \nmore']), JSON.stringify(compose(['  code \\', 'more'])));
  check('a draft can be dropped', (() => { const c = createComposer(); c.push('x \\'); c.reset(); return c.pending === 0 && c.push('y') === 'y'; })(), 'draft survived reset');

  const scan = createEscapeEnterScanner();
  check('ESC+CR is detected', scan.scan('ab\x1b\rc') === 1, 'not found');
  check('an ESC+CR split across reads is detected', scan.scan('\x1b') === 0 && scan.scan('\r') === 1, 'not found');
  check('a lone ESC or CR is not Shift+Enter', scan.scan('\x1b') === 0 && scan.scan('x') === 0 && scan.scan('\r') === 0, 'false positive');

  const { EventEmitter } = await import('node:events');
  const makeFakeRl = () => {
    const bus = new EventEmitter();
    return {
      bus,
      line: '',
      current: '',
      prompts: [],
      setPrompt(p) { this.current = p; },
      prompt() { this.prompts.push(this.current); },
      write(_d, key) {
        if (key?.name === 'return') {
          const line = this.line;
          this.line = '';
          bus.emit('line', line); // readline clears the line before emitting
        }
      },
      on: (ev, fn) => bus.on(ev, fn),
      emit: (ev, ...args) => bus.emit(ev, ...args),
    };
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  const msgs = [];
  const rl1 = makeFakeRl();
  const stdin1 = new EventEmitter();
  const reader = createInputReader({
    rl: rl1,
    stdin: stdin1,
    isTty: true,
    prompt: '> ',
    continuationPrompt: '| ',
    onMessage: (m) => msgs.push(m),
  });
  rl1.emit('line', 'hello');
  await tick();
  check('reader: a plain line is sent right away', eq(msgs, ['hello']), JSON.stringify(msgs));
  check('reader: the plain prompt comes back', rl1.prompts.at(-1) === '> ', JSON.stringify(rl1.prompts));

  rl1.line = 'first';
  stdin1.emit('data', '\x1b\r'); // Shift+Enter
  await tick();
  check('reader: Shift+Enter opens a draft instead of sending', msgs.length === 1 && reader.pending === 1, JSON.stringify(msgs));
  check('reader: the continuation prompt is shown', rl1.prompts.at(-1) === '| ', JSON.stringify(rl1.prompts));
  rl1.emit('line', 'second');
  await tick();
  check('reader: the draft is sent as one message', eq(msgs, ['hello', 'first\nsecond']), JSON.stringify(msgs));

  rl1.emit('line', 'one');
  rl1.emit('line', 'two');
  await tick();
  check('reader: a multi-line paste becomes a draft', msgs.length === 2 && reader.pending === 2, JSON.stringify(msgs));
  rl1.emit('line', 'three');
  await tick();
  check('reader: the pasted draft is sent whole', msgs.at(-1) === 'one\ntwo\nthree', JSON.stringify(msgs));

  rl1.emit('line', 'kept \\');
  await tick();
  reader.discard();
  rl1.emit('line', 'fresh');
  await tick();
  check('reader: a discarded draft does not leak', reader.pending === 0 && msgs.at(-1) === 'fresh', JSON.stringify(msgs));

  rl1.emit('line', 'left over \\');
  await tick();
  reader.flushDraft();
  check('reader: a draft left at EOF is still sent', msgs.at(-1) === 'left over', JSON.stringify(msgs));

  const msgs2 = [];
  const rl2 = makeFakeRl();
  const reader2 = createInputReader({ rl: rl2, stdin: null, isTty: false, onMessage: (m) => msgs2.push(m) });
  rl2.emit('line', 'one');
  rl2.emit('line', 'two');
  check('reader: piped lines are not batched as a paste', eq(msgs2, ['one', 'two']), JSON.stringify(msgs2));
  rl2.emit('line', 'cont \\');
  rl2.emit('line', 'inued');
  check('reader: piped input supports the backslash continuation', msgs2.at(-1) === 'cont \ninued', JSON.stringify(msgs2));

  /* ---------------- 0c. system prompt: work method + custom instructions ---------------- */
  console.log('\n[system prompt]');
  const { createAgent, resolveInstructions } = await import(pathToFileURL(path.join(proj, 'lib', 'agent.js')).href);
  const promptDir = path.join(tmp, 'prompt');
  fs.mkdirSync(promptDir, { recursive: true });
  const promptCfg = { ...baseConfig(1), workspace: promptDir, streaming: false };
  const makeAgent = (extra = {}, cfg = {}) => {
    const c = { ...promptCfg, ...cfg, ...extra };
    return createAgent({ config: c, builtins: createTools(c), mcp: null });
  };
  const sysOf = (agent) => String(agent.history[0]?.content ?? '');

  let sys = sysOf(makeAgent());
  check('system prompt states the workspace', sys.includes(promptDir), sys.slice(0, 400));
  check('system prompt states the platform/shell', sys.includes('shell:'), sys.slice(0, 400));
  check('system prompt carries the work method', sys.includes('Work method:'), sys);
  check('work method: understand before changing', /Understand before changing/.test(sys), sys);
  check('work method: batch independent tool calls', /several tool calls in one reply/.test(sys), sys);
  check('work method: never rewrite an unread file', /never rewrite a file you have not read/.test(sys), sys);
  check('work method: no loops — report the blocker', /report the blocker/.test(sys), sys);
  check('work method: verify before claiming success', /Verify before claiming success/.test(sys), sys);
  check('work method: follow the conventions of the code', /Match the code you are editing/.test(sys), sys);
  check('tool policy: old_text copied verbatim', /old_text copied verbatim from read_file/.test(sys), sys);
  check('tool policy: destructive commands are announced', /destructive step/.test(sys), sys);
  check('no user-instructions section by default', !sys.includes('User instructions'), sys);

  sys = sysOf(makeAgent({ instructions: 'Use pnpm, not npm.\nAlways run node --test.' }));
  check('config instructions land in the system prompt', sys.includes('Use pnpm, not npm.') && sys.includes('User instructions'), sys);
  check('instructions come after the built-in defaults', sys.indexOf('Work method:') < sys.indexOf('Use pnpm'), sys);

  const rulesFile = path.join(promptDir, 'RULES.md');
  fs.writeFileSync(rulesFile, 'RULES-FILE: only commit when asked.\n');
  const fileAgent = makeAgent({ instructions: 'RULES.md' }); // relative to the workspace
  check('instructions file is read (relative path)', sysOf(fileAgent).includes('RULES-FILE: only commit when asked.'), sysOf(fileAgent));
  fs.writeFileSync(rulesFile, 'RULES-FILE: amended.\n');
  fileAgent.refreshSystem();
  check('instructions file is re-read on refreshSystem', sysOf(fileAgent).includes('RULES-FILE: amended.'), sysOf(fileAgent));
  check('instructions file is read (absolute path)', sysOf(makeAgent({ instructions: rulesFile })).includes('RULES-FILE: amended.'), sysOf(makeAgent({ instructions: rulesFile })));
  check('resolveInstructions falls back to literal text', resolveInstructions('no such file xyz.md', promptDir) === 'no such file xyz.md', resolveInstructions('no such file xyz.md', promptDir));
  check('resolveInstructions returns "" when unset', resolveInstructions(null, promptDir) === '' && resolveInstructions('   ', promptDir) === '', JSON.stringify(resolveInstructions(null, promptDir)));

  process.env.HARNESS_INSTRUCTIONS = 'env rules: keep it terse';
  const { config: cfgInsEnv } = loadConfig(writeConfig('cfg-ins-env.json', baseConfig(1)));
  delete process.env.HARNESS_INSTRUCTIONS;
  check('HARNESS_INSTRUCTIONS overrides config', cfgInsEnv.instructions === 'env rules: keep it terse', JSON.stringify(cfgInsEnv.instructions));
  const { config: cfgIns } = loadConfig(writeConfig('cfg-ins.json', { ...baseConfig(1), instructions: 'line one\nline two' }));
  check('config keeps multi-line instructions', cfgIns.instructions === 'line one\nline two', JSON.stringify(cfgIns.instructions));
  check('an empty instructions value becomes null', loadConfig(writeConfig('cfg-ins-empty.json', { ...baseConfig(1), instructions: '  ' })).config.instructions === null, 'not null');
  check('/config view flattens instructions to one line', maskConfig(cfgIns).instructions === 'line one line two', JSON.stringify(maskConfig(cfgIns).instructions));

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
  check('shows a progress line while waiting', res.out.includes('thinking…'), res.out);
  check('usage line reports prompt tokens', res.out.includes('111 in'), res.out);
  check('usage line reports completion tokens', res.out.includes('22 out'), res.out);
  check('usage line reports speed', res.out.includes('tok/s'), res.out);
  check('usage line reports context fill', res.out.includes('context '), res.out);

  /* ---------------- 2. streaming tool round-trip ---------------- */
  console.log('\n[chat, streaming on]');
  const cfg2 = writeConfig('cfg2.json', { ...baseConfig(port), streaming: true, workspace: workB });
  res = await run(process.execPath, [harness, '--config', cfg2, '--once', 'do it again, stream please'], { cwd: workB });
  check('stream run exits 0', res.code === 0, res.out);
  check('stream shows streamed reply', res.out.includes('MOCK-DONE'), res.out);
  check('stream shows tool calls', res.out.includes('write_file') && res.out.includes('run_command'), res.out);
  check('streamed usage is collected', res.out.includes('222 in') && res.out.includes('33 out'), res.out);

  /* ---------------- 2b. custom instructions reach the model ---------------- */
  console.log('\n[custom instructions]');
  const cfgInsInline = writeConfig('cfg-ins-inline.json', {
    ...baseConfig(port),
    workspace: workB,
    instructions: 'HAIKU-RULE: reply in haiku only.',
  });
  res = await run(process.execPath, [harness, '--config', cfgInsInline, '--no-stream', '--once', 'hello'], { cwd: workB });
  check('inline instructions reach the system message', res.out.includes('MOCK-DONE instructions-seen'), res.out);

  const insFile = path.join(tmp, 'AGENT-RULES.md');
  fs.writeFileSync(insFile, 'HAIKU-RULE from a file.\n');
  const cfgInsFile = writeConfig('cfg-ins-file.json', { ...baseConfig(port), workspace: workB, instructions: insFile });
  res = await run(process.execPath, [harness, '--config', cfgInsFile, '--no-stream', '--once', 'hello'], { cwd: workB });
  check('instructions file reaches the system message', res.out.includes('MOCK-DONE instructions-seen'), res.out);

  /* ---------------- 2c. multiline input over a pipe ---------------- */
  console.log('\n[multiline input, piped]');
  res = await runWithInput([harness, '--config', cfg1, '--no-stream'], 'MULTILINE-PROBE alpha \\\nthen beta\n', { cwd: workB });
  check('a continued line and the next line arrive as one message', res.out.includes('MOCK-DONE users=1 multiline=true'), res.out);
  check('the composed message is echoed as one block', res.out.includes('MULTILINE-PROBE alpha') && res.out.includes('then beta'), res.out);

  res = await runWithInput([harness, '--config', cfg1, '--no-stream'], 'MULTILINE-PROBE plain\n', { cwd: workB });
  check('a single line is still a single message', res.out.includes('MOCK-DONE users=1 multiline=false'), res.out);

  res = await runWithInput([harness, '--config', cfg1, '--no-stream'], 'MULTILINE-PROBE tail \\\n', { cwd: workB });
  check('a draft left over at EOF is still sent', res.out.includes('MOCK-DONE users=1'), res.out);

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

  /* ---------------- 3b. session commands (/set dir, /cwd) ---------------- */
  console.log('\n[session commands]');
  const workC = path.join(tmp, 'work with space'); // exercises quoted paths
  fs.mkdirSync(workC, { recursive: true });

  res = await runWithInput([harness, '--config', cfg1, '--no-stream'], '/help\n', { cwd: workB });
  check('/help lists /set dir', res.code === 0 && res.out.includes('/set dir'), res.out);
  check('/help lists /cwd', res.out.includes('/cwd'), res.out);

  res = await runWithInput([harness, '--config', cfg1, '--no-stream'], `/set dir "${workC}"\nplease write the file\n`, { cwd: workB });
  check('/set dir accepts quoted paths', res.code === 0 && res.out.includes('working directory set to'), res.out);
  check('/set dir announces the new path', res.out.includes(workC), res.out);
  check('tools write into the new directory', fs.existsSync(path.join(workC, 'hello-harness.txt')), res.out);
  check('old workspace untouched by the new dir', fs.readFileSync(path.join(workB, 'hello-harness.txt'), 'utf8') === 'harness-ok');

  res = await runWithInput([harness, '--config', cfg1, '--no-stream'], '/set dir\n/cwd\n/help\n', { cwd: workB });
  check('/set dir with no argument shows the dir', (res.out.match(/working directory:/g) || []).length >= 2, res.out);
  check('/cwd shows the workspace', res.out.includes(workB), res.out);

  res = await runWithInput([harness, '--config', cfg1, '--no-stream'], '/set dir does-not-exist-xyz\n', { cwd: workB });
  check('/set dir rejects a missing directory', res.out.includes('no such directory'), res.out);

  res = await runWithInput([harness, '--config', cfg1, '--no-stream'], '/set model foo\n', { cwd: workB });
  check('/set with a bad key shows usage', res.out.includes('usage: /set dir'), res.out);

  res = await runWithInput([harness, '--config', cfg1, '--no-stream'], '/usage\n', { cwd: workB });
  check('/usage reports session totals', res.out.includes('session ') && res.out.includes('tokens'), res.out);
  check('/usage reports context fill', res.out.includes('context '), res.out);

  res = await runWithInput([harness, '--config', cfg1, '--no-stream'], '/usage\n/compact\n', { cwd: workB });
  check('/compact on an empty session is a no-op', res.out.includes('nothing to compact'), res.out);

  res = await runWithInput(
    [harness, '--config', cfg1, '--no-stream'],
    'please write the file\n/compact\nplease write the file\n',
    { cwd: workB }
  );
  check('/compact summarizes the conversation', res.out.includes('compacted conversation:'), res.out);
  check('/compact frees tokens', /compacted conversation: [\d.,kM]+ → [\d.,kM]+ tokens/.test(res.out), res.out);
  check('session continues after /compact', (res.out.match(/MOCK-DONE/g) || []).length >= 2, res.out);
  check('/compact usage is counted', /\/usage|session/.test(res.out), res.out);

  /* ---------------- 3c. automatic compaction ---------------- */
  console.log('\n[auto-compaction]');
  // createAgent was imported with the system-prompt section above
  const workE = path.join(tmp, 'workE');
  fs.mkdirSync(workE, { recursive: true });
  const smallConfig = { ...baseConfig(port), contextSize: 2000, maxTokens: 256, workspace: workE, streaming: false, autoCompact: true };
  const agentE = createAgent({ config: smallConfig, builtins: createTools(smallConfig), mcp: null });
  agentE.history.push({ role: 'user', content: 'filler filler '.repeat(1200) }); // pushes past the budget

  let captured = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    captured += String(chunk);
    return true;
  };
  try {
    await agentE.turn('continue please');
  } finally {
    process.stdout.write = origWrite;
  }
  check('auto-compaction triggers before the context fills', captured.includes('compacted conversation'), captured.slice(0, 600));
  check('summary is kept in history', agentE.history.some((m) => String(m.content ?? '').includes('COMPACTED:')), JSON.stringify(agentE.history.map((m) => m.role)));
  check('turn continues after auto-compaction', captured.includes('MOCK-DONE'), captured.slice(0, 600));
  check('tools still work after auto-compaction', fs.existsSync(path.join(workE, 'hello-harness.txt')), captured.slice(0, 600));
  check('auto-compaction is counted in stats', agentE.stats().compactions === 1, JSON.stringify(agentE.stats()));

  // autoCompact: false -> warn instead of summarizing
  const workF = path.join(tmp, 'workF');
  fs.mkdirSync(workF, { recursive: true });
  const offConfig = { ...smallConfig, workspace: workF, autoCompact: false };
  const agentF = createAgent({ config: offConfig, builtins: createTools(offConfig), mcp: null });
  agentF.history.push({ role: 'user', content: 'filler filler '.repeat(1200) });
  captured = '';
  process.stdout.write = (chunk, ...rest) => {
    captured += String(chunk);
    return true;
  };
  try {
    await agentF.turn('continue please');
  } finally {
    process.stdout.write = origWrite;
  }
  check('autoCompact:false warns instead of compacting', captured.includes('run /compact'), captured.slice(0, 400));
  check('autoCompact:false does not summarize', !captured.includes('compacted conversation'), captured.slice(0, 400));

  /* ---------------- 3d. cut-off recovery (truncation, step limit, retries) ---------------- */
  console.log('\n[cut-off recovery]');

  // config plumbing for the step limit
  const { config: cfgStepsDefault } = loadConfig(writeConfig('cfg-steps-default.json', baseConfig(1)));
  check('default maxSteps is 50', cfgStepsDefault.maxSteps === 50, JSON.stringify(cfgStepsDefault.maxSteps));
  check('maxSteps out of range falls back to the default', loadConfig(writeConfig('cfg-steps-bad.json', { ...baseConfig(1), maxSteps: 0 })).config.maxSteps === 50, 'not 50');
  check('maxSteps is clamped to 1000', loadConfig(writeConfig('cfg-steps-huge.json', { ...baseConfig(1), maxSteps: 99999 })).config.maxSteps === 1000, 'not 1000');
  check('maxSteps appears in the /config view', maskConfig(cfgStepsDefault).maxSteps === 50, 'missing');
  process.env.HARNESS_MAX_STEPS = '7';
  const { config: cfgStepsEnv } = loadConfig(writeConfig('cfg-steps-env.json', baseConfig(1)));
  delete process.env.HARNESS_MAX_STEPS;
  check('HARNESS_MAX_STEPS overrides the config', cfgStepsEnv.maxSteps === 7, JSON.stringify(cfgStepsEnv.maxSteps));

  // a text reply cut off by the token limit is continued automatically
  res = await run(
    process.execPath,
    [harness, '--config', writeConfig('cfg-trunc-text.json', { ...baseConfig(port), workspace: workB }), '--no-stream', '--once', 'please TRUNCATE-CUT the file'],
    { cwd: workB }
  );
  check('truncated text reply is continued automatically', res.code === 0 && res.out.includes('MOCK-DONE continued-ok'), res.out);
  check('the cut-off is reported to the user', res.out.includes('token limit'), res.out);

  // a tool call cut off mid-JSON is not executed; the model re-issues it and finishes
  const workG = path.join(tmp, 'workG');
  fs.mkdirSync(workG, { recursive: true });
  res = await run(
    process.execPath,
    [harness, '--config', writeConfig('cfg-trunc-tool.json', { ...baseConfig(port), workspace: workG }), '--no-stream', '--once', 'please TRUNCATE-TOOL the file'],
    { cwd: workG }
  );
  check('truncated tool call is not executed', res.out.includes('not executed'), res.out);
  check('truncated arguments are not reported as bad JSON', !res.out.includes('not valid JSON'), res.out);
  check('model re-issues the complete tool call', res.out.includes('write_file'), res.out);
  check('task finishes after cut-off recovery', res.code === 0 && res.out.includes('MOCK-DONE tool-recovered'), res.out);
  check('the recovered file was actually written', fs.readFileSync(path.join(workG, 'cut-file.txt'), 'utf8') === 'recovered-ok', 'wrong content');

  // streaming captures finish_reason too
  res = await run(
    process.execPath,
    [harness, '--config', writeConfig('cfg-trunc-stream.json', { ...baseConfig(port), streaming: true, workspace: workB }), '--once', 'please TRUNCATE-CUT again'],
    { cwd: workB }
  );
  check('streaming: truncated reply is continued', res.code === 0 && res.out.includes('MOCK-DONE continued-ok'), res.out);

  // step limit: wrap-up nudge before the limit, clear message at the limit
  const workH = path.join(tmp, 'workH');
  fs.mkdirSync(workH, { recursive: true });
  const loopCfg = { ...baseConfig(port), maxSteps: 4, workspace: workH, streaming: false };
  const agentH = createAgent({ config: loopCfg, builtins: createTools(loopCfg), mcp: null });
  captured = '';
  process.stdout.write = (chunk, ...rest) => {
    captured += String(chunk);
    return true;
  };
  try {
    await agentH.turn('LOOP-FOREVER please');
  } finally {
    process.stdout.write = origWrite;
  }
  check('wrap-up nudge is injected before the step limit', agentH.history.some((m) => /steps left in this turn/.test(String(m.content ?? ''))), JSON.stringify(agentH.history.map((m) => m.role)));
  check('turn stops at maxSteps with a clear message', captured.includes('step limit (4)'), captured.slice(0, 600));
  check('step-limit message points at the config key', captured.includes('maxSteps'), captured.slice(0, 600));
  check('wrap-up nudge tells the model to finish', captured.includes('telling the model to wrap up'), captured.slice(0, 600));

  // transient API errors are retried, the task still finishes
  res = await run(
    process.execPath,
    [harness, '--config', writeConfig('cfg-retry.json', { ...baseConfig(port), workspace: workB }), '--no-stream', '--once', 'RETRY-ME please'],
    { cwd: workB }
  );
  check('transient API errors are retried', res.code === 0 && res.out.includes('MOCK-DONE retried-ok'), res.out);

  /* ---------------- 4. CLI plumbing ---------------- */
  console.log('\n[cli]');
  const workD = path.join(tmp, 'workD');
  fs.mkdirSync(workD, { recursive: true });
  res = await run(process.execPath, [harness, '--config', cfg1, '--dir', workD, '--once', 'please write the file'], { cwd: workB });
  check('--dir starts in another directory', res.code === 0 && fs.existsSync(path.join(workD, 'hello-harness.txt')), res.out);
  res = await run(process.execPath, [harness, '--config', cfg1, '--dir', path.join(tmp, 'nope-dir'), '--once', 'hi'], { cwd: workB });
  check('--dir fails cleanly on a missing directory', res.code !== 0 && res.out.includes('no such directory'), res.out);
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
