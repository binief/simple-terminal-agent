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
  const { TOOL_LIMITS: LIMITS_FOR_READ } = await import(pathToFileURL(path.join(proj, 'lib', 'tools.js')).href);
  check(
    `read_file clamps limit to ${LIMITS_FOR_READ.maxReadLines} lines per call`,
    r.includes(`lines 1-${LIMITS_FOR_READ.maxReadLines} of 1200`) && r.includes(`clamped to ${LIMITS_FOR_READ.maxReadLines}`),
    r.slice(0, 200)
  );
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

  /* ---------------- 0c. system prompt: working contract + custom instructions ---------------- */
  console.log('\n[system prompt]');
  const { createAgent, resolveInstructions } = await import(pathToFileURL(path.join(proj, 'lib', 'agent.js')).href);
  const { buildSystemPrompt, gitInfo, clearGitCache, matchPromptStyle, normalizePromptStyle, PROMPT_STYLES } = await import(pathToFileURL(path.join(proj, 'lib', 'prompt.js')).href);
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
  check('system prompt states the date and mode', /# Environment/.test(sys) && /- Today: \d{4}-\d{2}-\d{2}/.test(sys) && /- Mode: build/.test(sys), sys.slice(0, 600));
  check('system prompt carries every default section', ['# Autonomy', '# Communication', '# Tools', '# Working method', '# Code quality', '# Definition of done', '# Safety', '# Harness mechanics'].every((h) => sys.includes(h)), sys);
  check('autonomy: resolve the task instead of yielding early', /Keep working until the request is resolved/.test(sys) && /ask ONE concise question/.test(sys), sys);
  check('autonomy: a how-to question is answered, not executed', /do not start changing files/.test(sys), sys);
  check('communication: terse terminal output with file:line refs', /path\/to\/file\.js:42/.test(sys) && /No emoji unless asked/.test(sys), sys);
  check('working method: understand context before changing', /Understand before changing/.test(sys) && /acceptance criteria/.test(sys), sys);
  check('working method: outline a minimal plan before mutation', /Outline a minimal plan/.test(sys) && /before the first mutation/.test(sys), sys);
  check('working method: checks relevant failure and edge cases', /malformed input/.test(sys) && /failure and edge cases/.test(sys), sys);
  check('working method: material ambiguity pauses execution', /material ambiguity/.test(sys) && /ask one concise question before editing/.test(sys), sys);
  check('working method: forbids raw-prompt edits', /Do not start a coding task with write_file/.test(sys), sys);
  check('working method: inspects the resulting diff', /inspect the resulting diff/.test(sys), sys);
  check('working method: follow the conventions of the code', /Match the code you are editing/.test(sys), sys);
  check('tools: batch independent tool calls', /tool calls in one reply run in order/.test(sys), sys);
  check('tools: locate then window instead of whole files', /Locate, then window/.test(sys) && /never scroll a large file into context/.test(sys), sys);
  check('tools: old_text copied verbatim from read_file', /Copy old_text verbatim from read_file/.test(sys), sys);
  check('tools: never rewrite an unread file', /a deliberate full rewrite of a file you have read/.test(sys), sys);
  check('tools: no acting on truncated output', /never edit around a marker/.test(sys), sys);
  check('tools: no loops — the tool result is the confirmation', /never re-run a command that already succeeded/.test(sys), sys);
  check('run_command: non-interactive, non-paginated, OS-aware', /Non-interactive only/.test(sys) && /--no-pager/.test(sys) && /no bash-isms under Windows cmd\.exe/.test(sys), sys);
  check('run_command: shell is not used to read or edit files', /Do not read files through the shell/.test(sys) && /Do not edit files through the shell/.test(sys), sys);
  check('done: verification is required before claiming success', /Never claim success you did not verify/.test(sys), sys);
  check('done: report the blocker after two failed attempts', /report the blocker/.test(sys), sys);
  check('safety: destructive commands are announced', /destructive or irreversible/.test(sys), sys);
  check('safety: no commits or pushes unless asked', /Never run git commit, git push/.test(sys), sys);
  check('safety: secrets are never printed', /Never print, log or commit secrets/.test(sys), sys);
  check('harness mechanics: steps, compaction and cut-off replies', /steps are running out/.test(sys) && /compacted into a summary/.test(sys) && /re-issue it complete/.test(sys), sys);
  check('no user-instructions section by default', !sys.includes('# User instructions'), sys);

  // git state: a real repository reports its branch, a plain directory reports nothing
  clearGitCache();
  const gitNone = gitInfo(promptDir);
  check('gitInfo returns null outside a repository', gitNone === null, String(gitNone));
  check('no Git line when the workspace is not a repository', !/^- Git:/m.test(sys), sys.slice(0, 600));
  const gitSelf = gitInfo(proj);
  check('gitInfo reports branch and cleanliness in a repository', typeof gitSelf === 'string' && /\((clean|\d+ uncommitted files?)\)$/.test(gitSelf), String(gitSelf));
  check('the Git line lands in the environment block', buildSystemPrompt({ cwd: proj, platform: 'x', git: gitSelf }).includes(`- Git: ${gitSelf}`), String(gitSelf));

  // buildSystemPrompt is pure: same inputs, same prompt, blocks in order
  const built = buildSystemPrompt({ cwd: '/w', platform: 'p', date: '2025-01-02', planning: true, blocks: ['BLOCK-ONE'], instructions: 'RULE-LAST' });
  check('buildSystemPrompt is deterministic', built === buildSystemPrompt({ cwd: '/w', platform: 'p', date: '2025-01-02', planning: true, blocks: ['BLOCK-ONE'], instructions: 'RULE-LAST' }), 'differs');
  check('buildSystemPrompt marks plan mode in the environment block', /- Mode: plan \(read-only research/.test(built), built.slice(0, 400));
  check('autonomy tells build mode not to hand back a plan', sys.includes('a plan instead of the work'), sys);
  const planned = buildSystemPrompt({ cwd: '/w', platform: 'p', planning: true });
  check('autonomy flips in plan mode: the plan is the deliverable', planned.includes('the plan is the deliverable') && !planned.includes('a plan instead of the work'), planned.slice(0, 1200));
  check('buildSystemPrompt appends blocks before the user instructions', built.indexOf('BLOCK-ONE') < built.indexOf('RULE-LAST') && built.indexOf('# Harness mechanics') < built.indexOf('BLOCK-ONE'), built);

  /* ---------------- 0c-bis. the prompt quotes the real tool limits ---------------- */
  const { TOOL_LIMITS } = await import(pathToFileURL(path.join(proj, 'lib', 'tools.js')).href);
  check('the prompt quotes the real read_file caps', sys.includes(`at most ${TOOL_LIMITS.maxReadLines} lines per call (default ${TOOL_LIMITS.defaultReadLines})`), sys);
  check('the prompt quotes the real tool-result cap', sys.includes(`~${Math.round(TOOL_LIMITS.toolResultCap / 1000)}k chars`), sys);
  check('the read_file description quotes the real caps', createTools(promptCfg).listTools().find((t) => t.name === 'read_file').description.includes(`at most ${TOOL_LIMITS.maxReadLines} lines and ${Math.round(TOOL_LIMITS.maxReadChars / 1000)}k chars`), 'description drifted');

  // drift guard: change the constant in a copy of lib/ — the prompt must follow it
  const driftDir = path.join(tmp, 'drift-lib');
  fs.mkdirSync(driftDir, { recursive: true });
  for (const f of fs.readdirSync(path.join(proj, 'lib'))) fs.copyFileSync(path.join(proj, 'lib', f), path.join(driftDir, f));
  const driftTools = path.join(driftDir, 'tools.js');
  fs.writeFileSync(
    driftTools,
    fs
      .readFileSync(driftTools, 'utf8')
      .replace(`maxReadLines: ${TOOL_LIMITS.maxReadLines}`, 'maxReadLines: 777')
      .replace(`toolResultCap: ${String(TOOL_LIMITS.toolResultCap).replace(/^(\d+)(\d{3})$/, '$1_$2')}`, 'toolResultCap: 33_000')
  );
  const driftPrompt = await import(pathToFileURL(driftTools.replace('tools.js', 'prompt.js')).href);
  const drifted = driftPrompt.buildSystemPrompt({ cwd: '/w', platform: 'p' });
  const driftedCompact = driftPrompt.buildSystemPrompt({ cwd: '/w', platform: 'p', style: 'compact' });
  check('a changed read cap flows into the full prompt', drifted.includes('at most 777 lines per call') && !drifted.includes(`at most ${TOOL_LIMITS.maxReadLines} lines per call`), drifted.split('\n').find((l) => l.includes('Locate, then window')));
  check('a changed read cap flows into the compact prompt', driftedCompact.includes('max 777 lines/call'), driftedCompact.split('\n').find((l) => l.includes('search_files to locate')));
  check('a changed result cap flows into the prompt', drifted.includes('~33k chars'), drifted.split('\n').find((l) => l.includes('Truncation is real')));

  /* ---------------- 0d. prompt style: full vs compact ---------------- */
  console.log('\n[prompt style]');
  const full = buildSystemPrompt({ cwd: '/w', platform: 'p', style: 'full' });
  const compact = buildSystemPrompt({ cwd: '/w', platform: 'p', style: 'compact' });
  check('two styles are offered', Array.isArray(PROMPT_STYLES) && PROMPT_STYLES.join(',') === 'full,compact', JSON.stringify(PROMPT_STYLES));
  check('compact is much smaller than full', compact.length < full.length * 0.5, `full ${full.length} / compact ${compact.length}`);
  check('compact keeps the environment block', compact.includes('# Environment') && compact.includes('- Workspace (cwd): /w'), compact.slice(0, 300));
  check('compact keeps the behaviour-changing rules', ['# Autonomy', '# Communication', '# Tools', '# Working method', '# Code quality', '# Done, and safe'].every((h) => compact.includes(h)), compact);
  check('compact still forbids unverified success', /Never claim unverified success/.test(compact), compact);
  check('compact still forbids commits and secrets', /Never commit, push or switch branches unless asked/.test(compact) && /Never print secrets/.test(compact), compact);
  check('compact still pins read-before-edit and verbatim old_text', /Read a file before changing it/.test(compact) && /copy old_text verbatim/.test(compact), compact);
  check('compact drops the harness-mechanics section', !compact.includes('# Harness mechanics'), compact);
  check('compact respects plan mode in the autonomy block', buildSystemPrompt({ cwd: '/w', platform: 'p', style: 'compact', planning: true }).includes('the plan is the deliverable'), 'missing');
  check('compact still carries plan blocks and instructions', buildSystemPrompt({ cwd: '/w', platform: 'p', style: 'compact', blocks: ['BLOCK'], instructions: 'RULE' }).includes('BLOCK') === true && buildSystemPrompt({ cwd: '/w', platform: 'p', style: 'compact', instructions: 'RULE' }).includes('RULE'), 'missing');
  check('an unknown style falls back to full', buildSystemPrompt({ cwd: '/w', platform: 'p', style: 'nonsense' }) === full, 'not the full prompt');
  check('style aliases resolve', normalizePromptStyle('SHORT') === 'compact' && normalizePromptStyle('long') === 'full' && normalizePromptStyle(null) === 'full', 'bad aliases');
  check('matchPromptStyle rejects a non-style', matchPromptStyle('weird') === null && matchPromptStyle('compact') === 'compact', 'bad match');

  // config plumbing
  check('promptStyle defaults to full', loadConfig(writeConfig('cfg-style-default.json', baseConfig(1))).config.promptStyle === 'full', 'not full');
  check('promptStyle is read from the config', loadConfig(writeConfig('cfg-style-compact.json', { ...baseConfig(1), promptStyle: 'compact' })).config.promptStyle === 'compact', 'not compact');
  check('an invalid promptStyle falls back to full', loadConfig(writeConfig('cfg-style-bad.json', { ...baseConfig(1), promptStyle: 'tiny-ish' })).config.promptStyle === 'full', 'not full');
  process.env.HARNESS_PROMPT_STYLE = 'compact';
  const { config: cfgStyleEnv } = loadConfig(writeConfig('cfg-style-env.json', baseConfig(1)));
  delete process.env.HARNESS_PROMPT_STYLE;
  check('HARNESS_PROMPT_STYLE overrides the config', cfgStyleEnv.promptStyle === 'compact', JSON.stringify(cfgStyleEnv.promptStyle));
  check('promptStyle appears in the /config view', maskConfig(cfgStyleEnv).promptStyle === 'compact', 'missing');

  // the agent actually uses the configured style, and /set prompt switches mid-session
  const compactAgent = makeAgent({ promptStyle: 'compact' });
  check('the agent builds the configured style', sysOf(compactAgent).includes('# Done, and safe') && !sysOf(compactAgent).includes('# Harness mechanics'), sysOf(compactAgent).slice(0, 300));
  const styleCfg = { ...promptCfg, promptStyle: 'full' };
  const switchAgent = createAgent({ config: styleCfg, builtins: createTools(styleCfg), mcp: null });
  check('session starts on the full prompt', sysOf(switchAgent).includes('# Harness mechanics'), 'not full');
  styleCfg.promptStyle = 'compact';
  switchAgent.refreshSystem();
  check('refreshSystem picks up the new style mid-session', !sysOf(switchAgent).includes('# Harness mechanics') && sysOf(switchAgent).includes('# Done, and safe'), sysOf(switchAgent).slice(0, 300));

  sys = sysOf(makeAgent({ instructions: 'Use pnpm, not npm.\nAlways run node --test.' }));
  check('config instructions land in the system prompt', sys.includes('Use pnpm, not npm.') && sys.includes('# User instructions'), sys);
  check('instructions come after the built-in defaults', sys.indexOf('# Working method') < sys.indexOf('Use pnpm'), sys);

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

  /* ---------------- 0f. plan mode (read-only research, then approval) ---------------- */
  console.log('\n[plan mode]');
  const {
    isReadOnlyCommand,
    createPlanState,
    normalizePlan,
    formatPlan,
    scanCommand,
    PLAN_MODE,
    BUILD_MODE,
    APPROVED_TAG,
  } = await import(pathToFileURL(path.join(proj, 'lib', 'plan.js')).href);

  const isWin = process.platform === 'win32';
  const ro = (cmd, extra) => isReadOnlyCommand(cmd, extra).ok;
  const allRo = (cmds, extra) => cmds.filter((c) => !ro(c, extra));
  const noneRo = (cmds, extra) => cmds.filter((c) => ro(c, extra));

  let bad = allRo([
    'ls -la',
    'cat src/app.js',
    'head -n 40 README.md',
    'rg TODO src | head -20',
    'wc -l *.js',
    'git status',
    'git log --oneline -n 20',
    'git diff HEAD~1 -- lib/',
    'git -C ../other show HEAD',
    'git branch -v',
    'git config --get user.name',
    'npm ls --depth=0',
    'node --version',
    'echo hi && pwd',
  ]);
  check('read-only commands run in plan mode', bad.length === 0, `refused: ${bad.join(' | ')}`);

  let leaked = noneRo([
    'rm -rf build',
    'mkdir out',
    'touch new.txt',
    'cp a b',
    'mv a b',
    'chmod +x run.sh',
    'npm install left-pad',
    'npm run build',
    'yarn add lodash',
    'git commit -m "wip"',
    'git push origin main',
    'git checkout -b feature',
    'git config user.name Bob',
    'node build.js',
    'python setup.py install',
    'sed -i s/a/b/ file.txt',
    'curl -o out.zip https://example.com',
  ]);
  check('mutating commands are refused in plan mode', leaked.length === 0, `allowed: ${leaked.join(' | ')}`);

  check('one mutating step refuses the whole chain', !ro('ls && rm -rf build') && !ro('cat a.txt; git push'), 'a chain slipped through');
  check('output redirection is refused', !ro('echo hi > out.txt') && !ro('cat a >> b.log'), 'redirection allowed');
  check('stderr redirection stays read-only', ro('ls -la 2>&1') && ro('git status 2>&1 | head'), 'rejected 2>&1');
  check('command substitution is refused', !ro('echo $(rm -rf tmp)') && !ro('echo `whoami`'), 'substitution allowed');
  check('find -delete / -exec are refused', !ro('find . -name "*.log" -delete') && !ro('find . -exec rm {} ;'), 'find can write');
  check('plain find still works', ro('find . -name "*.js"'), 'find rejected');
  check('separators inside quotes are not chains', ro('grep "a && rm -rf b" src'), 'quoted text split');
  check('env assignments do not hide a command', !ro('FOO=1 rm -rf x') && ro('FOO=1 ls'), 'assignment prefix mishandled');
  check('an absolute path resolves to the base command', ro('/bin/ls -la') && !ro('/bin/rm -rf x'), 'path not resolved');
  check('planAllowCommands adds a command', ro('make check', ['make']) && !ro('make check'), 'extra allow ignored');
  check('planAllowCommands can allow an exact prefix', ro('npm test --silent', ['npm test']) && !ro('npm start', ['npm test']), 'prefix allow ignored');
  check('the refusal says why', /not a known read-only command/.test(isReadOnlyCommand('rm -rf x').reason || ''), isReadOnlyCommand('rm -rf x').reason);
  check('scanCommand splits on shell separators', scanCommand('a && b | c; d').segments.length === 4, JSON.stringify(scanCommand('a && b | c; d').segments));

  // --- the plan object ---
  check('normalizePlan keeps the steps in order', normalizePlan({ title: 't', steps: ['one', 'two'] }).steps.join('|') === 'one|two', 'reordered');
  check('normalizePlan accepts steps as a numbered string', normalizePlan({ title: 't', steps: '1. one\n2. two' }).steps.length === 2, 'not split');
  check('normalizePlan needs a title', (() => { try { normalizePlan({ steps: ['a'] }); return false; } catch { return true; } })(), 'no error');
  check('normalizePlan needs steps', (() => { try { normalizePlan({ title: 't' }); return false; } catch { return true; } })(), 'no error');
  const shown = formatPlan({ title: 'T', steps: ['a', 'b'], files: ['x.js'], verification: 'npm test', notes: 'n' });
  check('formatPlan numbers the steps', shown.includes('1. a') && shown.includes('2. b'), shown);
  check('formatPlan carries files, verification and notes', shown.includes('x.js') && shown.includes('npm test') && shown.includes('n'), shown);

  const state = createPlanState();
  check('a session starts in build mode', state.mode === BUILD_MODE && !state.planning, state.mode);
  state.setMode(PLAN_MODE);
  check('setMode switches to plan mode', state.planning, state.mode);
  state.present({ title: 'Ship it', steps: ['edit a.js'] });
  check('a presented plan is picked up once', state.takePresented()?.title === 'Ship it' && state.takePresented() === null, 'not consumed');
  check('approve returns to build mode', state.approve()?.title === 'Ship it' && state.mode === BUILD_MODE, state.mode);
  check('the approved plan is remembered', state.approved?.title === 'Ship it' && state.proposed === null, 'lost');
  check('approving without a plan does nothing', createPlanState().approve() === null, 'approved nothing');
  state.clear();
  check('clear drops the plans', state.approved === null && state.proposed === null, 'kept');

  // --- tools honour the mode ---
  const planDir = path.join(tmp, 'planwork');
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, 'app.js'), 'console.log(1)\n');
  const planState = createPlanState({ mode: PLAN_MODE });
  const planTools = createTools({ workspace: planDir, commandTimeout: 15, shell: null }, planState);
  const planNames = planTools.listTools().map((t) => t.name);
  check('plan mode hides the mutating tools', !planNames.includes('write_file') && !planNames.includes('edit_file'), planNames.join(', '));
  check('plan mode keeps the read-only tools', ['read_file', 'list_dir', 'search_files', 'run_command'].every((n) => planNames.includes(n)), planNames.join(', '));
  check('plan mode offers present_plan', planNames.includes('present_plan'), planNames.join(', '));

  r = await planTools.execute('write_file', { path: 'nope.txt', content: 'x' });
  check('write_file is refused in plan mode', r.startsWith('Error:') && r.includes('read-only'), r);
  check('the refused write did not happen', !fs.existsSync(path.join(planDir, 'nope.txt')), 'the file was created');
  r = await planTools.execute('edit_file', { path: 'app.js', old_text: '1', new_text: '2' });
  check('edit_file is refused in plan mode', r.startsWith('Error:') && r.includes('plan mode'), r);
  check('the refused edit did not happen', fs.readFileSync(path.join(planDir, 'app.js'), 'utf8').includes('console.log(1)'), 'the file changed');
  check('the refusal points at present_plan', r.includes('present_plan') && r.includes('/approve'), r);
  r = await planTools.execute('read_file', { path: 'app.js' });
  check('read_file still works in plan mode', r.includes('console.log(1)'), r);
  r = await planTools.execute('search_files', { pattern: 'console' });
  check('search_files still works in plan mode', r.includes('app.js:1:'), r);
  r = await planTools.execute('run_command', { command: isWin ? 'dir' : 'ls -a' });
  check('read-only commands still run in plan mode', r.includes('exit code: 0'), r);
  r = await planTools.execute('run_command', { command: isWin ? 'echo x > made-by-plan.txt' : 'touch made-by-plan.txt' });
  check('a writing command is refused in plan mode', r.startsWith('Error:') && r.includes('plan mode is read-only'), r);
  check('the refused command did not run', !fs.existsSync(path.join(planDir, 'made-by-plan.txt')), 'the file was created');
  const allowTools = createTools({ workspace: planDir, commandTimeout: 15, shell: null, planAllowCommands: ['make'] }, planState);
  r = await allowTools.execute('run_command', { command: 'make --version' });
  check('planAllowCommands reaches run_command', !r.startsWith('Error: plan mode'), r);

  r = await planTools.execute('present_plan', { title: 'Do the thing', steps: ['step one', 'step two'] });
  check('present_plan records the plan', planState.proposed?.steps.length === 2, r);
  check('present_plan tells the model to stop and wait', /Stop here/.test(r) && r.includes('/approve'), r);
  r = await planTools.execute('present_plan', { steps: ['x'] });
  check('present_plan rejects a plan without a title', r.startsWith('Error:') && r.includes('title'), r);

  planState.setMode(BUILD_MODE);
  const buildNames = planTools.listTools().map((t) => t.name);
  check('build mode restores the mutating tools', buildNames.includes('write_file') && buildNames.includes('edit_file'), buildNames.join(', '));
  check('build mode hides present_plan', !buildNames.includes('present_plan'), buildNames.join(', '));
  r = await planTools.execute('write_file', { path: 'nope.txt', content: 'x' });
  check('build mode writes files again', r.includes('Wrote') && fs.existsSync(path.join(planDir, 'nope.txt')), r);
  r = await planTools.execute('present_plan', { title: 't', steps: ['a'] });
  check('present_plan is rejected outside plan mode', r.startsWith('Error:') && r.includes('/plan'), r);

  // --- the agent: system prompt, tool list, approval ---
  const planCfg = { ...promptCfg, planMode: true };
  const planBuiltins = createTools(planCfg);
  const planAgent = createAgent({ config: planCfg, builtins: planBuiltins, mcp: null });
  check('config planMode starts the session in plan mode', planAgent.planning && planAgent.mode === PLAN_MODE, planAgent.mode);
  sys = sysOf(planAgent);
  check('the system prompt states the mode', /Mode: plan/.test(sys), sys.slice(0, 500));
  check('plan mode rules are in the system prompt', sys.includes('PLAN MODE IS ON'), sys);
  check('plan mode rules forbid implementing', /do not implement/i.test(sys) && /present_plan/.test(sys), sys);
  check('plan mode advertises no mutating tools', planAgent.tools().every((t) => t.name !== 'write_file' && t.name !== 'edit_file'), planAgent.tools().map((t) => t.name).join(', '));
  check('plan mode advertises present_plan', planAgent.tools().some((t) => t.name === 'present_plan'), planAgent.tools().map((t) => t.name).join(', '));

  planBuiltins.plan.present({ title: 'Ship the flag', steps: ['edit harness.js', 'add a test'], verification: 'npm test' });
  const accepted = planAgent.approvePlan('keep it small');
  check('approving leaves plan mode', !planAgent.planning && planAgent.mode === BUILD_MODE, planAgent.mode);
  check('the approved plan is pinned in the system prompt', sysOf(planAgent).includes('Approved plan') && sysOf(planAgent).includes('Ship the flag'), sysOf(planAgent));
  check('build mode drops the plan-mode rules', !sysOf(planAgent).includes('PLAN MODE IS ON'), sysOf(planAgent));
  check('the approval message carries the plan', accepted.message.includes(APPROVED_TAG) && accepted.message.includes('1. edit harness.js'), accepted.message);
  check('the approval message carries the user note', accepted.message.includes('keep it small'), accepted.message);
  check('the mutating tools are back after approval', planAgent.tools().some((t) => t.name === 'write_file'), planAgent.tools().map((t) => t.name).join(', '));
  planAgent.setMode(PLAN_MODE);
  check('setMode(plan) puts the rules back', sysOf(planAgent).includes('PLAN MODE IS ON'), sysOf(planAgent));
  check('switching modes tells the running conversation', planAgent.history.some((m) => /Plan mode is ON/.test(String(m.content ?? ''))) || planAgent.history.length === 1, JSON.stringify(planAgent.history.map((m) => m.role)));
  planAgent.reset();
  check('/reset drops the approved plan', !planAgent.plan.approved && !sysOf(planAgent).includes('Approved plan'), sysOf(planAgent));
  check('/reset keeps the mode', planAgent.planning, planAgent.mode);
  check('approving nothing at all is refused', planAgent.approvePlan() === null, 'approved an empty session');

  // a model that described its approach in prose instead of calling present_plan
  const proseAgent = createAgent({ config: planCfg, builtins: createTools(planCfg), mcp: null });
  proseAgent.history.push({ role: 'user', content: 'add the flag' }, { role: 'assistant', content: 'I would edit harness.js and add a test.' });
  const prose = proseAgent.approvePlan('go');
  check('/approve also accepts an approach described in prose', prose !== null && prose.plan === null, JSON.stringify(prose));
  check('the prose approval leaves plan mode', !proseAgent.planning, proseAgent.mode);
  check('the prose approval message is explicit', prose.message.includes(APPROVED_TAG) && prose.message.includes('go'), prose.message);

  // --- config plumbing ---
  check('planMode defaults to false', loadConfig(writeConfig('cfg-plan-default.json', baseConfig(1))).config.planMode === false, 'not false');
  check('planMode can be set in the config', loadConfig(writeConfig('cfg-plan-on.json', { ...baseConfig(1), planMode: true })).config.planMode === true, 'not true');
  process.env.HARNESS_PLAN_MODE = '1';
  const { config: cfgPlanEnv } = loadConfig(writeConfig('cfg-plan-env.json', baseConfig(1)));
  delete process.env.HARNESS_PLAN_MODE;
  check('HARNESS_PLAN_MODE overrides the config', cfgPlanEnv.planMode === true, 'not overridden');
  const { config: cfgPlanAllow } = loadConfig(
    writeConfig('cfg-plan-allow.json', { ...baseConfig(1), planAllowCommands: ['  make  ', '', 'npm test'], planAllowTools: ['mcp_fake_add'] })
  );
  check('planAllowCommands is cleaned up', cfgPlanAllow.planAllowCommands.join('|') === 'make|npm test', JSON.stringify(cfgPlanAllow.planAllowCommands));
  check('the plan keys show up in /config', maskConfig(cfgPlanAllow).planMode === false && maskConfig(cfgPlanAllow).planAllowTools.includes('mcp_fake_add'), JSON.stringify(maskConfig(cfgPlanAllow).planAllowTools));

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
  check('/set usage mentions the prompt key', res.out.includes('/set prompt <full|compact>'), res.out);

  res = await runWithInput([harness, '--config', cfg1, '--no-stream'], '/set prompt\n/set prompt compact\n/config\n', { cwd: workB });
  check('/set prompt with no argument reports the current style', res.out.includes('system prompt style: full'), res.out);
  check('/set prompt switches the style mid-session', res.out.includes('system prompt style: compact'), res.out);
  check('/config reflects the switched style', /"promptStyle":\s*"compact"/.test(res.out), res.out);

  res = await runWithInput([harness, '--config', cfg1, '--no-stream'], '/set prompt tiny\n', { cwd: workB });
  check('/set prompt rejects an unknown style', res.out.includes('unknown prompt style') && res.out.includes('full or compact'), res.out);

  res = await runWithInput([harness, '--config', cfg1, '--no-stream', '--prompt', 'compact'], '/config\n', { cwd: workB });
  check('--prompt compact is applied to the session', /"promptStyle":\s*"compact"/.test(res.out), res.out);
  check('the banner flags a non-default prompt style', res.out.includes('prompt: compact'), res.out);
  res = await run(process.execPath, [harness, '--config', cfg1, '--prompt', 'weird', '--once', 'hi'], { cwd: workB });
  check('--prompt rejects an unknown style', res.code !== 0 && res.out.includes('unknown style'), res.out);
  res = await runWithInput([harness, '--config', cfg1, '--no-stream'], '/help\n', { cwd: workB });
  check('/help documents /set prompt', res.out.includes('/set prompt'), res.out);

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

  /* ---------------- 3b2. plan mode, end to end ---------------- */
  console.log('\n[plan mode, end to end]');
  const workPlan = path.join(tmp, 'workPlan');
  fs.mkdirSync(workPlan, { recursive: true });
  const cfgPlanSession = writeConfig('cfg-plan-session.json', { ...baseConfig(port), workspace: workPlan });

  res = await runWithInput([harness, '--config', cfgPlanSession, '--no-stream'], '/plan PLAN-ME add the probe file\n', { cwd: workPlan });
  check('/plan switches the session to plan mode', res.code === 0 && res.out.includes('plan mode on'), res.out);
  check('plan mode refuses write_file during the turn', res.out.includes('plan mode is read-only'), res.out);
  check('plan mode refuses a mutating command', res.out.includes('was not run'), res.out);
  check('plan mode still runs read-only commands', res.out.includes('exit code: 0'), res.out);
  check('the plan is rendered as its own block', res.out.includes('Plan') && res.out.includes('Add the probe file'), res.out);
  check('the plan steps are numbered', /1\.\s+create plan-probe\.txt/.test(res.out), res.out);
  check('the plan shows files and verification', res.out.includes('plan-probe.txt') && res.out.includes('cat plan-probe.txt'), res.out);
  check('the plan notes are shown', res.out.includes('PLAN-NOTES'), res.out);
  check('the turn stops at the plan', !res.out.includes('MOCK-DONE plan-stalled'), res.out);
  check('the user is told how to approve', res.out.includes('/approve'), res.out);
  check('planning changed nothing on disk', !fs.existsSync(path.join(workPlan, 'plan-probe.txt')), 'the workspace was modified in plan mode');

  res = await runWithInput([harness, '--config', cfgPlanSession, '--no-stream'], '/plan PLAN-ME add the probe file\n/approve\n', { cwd: workPlan });
  check('/approve reports the plan it accepted', res.out.includes('plan approved: Add the probe file'), res.out);
  check('/approve runs the implementation', res.out.includes('MOCK-DONE plan-approved'), res.out);
  check('the approved plan is actually implemented', fs.existsSync(path.join(workPlan, 'plan-probe.txt')) && fs.readFileSync(path.join(workPlan, 'plan-probe.txt'), 'utf8') === 'plan-ok', 'wrong content');

  res = await runWithInput([harness, '--config', cfgPlanSession, '--no-stream'], '/approve\n', { cwd: workPlan });
  check('/approve without a plan explains itself', res.out.includes('no plan to approve'), res.out);

  res = await runWithInput([harness, '--config', cfgPlanSession, '--no-stream'], '/plan\n/plan off\n', { cwd: workPlan });
  check('/plan with no task just turns the mode on', res.out.includes('plan mode on'), res.out);
  check('/plan off leaves plan mode', res.out.includes('plan mode off'), res.out);

  res = await runWithInput([harness, '--config', cfgPlanSession, '--no-stream'], '/plan\n/tools\n/config\n', { cwd: workPlan });
  check('/tools hides the mutating tools in plan mode', (res.out.match(/write_file/g) || []).length === 1, res.out);
  check('/tools lists present_plan in plan mode', res.out.includes('present_plan'), res.out);
  check('/config reports the current mode', res.out.includes('mode: plan'), res.out);
  check('/help documents the plan commands', res.out.includes('/plan') && res.out.includes('/approve'), res.out);

  const workPlanOnce = path.join(tmp, 'workPlanOnce');
  fs.mkdirSync(workPlanOnce, { recursive: true });
  res = await run(
    process.execPath,
    [harness, '--config', cfgPlanSession, '--plan', '--dir', workPlanOnce, '--no-stream', '--once', 'PLAN-ME add the probe file'],
    { cwd: workPlanOnce }
  );
  check('--plan starts the session in plan mode', res.code === 0 && res.out.includes('read-only: research'), res.out);
  check('--plan produces a plan', res.out.includes('Add the probe file'), res.out);
  check('--plan leaves the workspace untouched', !fs.existsSync(path.join(workPlanOnce, 'plan-probe.txt')), 'the workspace was modified');

  /* ---------------- 3c. automatic compaction ---------------- */
  console.log('\n[auto-compaction]');
  // createAgent was imported with the system-prompt section above
  const workE = path.join(tmp, 'workE');
  fs.mkdirSync(workE, { recursive: true });
  const smallConfig = { ...baseConfig(port), contextSize: 8000, maxTokens: 256, workspace: workE, streaming: false, autoCompact: true };
  const agentE = createAgent({ config: smallConfig, builtins: createTools(smallConfig), mcp: null });
  agentE.history.push({ role: 'user', content: 'filler filler '.repeat(3000) }); // pushes past the budget

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
  agentF.history.push({ role: 'user', content: 'filler filler '.repeat(3000) });
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

  // a context too small for the system prompt itself must warn once, not compact on every step
  const workCramped = path.join(tmp, 'workCramped');
  fs.mkdirSync(workCramped, { recursive: true });
  const crampedConfig = { ...baseConfig(port), contextSize: 2000, maxTokens: 256, workspace: workCramped, streaming: false, autoCompact: true };
  const agentG = createAgent({ config: crampedConfig, builtins: createTools(crampedConfig), mcp: null });
  captured = '';
  process.stdout.write = (chunk, ...rest) => {
    captured += String(chunk);
    return true;
  };
  try {
    await agentG.turn('continue please');
  } finally {
    process.stdout.write = origWrite;
  }
  check('a context smaller than the system prompt warns instead of looping', captured.includes('nothing left to compact'), captured.slice(0, 500));
  check('the warning points at contextSize', /Raise "contextSize"/.test(captured), captured.slice(0, 500));
  check('the turn still completes on a cramped context', captured.includes('MOCK-DONE'), captured.slice(0, 500));
  check('no compaction is attempted when it cannot help', agentG.stats().compactions === 0, JSON.stringify(agentG.stats()));

  // a compaction that would not free anything must keep the raw history and say so
  const workNoGain = path.join(tmp, 'workNoGain');
  fs.mkdirSync(workNoGain, { recursive: true });
  const noGainConfig = { ...baseConfig(port), contextSize: 2000, maxTokens: 256, workspace: workNoGain, streaming: false };
  const agentNoGain = createAgent({ config: noGainConfig, builtins: createTools(noGainConfig), mcp: null });
  agentNoGain.history.push({ role: 'user', content: 'a short question' }, { role: 'assistant', content: 'a short answer' });
  const historyBefore = JSON.stringify(agentNoGain.history);
  captured = '';
  process.stdout.write = (chunk, ...rest) => {
    captured += String(chunk);
    return true;
  };
  let noGainResult;
  try {
    noGainResult = await agentNoGain.compact({ manual: true });
  } finally {
    process.stdout.write = origWrite;
  }
  check('a pointless compaction is refused', noGainResult === null, JSON.stringify(noGainResult));
  check('the refusal is reported honestly', captured.includes('would not free anything') && !captured.includes('compacted conversation'), captured.slice(0, 300));
  check('the raw history survives a refused compaction', JSON.stringify(agentNoGain.history) === historyBefore, 'history was replaced');
  check('a refused compaction is not counted', agentNoGain.stats().compactions === 0, JSON.stringify(agentNoGain.stats().compactions));

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
