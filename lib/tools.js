/* Built-in coding tools: file operations + OS-aware command execution. */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  '.next', '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.turbo',
]);

const MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_CMD_CHARS = 100_000;
const MAX_SEARCH_RESULTS = 100;

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

export function createTools(config) {
  const baseCwd = path.resolve(config.workspace || process.cwd());

  const resolvePath = (p) => {
    const abs = path.resolve(baseCwd, String(p ?? '.'));
    return abs;
  };
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
        const text = fs.readFileSync(abs, 'utf8');
        if (text.includes('\u0000')) throw new Error(`${rel(abs)} looks like a binary file`);
        const all = text.split('\n');
        const start = Math.max(1, Number(offset) || 1) - 1;
        const end = Math.min(all.length, start + Math.max(1, Number(limit) || 2000));
        const window = all.slice(start, end);
        return `# ${rel(abs)} — lines ${start + 1}-${end} of ${all.length}\n${window.join('\n')}`;
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a file with the given content. Parent directories are created as needed.',
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
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(content ?? ''), 'utf8');
        return `${existed ? 'Overwrote' : 'Wrote'} ${rel(abs)} (${Buffer.byteLength(String(content ?? ''))} bytes)`;
      },
    },
    {
      name: 'edit_file',
      description:
        'Replace exact text in a file. old_text must match the file content exactly (copy it from read_file). ' +
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
        const text = fs.readFileSync(abs, 'utf8');
        const needle = String(old_text ?? '');
        if (!needle) throw new Error('old_text must not be empty');
        const count = text.split(needle).length - 1;
        if (count === 0) {
          throw new Error(`old_text not found in ${rel(abs)} — it must match the file exactly (whitespace included)`);
        }
        if (count > 1 && !replace_all) {
          throw new Error(`old_text occurs ${count} times in ${rel(abs)} — provide more context or set replace_all`);
        }
        const updated = replace_all ? text.split(needle).join(String(new_text ?? '')) : text.replace(needle, String(new_text ?? ''));
        fs.writeFileSync(abs, updated, 'utf8');
        return `Replaced ${replace_all ? count : 1} occurrence(s) in ${rel(abs)}`;
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
        'Search file contents recursively with a regular expression. Skips node_modules/.git/build output. ' +
        'Returns file:line:text matches.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for (case-insensitive).' },
          path: { type: 'string', description: 'Directory to search from. Default "."' },
          include: { type: 'string', description: 'Optional filename filter with * and ? wildcards, e.g. "*.js".' },
          max_results: { type: 'integer', description: 'Maximum matches to return. Default 100.' },
        },
        required: ['pattern'],
      },
      run({ pattern, path: p = '.', include, max_results }) {
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
        const results = [];
        const walk = (dir) => {
          if (results.length >= cap) return;
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (results.length >= cap) return;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
              if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.git')) walk(full);
              continue;
            }
            if (!e.isFile()) continue;
            if (fileRe && !fileRe.test(e.name)) continue;
            let st;
            try { st = fs.statSync(full); } catch { continue; }
            if (st.size > MAX_READ_BYTES) continue;
            let text;
            try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
            if (text.includes('\u0000')) continue;
            const lines = text.split('\n');
            for (let i = 0; i < lines.length && results.length < cap; i++) {
              if (re.test(lines[i])) {
                results.push(`${rel(full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
              }
            }
          }
        };
        walk(absRoot);
        if (results.length === 0) return `No matches for /${pattern}/ under ${rel(absRoot)}`;
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
    cwd: baseCwd,
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
