/* Built-in coding tools: file operations + OS-aware command execution.
   Text handling is line-ending aware: files are read/normalized to LF for
   matching and display, and written back with the file's own (or the OS's)
   newline style, so edits work the same on Windows (CRLF) and Unix (LF). */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { createIgnoreMatcher } from './ignore.js';

const MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_CMD_CHARS = 100_000;
const MAX_SEARCH_RESULTS = 100;

/* --------------------------- line endings --------------------------- */

/** Newline the current OS writes by default. */
export const NATIVE_EOL = process.platform === 'win32' ? '\r\n' : '\n';

const EOL_NAMES = { '\n': 'LF', '\r\n': 'CRLF', '\r': 'CR' };

/** Detect the dominant line ending of `text`; null when it has no line breaks. */
export function detectEol(text) {
  const s = String(text ?? '');
  const crlf = (s.match(/\r\n/g) || []).length;
  const lf = (s.match(/(?<!\r)\n/g) || []).length;
  const cr = (s.match(/\r(?!\n)/g) || []).length;
  if (crlf + lf + cr === 0) return null;
  if (crlf >= lf && crlf >= cr) return '\r\n';
  if (cr >= lf) return '\r';
  return '\n';
}

/** Canonical form used for matching and display: every newline flavour -> \n. */
export function normalizeEol(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

/** Write `text` out using `eol` (normalizing first so styles never mix). */
export function applyEol(text, eol) {
  const t = normalizeEol(text);
  return !eol || eol === '\n' ? t : t.replace(/\n/g, eol);
}

export function eolName(eol) {
  return EOL_NAMES[eol] || EOL_NAMES[NATIVE_EOL];
}

/**
 * Which newline a file should be written with.
 * config.lineEndings: 'auto' (default) | 'lf' | 'crlf' | 'cr' | 'native'
 * 'auto' keeps the file's existing style, falling back to the OS default.
 */
export function resolveEol(config, existingEol) {
  const pref = String(config?.lineEndings ?? 'auto').trim().toLowerCase();
  if (pref === 'lf' || pref === 'unix') return '\n';
  if (pref === 'crlf' || pref === 'windows' || pref === 'win') return '\r\n';
  if (pref === 'cr' || pref === 'mac') return '\r';
  if (pref === 'native' || pref === 'os') return NATIVE_EOL;
  return existingEol || NATIVE_EOL;
}

/* --------------------------- OS-aware shell --------------------------- */

export function resolveShell(shellCfg) {
  const isWin = process.platform === 'win32';
  if (typeof shellCfg === 'string' && shellCfg) {
    const lower = shellCfg.toLowerCase();
    const args = isWin
      ? lower.includes('powershell') || lower.includes('pwsh')
        ? ['-NoProfile', '-NonInteractive', '-Command']
        : ['/d', '/s', '/c']
      : ['-c'];
    return { command: shellCfg, args, platform: process.platform };
  }
  if (shellCfg && typeof shellCfg === 'object' && shellCfg.command) {
    return { command: shellCfg.command, args: shellCfg.args || [], platform: process.platform };
  }
  if (isWin) {
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'], platform: process.platform };
  }
  for (const cand of ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/bin/sh']) {
    if (fs.existsSync(cand)) return { command: cand, args: ['-c'], platform: process.platform };
  }
  return { command: '/bin/sh', args: ['-c'], platform: process.platform };
}

export function shellInfo(config) {
  const sh = resolveShell(config?.shell);
  return `${sh.platform} (shell: ${sh.command} ${sh.args.join(' ')})`;
}

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try { child.kill('kill'); } catch { /* already gone */ }
  }
}

function runCommand(config, baseCwd, { command, cwd, timeout }) {
  return new Promise((resolve) => {
    const shell = resolveShell(config.shell);
    const workDir = cwd ? path.resolve(baseCwd, cwd) : baseCwd;
    const timeoutMs = (Number(timeout) || config.commandTimeout) * 1000;
    let child;
    try {
      child = spawn(shell.command, [...shell.args, String(command)], {
        cwd: workDir,
        env: process.env,
        windowsHide: true,
        detached: process.platform !== 'win32', // own process group so we can kill trees
      });
    } catch (e) {
      resolve(`Error: failed to spawn ${shell.command}: ${e.message}`);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (stdout.length < MAX_CMD_CHARS) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_CMD_CHARS) stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(`Error: ${e.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parts = [];
      parts.push(`shell: ${shell.command} ${shell.args.join(' ')}`);
      parts.push(`exit code: ${timedOut ? 'killed (timeout after ' + timeoutMs / 1000 + 's)' : code}`);
      parts.push('--- stdout ---');
      parts.push(stdout.replace(/\s+$/, '') || '(empty)');
      parts.push('--- stderr ---');
      parts.push(stderr.replace(/\s+$/, '') || '(empty)');
      resolve(parts.join('\n'));
    });
  });
}

/* ---------------------------- tool factory ---------------------------- */

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p) {
  const s = String(p ?? '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** Read a text file as UTF-8; returns null for missing files/binaries. */
function tryReadText(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_READ_BYTES) return null;
    const raw = fs.readFileSync(abs, 'utf8');
    if (raw.includes('\u0000')) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Count non-overlapping occurrences of `needle` in `text`. */
function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    const at = text.indexOf(needle, idx);
    if (at < 0) break;
    count++;
    idx = at + needle.length;
  }
  return count;
}

/** Line-wise search ignoring trailing whitespace; returns start line indexes. */
function looseFind(lines, needleLines) {
  const trimEnd = (l) => l.replace(/[ \t]+$/, '');
  const target = needleLines.map(trimEnd);
  const hits = [];
  for (let i = 0; i + target.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (trimEnd(lines[i + j]) !== target[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

export function createTools(config) {
  let baseCwd = path.resolve(expandHome(config.workspace) || process.cwd());

  const resolvePath = (p) => path.resolve(baseCwd, expandHome(p) || '.');
  const rel = (abs) => {
    const r = path.relative(baseCwd, abs);
    return r && !r.startsWith('..') ? r : abs;
  };

  const defs = [
    {
      name: 'read_file',
      description:
        'Read a text file from the workspace. Returns its content (optionally a line window). ' +
        'Use this before edit_file so the old_text matches exactly.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, absolute or relative to the workspace.' },
          offset: { type: 'integer', description: 'First line to read, 1-based. Default 1.' },
          limit: { type: 'integer', description: 'Max number of lines to return. Default 2000.' },
        },
        required: ['path'],
      },
      run({ path: p, offset = 1, limit = 2000 }) {
        const abs = resolvePath(p);
        const st = fs.statSync(abs);
        if (st.isDirectory()) throw new Error(`${rel(abs)} is a directory — use list_dir`);
        if (st.size > MAX_READ_BYTES) throw new Error(`${rel(abs)} is larger than 2 MB — read a narrower window or use run_command`);
        const raw = fs.readFileSync(abs, 'utf8');
        if (raw.includes('\u0000')) throw new Error(`${rel(abs)} looks like a binary file`);
        const eol = detectEol(raw);
        const all = normalizeEol(raw).split('\n');
        const start = Math.max(1, Number(offset) || 1) - 1;
        const end = Math.min(all.length, start + Math.max(1, Number(limit) || 2000));
        const window = all.slice(start, end);
        const eolNote =
          eol && eol !== '\n'
            ? ` · ${eolName(eol)} line endings (shown as LF; edits are written back as ${eolName(eol)})`
            : '';
        return `# ${rel(abs)} — lines ${start + 1}-${end} of ${all.length}${eolNote}\n${window.join('\n')}`;
      },
    },
    {
      name: 'write_file',
      description:
        'Create or overwrite a file with the given content. Parent directories are created as needed. ' +
        'Line endings are normalized and written to match the file (or the OS) style.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, absolute or relative to the workspace.' },
          content: { type: 'string', description: 'Full file content to write.' },
        },
        required: ['path', 'content'],
      },
      run({ path: p, content }) {
        const abs = resolvePath(p);
        const existed = fs.existsSync(abs);
        const existingEol = existed ? detectEol(tryReadText(abs)) : null;
        const eol = resolveEol(config, existingEol);
        const text = applyEol(String(content ?? ''), eol);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text, 'utf8');
        return `${existed ? 'Overwrote' : 'Wrote'} ${rel(abs)} (${Buffer.byteLength(text)} bytes, ${eolName(eol)})`;
      },
    },
    {
      name: 'edit_file',
      description:
        'Replace exact text in a file (copy old_text from read_file). Line endings are handled for you: ' +
        'CRLF/CR files match LF old_text and are written back with their own style. ' +
        'Fails if the text is not found or is ambiguous unless replace_all is true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, absolute or relative to the workspace.' },
          old_text: { type: 'string', description: 'Exact text to replace.' },
          new_text: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
      run({ path: p, old_text, new_text, replace_all }) {
        const abs = resolvePath(p);
        const raw = fs.readFileSync(abs, 'utf8');
        if (raw.includes('\u0000')) throw new Error(`${rel(abs)} looks like a binary file — edit_file only handles text`);
        const fileEol = detectEol(raw);
        const text = normalizeEol(raw); // canonical LF view: matching is line-ending agnostic
        const needle = normalizeEol(String(old_text ?? ''));
        if (!needle) throw new Error('old_text must not be empty');
        const replacement = normalizeEol(String(new_text ?? ''));

        let updated;
        let count;
        let note = '';
        const exact = countOccurrences(text, needle);

        if (exact > 0) {
          count = exact;
          if (count > 1 && !replace_all) {
            throw new Error(`old_text occurs ${count} times in ${rel(abs)} — provide more context or set replace_all`);
          }
          updated = replace_all
            ? text.split(needle).join(replacement)
            : text.replace(needle, () => replacement); // function form: $ sequences stay literal
          if (fileEol && fileEol !== '\n') note = ` (${eolName(fileEol)} file, matched as LF)`;
        } else {
          // Fallback: compare line by line, ignoring trailing whitespace (invisible \r, stray spaces).
          const lines = text.split('\n');
          const needleLines = needle.split('\n');
          const hits = looseFind(lines, needleLines);
          if (!hits.length) {
            throw new Error(
              `old_text not found in ${rel(abs)} — copy it verbatim from read_file (line endings are normalized ` +
                'automatically, so check spacing, indentation and wording)'
            );
          }
          count = hits.length;
          if (count > 1 && !replace_all) {
            throw new Error(`old_text occurs ${count} times in ${rel(abs)} — provide more context or set replace_all`);
          }
          const targets = replace_all ? hits : [hits[0]];
          const newLines = replacement.split('\n');
          const outLines = [];
          for (let i = 0; i < lines.length; ) {
            if (targets.includes(i)) {
              outLines.push(...newLines);
              i += needleLines.length;
            } else {
              outLines.push(lines[i]);
              i++;
            }
          }
          updated = outLines.join('\n');
          note = ' (matched ignoring trailing whitespace — check the result)';
        }

        const eol = resolveEol(config, fileEol);
        fs.writeFileSync(abs, applyEol(updated, eol), 'utf8');
        return `Replaced ${replace_all ? count : 1} occurrence(s) in ${rel(abs)}${note} — written with ${eolName(eol)} line endings`;
      },
    },
    {
      name: 'list_dir',
      description: 'List directory contents (directories first).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path, absolute or relative to the workspace. Default "."' },
        },
      },
      run({ path: p = '.' }) {
        const abs = resolvePath(p);
        const entries = fs.readdirSync(abs, { withFileTypes: true });
        const dirs = [];
        const files = [];
        for (const e of entries) {
          if (e.isDirectory()) {
            dirs.push(`${e.name}/`);
          } else {
            let size = '';
            try {
              size = `  (${fs.statSync(path.join(abs, e.name)).size} bytes)`;
            } catch {
              /* stat may fail on broken symlinks */
            }
            files.push(`${e.name}${size}`);
          }
        }
        dirs.sort();
        files.sort();
        const lines = [...dirs, ...files].slice(0, 500);
        const more = dirs.length + files.length > 500 ? `\n… ${dirs.length + files.length - 500} more entries` : '';
        return `# ${rel(abs)} — ${dirs.length} dir(s), ${files.length} file(s)\n${lines.join('\n')}${more}`;
      },
    },
    {
      name: 'search_files',
      description:
        'Search file contents recursively with a regular expression (case-insensitive). ' +
        'Skips dependency, build and cache directories (node_modules, dist, .angular, .venv, …), binary/media files, ' +
        "and everything the project's .gitignore excludes. Returns file:line:text matches. " +
        'Set include_ignored to search those paths anyway (e.g. to grep a dependency or build output).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for (case-insensitive).' },
          path: { type: 'string', description: 'Directory to search from. Default "."' },
          include: { type: 'string', description: 'Optional filename filter with * and ? wildcards, e.g. "*.js".' },
          max_results: { type: 'integer', description: 'Maximum matches to return. Default 100.' },
          include_ignored: {
            type: 'boolean',
            description:
              'Also search ignored paths: build output, caches, dependencies and .gitignore matches. Default false.',
          },
        },
        required: ['pattern'],
      },
      run({ pattern, path: p = '.', include, max_results, include_ignored }) {
        const absRoot = resolvePath(p);
        let re;
        try {
          re = new RegExp(String(pattern), 'i');
        } catch (e) {
          throw new Error(`invalid regular expression: ${e.message}`);
        }
        let fileRe = null;
        if (include) {
          const esc = String(include).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
          fileRe = new RegExp(`^${esc}$`, 'i');
        }
        const cap = Math.min(1000, Math.max(1, Number(max_results) || MAX_SEARCH_RESULTS));
        const ignore = createIgnoreMatcher({
          root: absRoot,
          extra: config.searchIgnore,
          gitignore: !include_ignored,
          builtins: !include_ignored,
        });
        if (!include_ignored) ignore.seed();
        const results = [];
        const walk = (dir) => {
          if (results.length >= cap) return;
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // stable output
          const mark = ignore.enter(dir);
          try {
            for (const e of entries) {
              if (results.length >= cap) return;
              const full = path.join(dir, e.name);
              if (e.isDirectory()) {
                if (!ignore.ignores(full, true)) walk(full);
                continue;
              }
              if (!e.isFile()) continue;
              if (fileRe && !fileRe.test(e.name)) continue;
              if (ignore.ignores(full, false)) continue;
              let st;
              try { st = fs.statSync(full); } catch { continue; }
              if (st.size > MAX_READ_BYTES) continue;
              let text;
              try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
              if (text.includes('\u0000')) continue;
              const lines = normalizeEol(text).split('\n'); // CRLF/CR normalized so matches read cleanly
              for (let i = 0; i < lines.length && results.length < cap; i++) {
                if (re.test(lines[i])) {
                  results.push(`${rel(full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                }
              }
            }
          } finally {
            ignore.leave(mark);
          }
        };
        walk(absRoot);
        if (results.length === 0) {
          const note = include_ignored
            ? ''
            : " (dependencies, build output, caches and .gitignore'd paths are skipped — pass include_ignored to search them)";
          return `No matches for /${pattern}/ under ${rel(absRoot)}${note}`;
        }
        return results.join('\n') + (results.length >= cap ? `\n… (stopped at ${cap} matches)` : '');
      },
    },
    {
      name: 'run_command',
      description:
        'Run a shell command in the workspace and return stdout/stderr/exit code. ' +
        'The shell is OS-aware (cmd.exe on Windows, bash/sh on Unix — configurable via "shell" in config). ' +
        'Write commands that work on the current OS.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to execute.' },
          cwd: { type: 'string', description: 'Working directory relative to the workspace. Default: workspace root.' },
          timeout: { type: 'number', description: 'Timeout in seconds. Default: config commandTimeout.' },
        },
        required: ['command'],
      },
      run(args) {
        return runCommand(config, baseCwd, args);
      },
    },
  ];

  const byName = new Map(defs.map((d) => [d.name, d]));

  return {
    get cwd() {
      return baseCwd;
    },
    /** Change the workspace root at runtime (`/set dir <path>`). Returns the new absolute path. */
    setCwd(p) {
      const target = String(p ?? '').trim();
      if (!target) return baseCwd;
      const abs = path.resolve(baseCwd, expandHome(target));
      let st = null;
      try {
        st = fs.statSync(abs);
      } catch (e) {
        throw new Error(`cannot use ${abs}: ${e.code === 'ENOENT' ? 'no such directory' : e.message}`);
      }
      if (!st.isDirectory()) throw new Error(`${abs} is not a directory`);
      baseCwd = abs;
      if (config) config.workspace = abs; // keep /config and follow-up runs consistent
      return abs;
    },
    listTools: () => defs.map(({ name, description, parameters }) => ({ name, description, parameters })),
    async execute(name, args) {
      const def = byName.get(name);
      if (!def) return `Error: unknown tool "${name}"`;
      try {
        return String(await def.run(args || {}));
      } catch (e) {
        return `Error: ${e.message}`;
      }
    },
  };
}
