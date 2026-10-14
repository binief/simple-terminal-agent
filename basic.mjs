#!/usr/bin/env node
/**
 * basic.mjs — tiny three-mode coding agent.
 *
 *   node basic.mjs              interactive
 *   node basic.mjs --once "…"   one shot (rewrite if enabled, then plan, then implement)
 *
 * Modes
 *   rewrite   — prompt-shaping only, and opt-in. The model rewrites the user's
 *               raw request into a well-formed prompt (role, goal, grounded
 *               context, scope, constraints, acceptance criteria), inspecting
 *               the project with the same READ-ONLY tools as plan mode so it
 *               names files and commands that actually exist. It ends with a
 *               REFINED PROMPT block. Interactively that block is NOT used
 *               until the user confirms it (blank line or /accept; any other
 *               text revises it, /use-raw plans the original, /cancel drops
 *               it); in --once mode it continues automatically. Turn it on
 *               with config rewrite: true, BASIC_REWRITE=1, --rewrite, or
 *               /rewrite on; /rewrite <task> runs it once even when it is off.
 *   plan      — analysis only. The project is READ-ONLY: write_file/edit_file
 *               refuse any path outside the plan directory and run_command
 *               only accepts read-only commands. The agent asks questions if
 *               unclear, then writes an IMPLEMENT PROMPT, which is saved to a
 *               plan file under planDir instead of the project. planDir lives
 *               outside the workspace (a planDir inside it is moved out), so
 *               plan files are never part of the project. Plans outlive the
 *               console: the last one is picked up on start, /plans lists them
 *               and /implement <n> runs one, so work can be resumed. When the
 *               plan came from a confirmed rewrite, the plan file opens with
 *               that refined prompt (and the original request), so the brief
 *               IMPLEMENT mode runs from carries both.
 *   implement — the only mode that changes project files. Its user prompt is
 *               the saved plan file; there is no extra system prompt.
 *
 * Turns
 *   A turn has no step limit: it keeps stepping — request, tool calls,
 *   request — until the model replies without tool calls (the task is done)
 *   or Ctrl+C stops it. Auto-compaction (below) keeps a long turn inside
 *   the context window, so a big task is not cut off by either budget.
 *
 * Line endings
 *   CRLF, CR and LF files are all read as LF for matching and display, and
 *   written back in the file's own style: a read shows clean LF lines (the
 *   header names a non-LF style), an edit's LF old_text matches a CRLF
 *   file, and no write ever mixes endings or silently converts a file.
 *   New files get the OS style; config lineEndings can force one.
 *
 * Context
 *   The conversation is measured before every request. At >= 90% of contextSize
 *   it is compacted automatically (config autoCompact): the model summarizes it
 *   and the originals are dropped, so a turn is not lost to a "context length
 *   exceeded" error. A request the server refuses for being too long is
 *   compacted and sent again, once. When a compaction is not possible, requests
 *   go out with older tool results and reasoning trimmed instead. /compact does
 *   it on demand, /reset is the blunt version: it drops the conversation.
 *
 * Reading, cheaply
 *   search_files finds code without opening files, list_files maps a directory
 *   (both in-process, so no grep/findstr needed), and read_file reads a window
 *   rather than a whole file — the context is spent on the code that matters.
 *
 * Ctrl+C
 *   Interrupts the running execution (the model request and any command a tool
 *   started) and returns to the prompt with the history intact. A second Ctrl+C
 *   within a couple of seconds — or a Ctrl+C while the agent is idle — exits.
 *
 * Paths
 *   Every tool path is relative to the workspace (--dir, or config workspace):
 *   "src/app.js" is the project's file, wherever the CLI was started. Paths
 *   outside the workspace are refused (the plan directory excepted), and tool
 *   results print workspace-relative paths — absolute ones only when a file
 *   really is outside.
 *
 * Commands
 *   Commands are OS-aware. They run in cmd.exe on Windows and in bash/zsh/sh
 *   elsewhere (config shell or BASIC_SHELL overrides both), and PLAN mode
 *   refuses read-only commands from the other OS — `ls` on Windows, `dir` on
 *   Linux — naming the equivalent instead of letting the shell fail.
 *
 * Config (optional JSON, --config path or BASIC_CONFIG):
 *   { openai: { baseURL, apiKey, model }, maxTokens: 4096, contextSize: 64000,
 *     workspace, planDir: "<os tmp>/basic-plans", planAllowCommands: ["make"],
 *     rewrite: false, shell: "bash", autoCompact: true, lineEndings: "auto",
 *     mcp: { servers: {
 *       name: { command, args?, env? }           // stdio
 *       name: { type: "http", url, headers? }    // HTTP
 *   } } }
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { calibrateTokens, classifyApiError, estimatePromptTokens, isContextLengthError, serverErrorSummary, smallerReplyTokenLimit, TOOL_CALL_PARSE_ERROR } from './lib/llm.js';
import { createIgnoreMatcher } from './lib/ignore.js';
import { extractImplementPrompt, extractRefinedPrompt, isReadOnlyCommand, platformFamily, readOnlyCommandExamples, shellCommandFamily } from './lib/plan.js';
import { applyEol, detectEol, eolName, normalizeEol, resolveEol, resolveShell } from './lib/tools.js';
import { fmtDuration, s, spinner } from './lib/ui.js';

const OPENAI = {
  baseURL: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  apiKey: process.env.OPENAI_API_KEY || '',
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
};

let maxTokens = 4096;
let contextSize = 64000;
const MAX_TOOL_CALL_RETRIES = 3;
/**
 * Context accounting. At COMPACT_AT_PERCENT the conversation is compacted
 * automatically (autoCompact, default on) so a turn is not lost to a
 * "context length exceeded" error; the request also goes out trimmed. After a
 * compaction nothing more happens until the conversation drops back below
 * COMPACT_CLEAR_PERCENT, so a summary that frees little does not run again on
 * every step.
 */
const COMPACT_AT_PERCENT = 90;
const COMPACT_CLEAR_PERCENT = 75;
/** Compact the conversation automatically at COMPACT_AT_PERCENT (config autoCompact). */
let autoCompact = process.env.BASIC_AUTO_COMPACT !== '0';
let contextWarned = false;
/** A compaction is allowed again once usage falls below COMPACT_CLEAR_PERCENT. */
let compactArmed = true;
/** On above COMPACT_AT_PERCENT: requests go out with older tool output trimmed. */
let compactMode = false;

let workspace = process.cwd();
let mcp = emptyMcp();

/**
 * 'rewrite' (read-only prompt-shaping), 'plan' (read-only analysis) or
 * 'implement' (the only mode that writes).
 */
let mode = 'plan';
/** Modes in which the project is read-only and only planDir may be written. */
const isReadOnlyMode = () => mode === 'plan' || mode === 'rewrite';
/** "PLAN" or "REWRITE" — for refusals that must name the mode that issued them. */
const readOnlyModeName = () => (mode === 'rewrite' ? 'REWRITE' : 'PLAN');
/**
 * Whether every new task is rewritten before it is planned (config rewrite,
 * BASIC_REWRITE=1, --rewrite, /rewrite on). Default off: /rewrite <task>
 * runs the phase once without switching it on.
 */
let rewriteEnabled = /^(1|true|yes|on)$/i.test(process.env.BASIC_REWRITE || '');
/** Where PLAN mode is allowed to write: the saved plans and any working notes. */
let planDir = path.join(os.tmpdir(), 'basic-plans');
/** Extra commands PLAN mode may run (config planAllowCommands). */
let planAllowCommands = [];
/** Shell override (config shell / BASIC_SHELL): a path, or "powershell" on Windows. */
let shellConfig = process.env.BASIC_SHELL || null;
/** /verbose: show full tool arguments and results instead of the compact preview. */
let verbose = process.env.BASIC_VERBOSE === '1';
/** Newline style for files the tools write (config lineEndings, default 'auto': keep the file's own, else the OS style). */
let lineEndings = 'auto';

/** Accepted config lineEndings values and their aliases — mirrors lib/config.js. */
const LINE_ENDING_ALIASES = {
  auto: 'auto', lf: 'lf', unix: 'lf', crlf: 'crlf', win: 'crlf', windows: 'crlf',
  cr: 'cr', mac: 'cr', native: 'native', os: 'native', system: 'native',
};

/**
 * The newline a write should use for a file whose current style is
 * `existingEol` (null when unknown/new): the configured style when forced,
 * otherwise the file's own, otherwise the OS default — never a mix.
 */
const eolFor = (existingEol) => resolveEol({ lineEndings }, existingEol);

function emptyMcp() {
  return { listTools: () => [], has: () => false, call: async () => '', closeAll() {} };
}

/* ------------------------------- interrupt ------------------------------- */

/* Ctrl+C must stop the work, not the session. Every unit of work (a turn, a
 * compaction) registers itself in activeExecution, so the signal handler has
 * something concrete to abort: the AbortController cancels the in-flight HTTP
 * request, and the children set lets it stop a command the tools started.
 *
 * Ctrl+C reaches us by one of two routes, depending on how the CLI was started:
 *   - on a TTY, readline holds stdin in raw mode and emits 'SIGINT' itself;
 *   - with piped stdin (or from `kill -INT` / --once mode), the signal arrives
 *     at the process instead.
 * Exactly one of the two fires per keypress, so both are wired to onInterrupt. */
const SECOND_INTERRUPT_MS = 2000;
/** The running execution ({ controller, children }), or null while idle. */
let activeExecution = null;
/** True when the execution that just ended was stopped by Ctrl+C. */
let interrupted = false;
let lastInterruptAt = 0;

/** Start an interruptible unit of work and return its handle. */
function beginExecution() {
  interrupted = false;
  const execution = { controller: new AbortController(), children: new Set() };
  activeExecution = execution;
  return execution;
}

/** Retire a handle; nothing it started outlives it. */
function endExecution(execution) {
  if (activeExecution === execution) activeExecution = null;
  for (const child of execution.children) killChild(child);
  execution.children.clear();
}

/** Abort the in-flight request and stop the commands the tools started. */
function cancelExecution(execution) {
  interrupted = true;
  execution.controller.abort();
  for (const child of execution.children) killChild(child);
}

/** Best-effort stop for one command, its process group included on POSIX. */
function killChild(child) {
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  if (process.platform !== 'win32' && child.pid) {
    // runShell puts each command in its own process group, so this reaches
    // pipes and `a && b` children that the shell itself would leave behind.
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* not a group leader */ }
  }
}

function abortError() {
  return Object.assign(new Error('interrupted by Ctrl+C'), { name: 'AbortError' });
}

/** Rejects as soon as `signal` aborts — for work that cannot be cancelled itself. */
function abortRace(signal) {
  const pending = new Promise((_, reject) => {
    if (signal.aborted) reject(abortError());
    else signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
  // A race that was already won must not leave an unhandled rejection behind.
  pending.catch(() => {});
  return pending;
}

/** Ctrl+C: stop what is running, or leave when there is nothing to stop. */
function onInterrupt() {
  const now = Date.now();
  const secondPress = now - lastInterruptAt < SECOND_INTERRUPT_MS;
  lastInterruptAt = now;
  const execution = activeExecution;
  if (!execution) { // idle: Ctrl+C is just another way to quit
    console.log(`\n${s.dim('interrupted — exiting')}`);
    process.exit(0);
  }
  if (secondPress) { // the first press is still winding down: stop waiting and go
    console.log(`\n${tag('interrupt', s.red)} second Ctrl+C — exiting`);
    process.exit(130);
  }
  cancelExecution(execution);
  console.log(
    `\n${tag('interrupt', s.yellow)} stopping the current execution ` +
    `${s.dim('(the request and any command it started) — press Ctrl+C again to quit')}`
  );
}

process.on('SIGINT', onInterrupt); // piped stdin, `kill -INT`, --once mode

/* ----------------------------- files / shell ----------------------------- */

/** Expand a leading `~`, so `~/src/a.js` and `~` both work. */
function expandHome(p) {
  const text = String(p ?? '');
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2));
  return text;
}

/**
 * Absolute path for a tool argument. Anything that is not absolute is taken
 * relative to the workspace — never to the directory the CLI happened to start
 * in — so a model that answers with "src/app.js" always lands in the project.
 */
function resolvePath(p) {
  const text = expandHome(p);
  if (!text || !text.trim()) throw new Error('path required');
  const abs = path.isAbsolute(text) ? text : path.join(workspace, text);
  return path.normalize(abs);
}

/** The path as the model should think of it: workspace-relative, or absolute when it is outside. */
function displayPath(abs) {
  const rel = path.relative(workspace, abs);
  if (!rel) return '.'; // the workspace root itself
  return !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
}

function isInside(dir, abs) {
  const rel = path.relative(path.resolve(dir), path.resolve(abs));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Every file tool argument lands here first. Two rules, both about scope:
 *   - outside the workspace the tool does not touch it at all (the plan
 *     directory excepted: that is where PLAN mode is allowed to write);
 *   - PLAN mode additionally refuses every project path (see guardWrite).
 * The refusal names the workspace root and the relative form, so a model that
 * guessed a path learns how to write one instead of trying another random one.
 */
function guardPath(abs, { allowRoot = false } = {}) {
  if (isInside(planDir, abs)) return; // plans and working notes live here
  if (isInside(workspace, abs)) return;
  const root = path.resolve(abs) === path.resolve(workspace);
  if (root && allowRoot) return; // "." is a fine directory for a search or a listing
  if (root) {
    throw new Error(`${workspace} is the workspace root, not a file — name a file inside it, e.g. "src/app.js"`);
  }
  throw new Error(
    `${abs} is outside the workspace (${workspace}). Paths are relative to the workspace root — ` +
    `use "src/app.js", or an absolute path inside ${workspace}. Outside files cannot be read or written.`
  );
}

/**
 * Keep the two directories visibly apart. Plans are never part of the project:
 * if the config points planDir inside the workspace, the model ends up
 * searching the project for plan files (and writing notes into it), so the
 * default outside the workspace wins and the override is reported.
 */
function separatePlanDir() {
  if (!isInside(workspace, planDir) && path.resolve(planDir) !== path.resolve(workspace)) return;
  const outside = path.join(os.tmpdir(), 'basic-plans');
  console.log(
    `${tag('plans', s.yellow)} config planDir ${planDir} is inside the workspace — ` +
    `using ${outside} instead, so plans and project files stay separate`
  );
  planDir = outside;
}

/* The read-only modes (PLAN and REWRITE) are enforced here, not just asked
 * for in the prompt: a tool that would change the project refuses before
 * touching the disk, and the refusal comes back as a tool result the model
 * can read and act on. The only writable place is planDir, so plans, refined
 * prompts and working notes can still be persisted. */
const READ_ONLY_MARKER = 'mode is read-only';
const readOnlyRefusal = () => `${readOnlyModeName()} ${READ_ONLY_MARKER}`;

function guardWrite(abs) {
  if (!isReadOnlyMode() || isInside(planDir, abs)) return;
  const block = mode === 'rewrite' ? 'REFINED PROMPT' : 'IMPLEMENT PROMPT';
  throw new Error(
    `${readOnlyRefusal()}: ${abs} was not written. Project files change only in IMPLEMENT mode. ` +
    `Keep plans and working notes under ${planDir}, and finish with the ${block} block.`
  );
}

function guardCommand(command) {
  if (!isReadOnlyMode()) return;
  // OS-aware: `ls` is read-only but does not exist in cmd.exe, so the refusal
  // names the command this machine has instead of letting the shell fail.
  const { family } = shellInfo();
  const verdict = isReadOnlyCommand(command, planAllowCommands, {
    platform: process.platform,
    // Git Bash on Windows really does have `ls` — then the OS check is noise.
    ignoreOs: family !== platformFamily(process.platform),
  });
  if (verdict.ok) return;
  throw new Error(
    `${readOnlyRefusal()}: \`${String(command ?? '').trim()}\` was not run (${verdict.reason}). ` +
    `Only read-only commands run in ${readOnlyModeName()} mode (${readOnlyCommandExamples(family)}, …), ` +
    `and only ones this OS has (commands run through ${shellVia()}); anything that changes the project waits for IMPLEMENT mode.`
  );
}

/**
 * Where commands actually run. The shell decides the command language: cmd.exe
 * and PowerShell speak Windows, bash/sh/zsh speak POSIX — also on Windows, when
 * the config points at Git Bash or WSL, in which case `ls` exists after all.
 */
function shellInfo() {
  const shell = resolveShell(shellConfig);
  const family = shellCommandFamily(shell.command) || platformFamily(shell.platform);
  return { shell, family, platform: shell.platform || process.platform };
}

/** The platform whose command language the tools should assume. */
function shellPlatform() {
  return shellInfo().family;
}

/* Reading costs tokens, and a whole 2000-line file is nearly never what the
 * model needs. search_files answers "where is X?" with a handful of lines,
 * list_files answers "what is here?" without `ls -R`, and read_file reads a
 * window — so a turn spends its context on the code that matters. */

/** Default and hard cap for one read_file window. */
const READ_LINES = 200;
const MAX_READ_LINES = 800;
/** A single line longer than this (minified bundles, lockfiles) is cut. */
const MAX_LINE_CHARS = 2000;
const MAX_SEARCH_RESULTS = 40;
const MAX_LIST_ENTRIES = 200;
/** Files bigger than this are not searched or dumped; they need a narrower tool. */
const MAX_FILE_BYTES = 512 * 1024;
/**
 * Hard ceiling on what one read_file call returns, kept below the 20000-char
 * cap every tool result is sent under so the "… N more lines" footer survives.
 */
const MAX_READ_CHARS = 16_000;

const BUILTIN = {
  read_file: {
    description: `Read a window of a text file (${READ_LINES} lines by default, at most ${MAX_READ_LINES}). Relative paths resolve against the workspace root; paths outside it are refused. Locate code with search_files first — reading a whole file to find one function wastes the context.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'integer', description: 'First line to return (1-based).' },
        max_lines: { type: 'integer', description: `How many lines to return (default ${READ_LINES}, max ${MAX_READ_LINES}).` },
      },
      required: ['path'],
    },
    async run({ path: p, start_line, max_lines }) {
      const abs = resolvePath(p);
      guardPath(abs);
      let text;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch (e) {
        throw new Error(readPathError(e, abs));
      }
      // CRLF/CR files are shown as LF, so no stray \r rides along on a line;
      // the header names the file's own style, which an edit writes back.
      const eol = detectEol(text);
      const lines = normalizeEol(text).split('\n');
      const start = Math.max(1, start_line || 1);
      const take = Math.min(max_lines || READ_LINES, MAX_READ_LINES);
      // Two budgets: one window of lines, and a ceiling on characters — 800
      // lines of minified code would otherwise be a megabyte of context.
      const numbered = [];
      let budget = MAX_READ_CHARS;
      for (let i = 0; i < take; i++) {
        const line = lines[start - 1 + i];
        if (line === undefined) break;
        const text = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… (+${line.length - MAX_LINE_CHARS} chars)` : line;
        const row = `${String(start + i).padStart(4)}|${text}\n`;
        if (row.length > budget) break;
        budget -= row.length;
        numbered.push(row);
      }
      const shownTo = start - 1 + numbered.length;
      const more = lines.length - shownTo;
      const footer = more > 0 ? `\n…[${more} more lines — read_file start_line=${shownTo + 1} to continue; prefer search_files to jump straight to a match]` : '';
      const eolNote = eol && eol !== '\n' ? ` · ${eolName(eol)} line endings (shown as LF; edits keep ${eolName(eol)})` : '';
      return `file ${displayPath(abs)} — lines ${start}-${shownTo} of ${lines.length}${eolNote}\n${numbered.join('').trimEnd()}${footer}`;
    },
  },
  search_files: {
    description:
      'Search the workspace for a regular expression and return file:line:text matches. ' +
      'This is how to find code without reading whole files — use it before read_file. ' +
      'Skips dependency, build and cache directories, binary files and .gitignore matches (include_ignored to override). ' +
      'Works the same on every OS: no grep or findstr needed.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for (case-insensitive).' },
        path: { type: 'string', description: 'Directory to search, relative to the workspace root. Default "."' },
        include: { type: 'string', description: 'Filename filter with * and ? wildcards, e.g. "*.js".' },
        max_results: { type: 'integer', description: `Maximum matches (default ${MAX_SEARCH_RESULTS}).` },
        include_ignored: { type: 'boolean', description: 'Also search ignored paths (dependencies, build output). Default false.' },
      },
      required: ['pattern'],
    },
    run({ pattern, path: p = '.', include, max_results, include_ignored }) {
      const absRoot = resolvePath(p);
      guardPath(absRoot, { allowRoot: true });
      let re;
      try {
        re = new RegExp(String(pattern ?? ''), 'i');
      } catch (e) {
        throw new Error(`invalid regular expression: ${e.message}`);
      }
      let fileRe = null;
      if (include) {
        const esc = String(include).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
        fileRe = new RegExp(`^${esc}$`, 'i');
      }
      const cap = Math.min(200, Math.max(1, Number(max_results) || MAX_SEARCH_RESULTS));
      const ignore = createIgnoreMatcher({ root: workspace, gitignore: !include_ignored, builtins: !include_ignored });
      ignore.seed();
      const results = [];
      let scanned = 0;
      let skipped = 0;
      const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const mark = ignore.enter(dir);
        try {
          for (const e of entries) {
            if (results.length >= cap) return;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
              if (!ignore.ignores(full, true)) walk(full);
              continue;
            }
            if (!e.isFile() || (fileRe && !fileRe.test(e.name)) || ignore.ignores(full, false)) continue;
            let st;
            try { st = fs.statSync(full); } catch { continue; }
            if (st.size > MAX_FILE_BYTES) { skipped++; continue; }
            let text;
            try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
            if (text.includes('\u0000')) { skipped++; continue; } // binary
            scanned++;
            const lines = normalizeEol(text).split('\n'); // CRLF files match and report clean LF lines
            for (let i = 0; i < lines.length && results.length < cap; i++) {
              if (re.test(lines[i])) results.push(`${displayPath(full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            }
          }
        } finally {
          ignore.leave(mark);
        }
      };
      walk(absRoot);
      const scope = displayPath(absRoot);
      if (!results.length) {
        return `No matches for /${pattern}/ under ${scope} — ${scanned} file(s) searched${skipped ? `, ${skipped} skipped (binary or too large)` : ''}.`;
      }
      const cut = results.length >= cap ? `\n… (stopped at ${cap} matches — narrow the pattern or the include filter)` : '';
      return `${results.length} match(es) for /${pattern}/ under ${scope} — ${scanned} file(s) searched\n${results.join('\n')}${cut}`;
    },
  },
  list_files: {
    description:
      'List workspace files and directories, ignoring dependencies, build output and caches. ' +
      'Cheaper than `ls -R` and the same on every OS. Use it to get oriented, then search_files or read_file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list, relative to the workspace root. Default "."' },
        depth: { type: 'integer', description: 'How many levels to walk (default 2).' },
        max_entries: { type: 'integer', description: `Maximum entries (default ${MAX_LIST_ENTRIES}).` },
      },
      required: [],
    },
    run({ path: p = '.', depth, max_entries }) {
      const absRoot = resolvePath(p);
      guardPath(absRoot, { allowRoot: true });
      const maxDepth = Math.min(6, Math.max(1, Number(depth) || 2));
      const cap = Math.min(1000, Math.max(1, Number(max_entries) || MAX_LIST_ENTRIES));
      const ignore = createIgnoreMatcher({ root: workspace });
      ignore.seed();
      const dirs = [];
      const files = [];
      let truncated = false;
      const walk = (dir, level) => {
        if (dirs.length + files.length >= cap) { truncated = true; return; }
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const mark = ignore.enter(dir);
        try {
          for (const e of entries) {
            if (dirs.length + files.length >= cap) { truncated = true; return; }
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
              if (ignore.ignores(full, true)) continue;
              dirs.push(`${displayPath(full)}/`);
              if (level < maxDepth) walk(full, level + 1);
              continue;
            }
            if (!e.isFile() || ignore.ignores(full, false)) continue;
            let size = '';
            try {
              const st = fs.statSync(full);
              size = st.size > 4096 ? `  (${Math.round(st.size / 1024)}k)` : `  (${st.size}b)`;
            } catch { /* stat may fail on a broken symlink */ }
            files.push(`${displayPath(full)}${size}`);
          }
        } finally {
          ignore.leave(mark);
        }
      };
      walk(absRoot, 1);
      const more = truncated ? `\n… (stopped at ${cap} entries — raise max_entries or narrow the path)` : '';
      return `# ${displayPath(absRoot)} — ${dirs.length} dir(s), ${files.length} file(s), depth ≤ ${maxDepth}\n${[...dirs, ...files].join('\n')}${more}`;
    },
  },
  write_file: {
    description: 'Create or overwrite a text file in the workspace (relative paths resolve against the workspace root; paths outside it are refused). Line endings are written in the overwritten file\'s own style (a new file gets the OS style; config lineEndings can force one), so mixed CRLF/LF content comes out in the one style. Keep calls small: for large new files write the first section, then append sections using edit_file in separate replies. For existing files prefer targeted edit_file calls.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    async run({ path: p, content }) {
      const abs = resolvePath(p);
      guardPath(abs);
      guardWrite(abs);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // An overwritten file keeps its own newline style; the content is
      // normalized to that one style first, so endings are never mixed.
      let existingEol = null;
      try { existingEol = detectEol(fs.readFileSync(abs, 'utf8')); } catch { /* a new file has no style yet */ }
      const eol = eolFor(existingEol);
      const text = applyEol(content ?? '', eol);
      fs.writeFileSync(abs, text, 'utf8');
      return `wrote ${displayPath(abs)} (${text.length} chars, ${eolName(eol)} line endings)`;
    },
  },
  edit_file: {
    description: 'Replace old_text with new_text in a workspace file (relative paths resolve against the workspace root; paths outside it are refused). Line endings are handled for you: a CRLF/CR file matches LF old_text and is written back in its own style.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
    async run({ path: p, old_text, new_text }) {
      const abs = resolvePath(p);
      guardPath(abs);
      guardWrite(abs);
      let raw;
      try {
        raw = fs.readFileSync(abs, 'utf8');
      } catch (e) {
        throw new Error(readPathError(e, abs));
      }
      // Match in canonical LF, write back in the file's own style: an LF
      // old_text from the model matches a CRLF file, a CRLF new_text lands
      // in an LF file as LF — endings are never mixed, never converted.
      const fileEol = detectEol(raw);
      const text = normalizeEol(raw);
      const needle = normalizeEol(old_text ?? '');
      if (!needle) throw new Error('old_text must not be empty');
      if (!text.includes(needle)) {
        throw new Error(`old_text not found in ${displayPath(abs)} — read the file again and copy the text exactly (line endings are matched as LF, so a CRLF file needs no special handling)`);
      }
      const updated = text.replace(needle, () => normalizeEol(new_text ?? '')); // function form: $ sequences stay literal
      const eol = eolFor(fileEol);
      fs.writeFileSync(abs, applyEol(updated, eol), 'utf8');
      return `edited ${displayPath(abs)}${fileEol && fileEol !== '\n' ? ` (${eolName(fileEol)} line endings preserved)` : ''}`;
    },
  },
  run_command: {
    description: () => `Run a shell command in the workspace (${shellSummary()}). Optional timeout_sec (default 60).`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_sec: { type: 'number' },
      },
      required: ['command'],
    },
    async run({ command, timeout_sec }) {
      guardCommand(command);
      return await runShell(command, timeout_sec || 60);
    },
  },
};

/** Why a path could not be read, in words the model can act on (code included). */
function readPathError(e, abs) {
  const shown = displayPath(abs);
  const code = e.code ? ` (${e.code})` : '';
  if (e.code === 'ENOENT') {
    return `no such file: ${shown}${code} — relative paths resolve against the workspace root ${workspace}`;
  }
  if (e.code === 'EISDIR') return `${shown} is a directory, not a file${code}`;
  if (e.code === 'EACCES') return `${shown} cannot be read: permission denied${code}`;
  return `${shown}: ${e.message}${code}`;
}

/** Tool descriptions carry the current mode's rules, so the model is told, not just refused. */
const MODE_NOTES = {
  plan: {
    write_file: () => ` PLAN mode: only paths under ${planDir} may be written (plans, working notes). Project files are read-only until IMPLEMENT mode.`,
    edit_file: () => ` PLAN mode: only files under ${planDir} may be edited. Project files are read-only until IMPLEMENT mode.`,
    run_command: () => ` PLAN mode: read-only commands only (${readOnlyCommandExamples(shellPlatform())}, …), and only ones that exist on this OS (commands run through ${shellVia()}); builds, installs and anything writing files are refused.`,
  },
  rewrite: {
    write_file: () => ` REWRITE mode: only paths under ${planDir} may be written (working notes). Project files are read-only until IMPLEMENT mode.`,
    edit_file: () => ` REWRITE mode: only files under ${planDir} may be edited. Project files are read-only until IMPLEMENT mode.`,
    run_command: () => ` REWRITE mode: read-only commands only (${readOnlyCommandExamples(shellPlatform())}, …), and only ones that exist on this OS (commands run through ${shellVia()}); builds, installs and anything writing files are refused.`,
  },
  implement: {},
};

/** The shell this machine runs commands in: "Linux/macOS · bash -c". */
function shellSummary() {
  const { shell, family } = shellInfo();
  return `${family === 'windows' ? 'Windows' : 'Linux/macOS'} · ${path.basename(shell.command)} ${shell.args.join(' ')}`;
}

/** The same thing in prose: "bash -c on Linux/macOS". */
function shellVia() {
  const { shell, family } = shellInfo();
  return `${path.basename(shell.command)} ${shell.args.join(' ')} on ${family === 'windows' ? 'Windows' : 'Linux/macOS'}`;
}

function runShell(command, timeoutSec) {
  const { shell, family } = shellInfo(); // cmd.exe on Windows, bash/zsh/sh on Unix
  return new Promise((resolve) => {
    const child = spawn(shell.command, [...shell.args, String(command ?? '')], {
      cwd: workspace, // commands run in the project, whatever the CLI was started from
      env: process.env,
      windowsHide: true,
      // POSIX: give the command its own process group, so an interrupt can stop
      // the whole thing (pipes, `a && b`) instead of only the shell around it.
      detached: family !== 'windows',
    });
    let out = '';
    let settled = false;
    // Registered with the execution that owns this command: Ctrl+C kills it.
    const execution = activeExecution;
    execution?.children.add(child);
    const finish = (text) => {
      if (settled) return; // timeout and close can both fire; only the first counts
      settled = true;
      clearTimeout(t);
      execution?.children.delete(child);
      resolve(text);
    };
    const add = (d) => {
      out += d;
      if (out.length > 80_000) out = out.slice(-80_000);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const t = setTimeout(() => {
      killChild(child); // the whole command, not just the shell around it
      finish(`(timeout ${timeoutSec}s)\n${out}`);
    }, timeoutSec * 1000);
    child.on('close', (code) => {
      // A signal kill is what an interrupt looks like here; say so, because
      // `exit null` alone would read like a crash.
      const stopped = execution?.controller.signal.aborted;
      finish(`${stopped ? '(interrupted) ' : ''}exit ${code}\n${out}`.trimEnd());
    });
    child.on('error', (e) => {
      finish(`error: ${e.message}`);
    });
  });
}

/* --------------------------------- MCP --------------------------------- */

class StdioRpc {
  constructor(name, { command, args = [], env = {} }) {
    this.name = name;
    this._id = 0;
    this._pending = new Map();
    this._buf = '';
    this.child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      this._buf += d;
      let i;
      while ((i = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, i).trim();
        this._buf = this._buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = this._pending.get(msg.id);
        if (!p) continue;
        this._pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    });
    this.child.on('exit', () => {
      for (const [, p] of this._pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`mcp ${this.name} exited`));
      }
      this._pending.clear();
    });
  }
  request(method, params = {}, timeoutMs = 30000) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`mcp ${this.name} ${method} timeout`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method, params = {}) {
    try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch { /* */ }
  }
  close() { try { this.child.kill(); } catch { /* */ } }
}

class HttpRpc {
  constructor(name, cfg) {
    this.name = name;
    this.url = cfg.url || cfg.endpoint;
    this.headers = { Accept: 'application/json, text/event-stream', ...(cfg.headers || {}) };
    this._id = 0;
    this.sessionId = null;
  }
  async request(method, params = {}, timeoutMs = 60000) {
    const id = ++this._id;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { ...this.headers, 'Content-Type': 'application/json' };
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      const res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      const type = res.headers.get('content-type') || '';
      let msg;
      if (type.includes('text/event-stream') && res.body) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          buf += dec.decode(value || new Uint8Array(), { stream: !done });
          const events = buf.split(/\r?\n\r?\n/);
          buf = events.pop() || '';
          for (const ev of events) {
            const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
            if (!data || data === '[DONE]') continue;
            try {
              const m = JSON.parse(data);
              if (m.id === id || m.id === String(id)) { await reader.cancel(); msg = m; break; }
            } catch { /* */ }
          }
          if (msg || done) break;
        }
      } else {
        msg = await res.json();
      }
      if (!msg) throw new Error(`mcp ${this.name} empty`);
      if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
      return msg.result;
    } finally { clearTimeout(timer); }
  }
  notify(method, params = {}) {
    const headers = { ...this.headers, 'Content-Type': 'application/json' };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    fetch(this.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method, params }) }).catch(() => {});
  }
  close() {}
}

async function connectMcp(servers, log = console.error) {
  const registry = new Map();
  const clients = [];
  for (const [name, cfg] of Object.entries(servers || {})) {
    const http = Boolean(cfg && (cfg.type === 'http' || cfg.transport === 'http' || cfg.url || cfg.endpoint));
    if (!cfg || (http ? !(cfg.url || cfg.endpoint) : !cfg.command)) {
      log(`mcp skip ${name}: missing ${http ? 'url' : 'command'}`);
      continue;
    }
    let client;
    try {
      client = http ? new HttpRpc(name, cfg) : new StdioRpc(name, cfg);
      await client.request('initialize', {
        protocolVersion: cfg.protocolVersion || '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'basic', version: '0.1.0' },
      });
      client.notify('notifications/initialized');
      const listed = await client.request('tools/list', {});
      for (const t of listed?.tools || []) {
        const q = (`mcp_${name}_${t.name}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        registry.set(q, { name: t.name, client, description: t.description || t.name, schema: t.inputSchema || { type: 'object' } });
      }
      clients.push(client);
      log(`mcp ${name}: ${(listed?.tools || []).length} tool(s)`);
    } catch (e) {
      client?.close();
      log(`mcp ${name} failed: ${e.message}`);
    }
  }
  return {
    listTools: () => [...registry.entries()].map(([n, e]) => ({
      name: n,
      description: e.description,
      parameters: e.schema,
    })),
    has: (n) => registry.has(n),
    async call(n, args) {
      const e = registry.get(n);
      if (!e) throw new Error(`unknown mcp tool ${n}`);
      const work = e.client.request('tools/call', { name: e.name, arguments: args || {} }, 120000);
      work.catch(() => {}); // a late result or timeout must not surface as unhandled
      // An MCP request cannot be cancelled in flight, so Ctrl+C stops waiting on
      // it instead; the tool keeps running server-side.
      const signal = activeExecution?.controller.signal;
      const res = signal ? await Promise.race([work, abortRace(signal)]) : await work;
      const text = (res?.content || []).map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
      return res?.isError ? `Error: ${text}` : (text || '(no content)');
    },
    closeAll() { for (const c of clients) c.close(); },
  };
}

/* ------------------------------ LLM + tools ------------------------------ */

function openaiTools() {
  const notes = MODE_NOTES[mode] || {};
  const list = Object.entries(BUILTIN).map(([name, t]) => ({
    type: 'function',
    // A description can be a function so it can name the current shell/mode.
    function: {
      name,
      description: (typeof t.description === 'function' ? t.description() : t.description) + (notes[name] ? notes[name]() : ''),
      parameters: t.parameters,
    },
  }));
  for (const t of mcp.listTools()) {
    list.push({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    });
  }
  return list;
}

function fmtTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * How full the context window would be for the request we are about to send.
 * Estimates are calibrated against the prompt_tokens servers report, so the
 * number tracks the real tokenizer instead of raw chars/4.
 */
function contextUsage(messages) {
  const used = estimatePromptTokens(messages);
  return { used, percent: Math.round((used / Math.max(1, contextSize)) * 100) };
}

/**
 * Switch compact mode on (or off again) from the size of the conversation, and
 * tell the user once per crossing. Compact mode is a stopgap: it trims what
 * each request carries (see optimizePrompt) so work can continue, but only
 * /compact actually frees the history.
 */
/**
 * Switch compact mode on (or off again) from the size of the conversation, and
 * tell the user once per crossing. Compact mode is the stopgap — it trims what
 * each request carries (see optimizePrompt) so the turn survives — while
 * maybeAutoCompact() does the real thing below.
 */
function noteContext(messages) {
  const { used, percent } = contextUsage(messages);
  if (percent < COMPACT_CLEAR_PERCENT) compactArmed = true; // room again: allow the next compaction
  compactMode = percent >= COMPACT_AT_PERCENT;
  if (!compactMode) { contextWarned = false; return; }
  if (contextWarned) return;
  contextWarned = true;
  if (autoCompact) return; // the compaction itself reports what it did
  const trimmed = estimatePromptTokens(optimizePrompt(messages));
  console.log(
    `\n${tag('context', s.yellow)} ~${fmtTokens(used)} of ${fmtTokens(contextSize)} tokens ` +
    `${s.bold(`(${percent}%)`)} — ${s.bold('compact mode on')}: older tool results and reasoning are ` +
    `trimmed from each request (this one ~${fmtTokens(trimmed)}). ` +
    `Please run ${s.cyan('/compact')} to summarize the conversation and free space for good.`
  );
}

/**
 * Compact *before* the request that would not fit. Waiting for the server to
 * refuse costs the turn: the request is already lost, and some providers bill
 * the attempt. So at COMPACT_AT_PERCENT the conversation is summarized here,
 * once per crossing (compactArmed), and the model carries on with a shorter
 * history instead of hitting the limit.
 */
async function maybeAutoCompact(messages) {
  if (!autoCompact) return;
  const { used, percent } = contextUsage(messages);
  if (percent < COMPACT_AT_PERCENT || !compactArmed) return;
  compactArmed = false; // rearmed once usage falls back below COMPACT_CLEAR_PERCENT
  const size = `\n${tag('context', s.yellow)} ~${fmtTokens(used)} of ${fmtTokens(contextSize)} tokens ${s.bold(`(${percent}%)`)}`;
  if (messages.length <= 2) {
    // One message cannot be summarized into less than itself: usually a long
    // plan arriving as the first message of the implement turn. Say what would
    // actually help instead of pretending to compact.
    console.log(`${size} — too big to summarize (the request is a single message). ${s.dim('It goes out trimmed; raise config contextSize, or write a shorter plan.')}`);
    return;
  }
  console.log(`${size} — ${s.bold('compacting automatically')} before the window runs out`);
  const freed = await compactHistory(messages);
  if (freed) { compactMode = false; contextWarned = false; return; }
  // Nothing freed (or the summary failed): fall back to trimming each request.
  console.log(
    `${tag('context', s.yellow)} that freed nothing — older tool results are trimmed from each request instead. ` +
    `${s.dim(`Run ${s.cyan('/compact')} yourself, or raise config contextSize.`)}`
  );
}

/** Older tool results are cut to this many characters in compact mode. */
const COMPACT_STUB_CHARS = 240;
/** Tool results of the latest step keep this much when the first pass is not enough. */
const COMPACT_RECENT_CHARS = 2000;

function trimToolResult(m, keep) {
  const text = String(m.content ?? '');
  if (text.length <= keep + 80) return m;
  return {
    ...m,
    content: `${text.slice(0, keep)}\n…[compact mode: ${text.length - keep} more chars of this tool result were trimmed from the request; re-run the tool if they matter]`,
  };
}

/**
 * The request to send when compact mode is on. The history itself is never
 * changed — only the copy that goes over the wire:
 *   1. Everything before the latest step (the last assistant message and its
 *      tool results) loses reasoning fields and has tool results cut to a stub.
 *      The system message and the first user message (the task) stay intact.
 *   2. If that is still over the line, the latest step's tool results are cut
 *      too, more generously, so the model keeps what it just asked for.
 */
function optimizePrompt(messages) {
  let latest = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { latest = i; break; }
  }
  const firstUser = messages.findIndex((m) => m.role === 'user');
  const pass1 = messages.map((m, i) => {
    if (i >= latest || m.role === 'system' || i === firstUser) return m;
    if (m.role === 'tool') return trimToolResult(m, COMPACT_STUB_CHARS);
    if (m.role === 'assistant' && (m.reasoning !== undefined || m.reasoning_content !== undefined)) {
      const { reasoning, reasoning_content, ...rest } = m; // eslint-disable-line no-unused-vars
      return rest;
    }
    return m;
  });
  if (contextUsage(pass1).percent < COMPACT_AT_PERCENT) return pass1;
  return pass1.map((m, i) => (i >= latest && m.role === 'tool' ? trimToolResult(m, COMPACT_RECENT_CHARS) : m));
}

// Keep labels on their own lines while writing tokens immediately.
// One colour per label, so a long transcript stays scannable: reasoning is
// dim, the answer is plain, tools are cyan (yellow when they change files).
// lib/ui.js turns every one of these into a no-op when colours are off.
const tag = (text, paint = s.bold) => paint(`[${text}]`);
const SECTIONS = {
  thinking: { tag: tag('thinking', s.magenta), text: s.dim },
  response: { tag: tag('response', s.green), text: (t) => t },
};
/** Tools that can change the project — the colour warns before the arguments scroll past. */
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'run_command']);
/** Tools that only look — labelled [read] in the console. */
const READ_TOOLS = new Set(['read_file', 'search_files', 'list_files']);

/* Compact tool display. The model always gets the full result (up to the
 * 20000-char cap); the console shows enough to follow along — a one-line
 * summary of the arguments, the first lines of the result and a count of what
 * was left out. /verbose shows everything. */
const ARGS_PREVIEW_CHARS = 200;
const ARG_VALUE_CHARS = 80;
const RESULT_PREVIEW_LINES = 8;
const RESULT_PREVIEW_COLS = 160;

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** `{"path":"a.js","content":"<first 40 chars>… (2345 chars, 61 lines)"}` */
function summarizeArgs(raw) {
  const text = raw || '{}';
  if (verbose) return text;
  let args;
  try { args = JSON.parse(text); } catch { return clip(text.replace(/\s*\n\s*/g, ' '), ARGS_PREVIEW_CHARS); }
  if (!args || typeof args !== 'object') return clip(text, ARGS_PREVIEW_CHARS);
  const compact = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v !== 'string' || v.length <= ARG_VALUE_CHARS) { compact[k] = v; continue; }
    const clean = normalizeEol(v); // CRLF counts and previews as LF
    const lines = clean.split('\n').length;
    compact[k] = `${clean.slice(0, 40).replace(/\n/g, '⏎')}… (${v.length} chars${lines > 1 ? `, ${lines} lines` : ''})`;
  }
  return clip(JSON.stringify(compact), ARGS_PREVIEW_CHARS);
}

/** First lines of a tool result, each clipped, plus how much was omitted. */
function previewResult(content, { truncatedFrom = 0 } = {}) {
  // Console only: shown as LF whatever the result carries (e.g. CRLF command
  // output on Windows) — the model still receives the original text.
  const text = normalizeEol(String(content));
  const note = truncatedFrom ? s.dim(`(result truncated to ${text.length} chars for the model, ${truncatedFrom} total)`) : '';
  if (verbose) return [text, note].filter(Boolean).join('\n');
  const lines = text.split('\n');
  const shown = lines.slice(0, RESULT_PREVIEW_LINES).map((l) => `  ${clip(l, RESULT_PREVIEW_COLS)}`);
  const more = lines.length - RESULT_PREVIEW_LINES;
  if (more > 0) shown.push(s.dim(`  … +${more} more lines (${text.length} chars; the model gets the full result, /verbose shows it)`));
  if (note) shown.push(`  ${note}`);
  return shown.join('\n');
}

function consoleStream() {
  let section = null;
  let newline = true;
  return {
    write(label, text) {
      if (!text) return;
      const style = SECTIONS[label];
      if (section !== label) {
        if (!newline) process.stdout.write('\n');
        process.stdout.write(`${style?.tag || tag(label)}\n`);
        section = label;
      }
      process.stdout.write(style?.text ? style.text(text) : text);
      newline = text.endsWith('\n');
    },
    end() { if (!newline) process.stdout.write('\n'); },
  };
}

// SSE frames and UTF-8 characters can both span network chunks.
async function* streamEvents(body) {
  if (!body) throw new Error('LLM returned an empty stream');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const dataOf = (event) => event.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const data = dataOf(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (data) yield data;
      }
      if (done) {
        const data = dataOf(buffer);
        if (data) yield data;
        break;
      }
    }
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

function llmError(payload, status = 500) {
  const body = typeof payload === 'string' ? payload : JSON.stringify({ error: payload });
  const error = new Error(`LLM error (${status}): ${serverErrorSummary(body)}`);
  error.kind = classifyApiError(status, body);
  // Kept so a caller can react to the class of failure (e.g. a full context
  // window: compact the conversation and send the request again).
  error.status = status;
  error.body = body;
  return error;
}

function invalidToolCall(reason) {
  const error = new Error(`Invalid or incomplete tool call: ${reason}. No tools from this reply were executed.`);
  error.kind = TOOL_CALL_PARSE_ERROR;
  return error;
}

// Validate the ENTIRE batch before adding history or executing any tools.
function validateToolCalls(msg) {
  for (const call of msg.tool_calls || []) {
    if (!call.id || !call.function?.name) throw invalidToolCall('missing id or name');
    let args;
    try { args = JSON.parse(call.function.arguments); }
    catch { throw invalidToolCall('arguments are not complete JSON'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw invalidToolCall('arguments must be a JSON object');
    }
  }
  return msg;
}

function toolCallRecovery(limit) {
  return `[tool call recovery] Your previous reply contained invalid or incomplete tool-call JSON and was discarded. No tools from that reply ran and no files were changed by it.
It may have exceeded the output budget. The next reply is limited to ${limit} tokens; keep the entire reply, including all arguments, well below ${Math.floor(limit * 2)} characters. Send only one small tool call per reply, then wait for its result.
For existing files, use targeted edit_file calls rather than rewriting the whole file. For a large new file, write_file only the first section; then append each section in a separate edit_file reply (old_text = unique ending lines, new_text = those lines plus the next section).
Return valid JSON with properly escaped strings and closing quotes/braces. Do not repeat the oversized call.`;
}

// waiting = the "still working" indicator to clear as soon as anything prints,
// so the spinner never fights the streamed text for the same terminal row.
// quiet = no streaming to the console (internal requests such as /compact).
/**
 * Why the last reply stopped ('stop', 'length', 'tool_calls', …), or null.
 * Module-level on purpose: the message object is sent back to the API, which
 * does not accept extra fields, so the finish reason travels beside it.
 */
let lastFinishReason = null;

async function readChatResponse(res, waiting, { quiet = false, sent = [] } = {}) {
  lastFinishReason = null;
  const output = quiet ? { write() {}, end() {} } : consoleStream();
  // Feed the server's own prompt_tokens back into the estimator when offered.
  const calibrate = (usage) => { if (usage?.prompt_tokens) calibrateTokens(sent, usage.prompt_tokens); };
  const show = (delta) => {
    const thinking = delta.reasoning_content || delta.reasoning || '';
    const content = delta.content || '';
    if (thinking || content) waiting.stop();
    // Only display reasoning explicitly supplied by the provider.
    output.write('thinking', thinking);
    output.write('response', content);
  };
  try {
    // Some OpenAI-compatible servers ignore stream: true and return JSON.
    if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
      const json = await res.json();
      waiting.stop();
      calibrate(json.usage);
      if (json.error) throw llmError(json.error);
      const msg = json.choices?.[0]?.message;
      if (!msg) throw new Error('LLM returned no message');
      show(msg);
      lastFinishReason = json.choices[0].finish_reason || null;
      if (json.choices[0].finish_reason === 'length' && msg.tool_calls?.length) {
        throw invalidToolCall('output token limit reached');
      }
      return validateToolCalls(msg);
    }
    const msg = { role: 'assistant', content: null };
    const calls = new Map();
    let finished = false;
    let finishReason = null;
    for await (const data of streamEvents(res.body)) {
      if (data.trim() === '[DONE]') { finished = true; break; }
      const chunk = JSON.parse(data);
      if (chunk.error) throw llmError(chunk.error);
      calibrate(chunk.usage);
      const choice = chunk.choices?.find((c) => c.index === 0 || c.index === undefined);
      if (!choice) continue; // e.g. usage-only chunks
      const delta = choice.delta || {};
      show(delta);
      for (const field of ['content', 'reasoning_content', 'reasoning']) {
        if (typeof delta[field] === 'string') msg[field] = (msg[field] || '') + delta[field];
      }
      for (const part of delta.tool_calls || []) {
        const index = part.index ?? 0;
        if (!calls.has(index)) calls.set(index, { id: '', type: 'function', function: { name: '', arguments: '' } });
        const call = calls.get(index);
        if (part.id) call.id += part.id;
        if (part.type) call.type = part.type;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
      }
      // Tool-call arguments stream silently; keep the indicator honest about it.
      if (calls.size && waiting.update) {
        const names = [...calls.values()].map((c) => c.function.name).filter(Boolean);
        waiting.update(`composing tool call${names.length > 1 ? 's' : ''} ${names.join(', ') || '…'}…`);
      }
      if (choice.finish_reason) { finished = true; finishReason = choice.finish_reason; }
    }
    lastFinishReason = finishReason;
    if ((!finished || finishReason === 'length') && calls.size) {
      throw invalidToolCall('stream ended before tool calls were complete');
    }
    if (!finished) throw new Error('LLM stream ended before completion');
    if (calls.size) {
      msg.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    }
    return validateToolCalls(msg);
  } finally {
    waiting.stop(); // e.g. error paths and replies with no visible text
    output.end();
  }
}

async function chat(messages, { tools = true, temperature = 0.2, replyLimit = maxTokens, quiet = false } = {}) {
  // Compact mode never edits the history, only what this request carries.
  const outbound = compactMode ? optimizePrompt(messages) : messages;
  if (outbound !== messages && !quiet) {
    const before = estimatePromptTokens(messages);
    const after = estimatePromptTokens(outbound);
    if (after < before) console.log(s.dim(`    · compact mode: request trimmed ~${fmtTokens(before)} → ~${fmtTokens(after)} tokens`));
  }
  const body = {
    model: OPENAI.model,
    messages: outbound,
    temperature,
    max_tokens: replyLimit,
    stream: true,
  };
  if (tools) {
    const t = openaiTools();
    if (t.length) body.tools = t;
  }
  // Shown from the moment the request goes out until the first token lands,
  // so a slow model never looks like a hung prompt.
  const waiting = quiet ? { stop() {} } : spinner('thinking…');
  // Ctrl+C aborts the request through the execution that owns this turn.
  const signal = activeExecution?.controller.signal;
  let res;
  try {
    res = await fetch(`${OPENAI.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(OPENAI.apiKey ? { Authorization: `Bearer ${OPENAI.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    waiting.stop();
    throw e;
  }
  if (!res.ok) {
    waiting.stop();
    throw llmError(await res.text(), res.status);
  }
  return await readChatResponse(res, waiting, { quiet, sent: outbound });
}

async function runTool(name, args) {
  if (BUILTIN[name]) return await BUILTIN[name].run(args || {});
  if (mcp.has(name)) return await mcp.call(name, args || {});
  throw new Error(`unknown tool ${name}`);
}

const rewriteSystem = () => `You are in REWRITE mode. You rewrite the user's raw request into a good prompt; you do not plan the implementation in detail and you do not implement anything.
Two directories, and they are never the same one:
- WORKSPACE (the project, what you are reading): ${workspace}
  Every relative path resolves against it (never against some other directory), results
  come back relative to it, and paths outside it are refused.
- PLAN DIRECTORY (where plans, refined prompts and working notes are stored): ${planDir}
  It is outside the workspace on purpose. Do not look for plan files in the workspace.
The project is READ-ONLY in this mode and the tools enforce it:
- write_file and edit_file refuse every path outside ${planDir}. Use that directory for working notes if you need them.
- run_command only runs read-only commands (${readOnlyCommandExamples(shellPlatform())}, …), and only
  ones this machine has: commands run through ${shellVia()}, so a command from the other OS is
  refused (on Windows use dir/type/findstr, on Linux/macOS use ls/cat/grep).
  Builds, installs and anything that writes files are refused.
Your job is to make the request precise enough that a planning agent cannot misread it:
- Preserve the user's intent, names, numbers, paths and wording where they carry meaning. Never invent a requirement the user did not imply, and never drop a constraint they did state.
- Inspect the workspace only where it makes the prompt more accurate, spending as few tokens as you can: search_files to find where something lives, list_files to see what is here, read_file with start_line/max_lines for the region you need. Refer to files, commands and tests that actually exist; when you could not verify one, say it is unverified rather than presenting a guess as a fact.
- Give the prompt a role suited to the task, and structure what remains as applicable: goal, context grounded in what you found, scope (and explicit non-goals), requirements, constraints, relevant files, edge cases to consider, and acceptance criteria with how the result will be verified.
- Ambiguity you cannot resolve from the workspace goes in an "Assumptions / open questions" line of the refined prompt — do not stop to ask, and do not silently pick a meaning the user may not intend.
- Write the refined prompt so it stands on its own: the reader gets only that prompt, not this conversation and not the user's original wording.
Do not write the implementation plan and do not write code — the ordered steps are the next phase's job.
When you have enough, output ONLY the refined prompt, wrapped exactly like this:

REFINED PROMPT
---
<the full refined prompt>
---

End the reply with that block: the user reviews it, and only the confirmed text goes on to PLAN mode. Nothing may follow the closing "---" — no summary, no questions, no offer to continue.
No other work.`;

const planSystem = () => `You are in PLAN mode. You analyse and plan; you do not implement anything.
Two directories, and they are never the same one:
- WORKSPACE (the project, what you are reading): ${workspace}
  Every relative path resolves against it (never against some other directory), results
  come back relative to it, and paths outside it are refused.
- PLAN DIRECTORY (where plans and working notes are stored): ${planDir}
  It is outside the workspace on purpose. Plan files are never part of the project: do not
  look for them in the workspace, do not search the workspace for "plan-*.md", and do not
  write notes there.
The project is READ-ONLY in this mode and the tools enforce it:
- write_file and edit_file refuse every path outside ${planDir}. Use that directory for working notes if you need them.
- run_command only runs read-only commands (${readOnlyCommandExamples(shellPlatform())}, …), and only
  ones this machine has: commands run through ${shellVia()}, so a command from the other OS is
  refused (on Windows use dir/type/findstr, on Linux/macOS use ls/cat/grep).
  Builds, installs and anything that writes files are refused.
Inspect the workspace until you understand the task, spending as few tokens as you can:
- search_files to find where something is (one call instead of reading ten files).
- list_files to see what is in a directory.
- read_file with start_line/max_lines for the region you need — never to skim a whole file.
- Prefer several narrow calls over one wide one; a big file you did not need costs the context.
The user describes a coding task. If anything important is missing, ask short questions.
When you have enough, output ONLY a prompt the implement agent will receive as its user message.
That prompt must contain: goal, files to touch, steps, constraints, how to verify.
Wrap it exactly like this:

IMPLEMENT PROMPT
---
<the full prompt>
---

End the reply with that block: it is saved to a plan file under ${planDir} (outside the workspace),
and IMPLEMENT mode runs from that file. Nothing may follow the closing "---" — no summary, no
questions, no offer to continue.
No other work.`;

/** One line at the end of a turn, so it is obvious the agent is idle again. */
function turnSummary(stats, startedAt) {
  const bits = [`${stats.steps} step${stats.steps === 1 ? '' : 's'}`];
  if (stats.calls) {
    const detail = [];
    if (stats.writes) detail.push(`${stats.writes} file write${stats.writes === 1 ? '' : 's'}`);
    if (stats.commands) detail.push(`${stats.commands} command${stats.commands === 1 ? '' : 's'}`);
    if (stats.blocked) detail.push(`${stats.blocked} blocked by ${stats.blockedBy || 'PLAN'} mode`);
    if (stats.failed) detail.push(`${stats.failed} failed`);
    bits.push(`${stats.calls} tool call${stats.calls === 1 ? '' : 's'}${detail.length ? ` (${detail.join(', ')})` : ''}`);
  }
  bits.push(fmtDuration(Date.now() - startedAt));
  return `${tag('done', s.green)} ${s.dim(bits.join(' · '))}`;
}

async function loop(messages, { tools = true } = {}) {
  let replyLimit = maxTokens;
  const startedAt = Date.now();
  const stats = { steps: 0, calls: 0, writes: 0, commands: 0, blocked: 0, failed: 0, blockedBy: readOnlyModeName() };
  // The turn registers itself, so Ctrl+C can abort its request and kill any
  // command a tool starts; endExecution() retires the handle either way.
  const execution = beginExecution();
  const aborted = () => execution.controller.signal.aborted;
  // Every reply the turn produced, in order — the plan can be written in one
  // reply and the turn can end (or be cut off) in a later one.
  const texts = [];
  try {
    // No step limit: the turn keeps going until the model replies without
    // tool calls — the task is finished — or Ctrl+C stops it. The context
    // window is not a limit either: maybeAutoCompact summarizes the
    // conversation as it fills, so however many steps a task takes, it runs.
    for (let step = 1; ; step++) {
      if (aborted()) break; // Ctrl+C between steps: do not start another one
      stats.steps = step;
      await maybeAutoCompact(messages); // free space before the request, not after the refusal
      noteContext(messages); // nudge before the request, never while a tool runs
      let msg;
      let recoveredContext = false; // one compaction per "window is full" error
      for (let retries = 0; ; retries++) {
        try {
          msg = await chat(messages, { tools, replyLimit });
          break;
        } catch (e) {
          if (aborted()) break; // interrupted: the turn ends here, without a retry
          if (e.kind !== TOOL_CALL_PARSE_ERROR) {
            // The window really is full: summarize the conversation and send
            // this same request again, once, instead of losing the turn.
            if (!recoveredContext && isContextLengthError(e.status, `${e.body ?? ''} ${e.message ?? ''}`)) {
              recoveredContext = true;
              console.log(
                `\n${tag('context', s.yellow)} the request did not fit (${e.message}) — ` +
                `${s.bold('compacting and sending it again')}`
              );
              await compactHistory(messages); // best effort: it says what it freed
              compactMode = true; // and this attempt goes out trimmed, once
              continue;
            }
            throw e;
          }
          if (retries >= MAX_TOOL_CALL_RETRIES) {
            throw new Error(`Tool call still invalid after ${MAX_TOOL_CALL_RETRIES} smaller-output retries. Stop and request smaller, targeted edits; check the server output limit and config maxTokens. ${e.message}`);
          }
          replyLimit = smallerReplyTokenLimit(replyLimit);
          console.error(`${tag(`retry ${retries + 1}/${MAX_TOOL_CALL_RETRIES}`, s.yellow)} ${e.message}\n${s.dim(`Requesting one smaller tool call (max ${replyLimit} tokens); no tools from the rejected reply ran.`)}`);
          messages.push({ role: 'user', content: toolCallRecovery(replyLimit) });
        }
      }
      if (aborted()) break; // a reply cut short by Ctrl+C never enters the history
      messages.push(msg);
      noteContext(messages); // the reply itself can be what pushed us over the line
      // A reply can carry prose and a tool call at once: the plan may be in it.
      if (msg.content) texts.push(msg.content);
      const calls = msg.tool_calls || [];
      if (!calls.length) {
        const text = msg.content || '';
        // A reply cut off by the reply-token limit can end mid-plan; say so,
        // because the rest of the turn works from whatever arrived.
        if (lastFinishReason === 'length') {
          console.log(
            `\n${tag('truncated', s.yellow)} the reply hit the ${fmtTokens(replyLimit)} reply-token limit and stopped mid-sentence` +
            `${s.dim(' — raise config maxTokens, or ask for a shorter plan')}`
          );
        }
        console.log(turnSummary(stats, startedAt));
        // The reply may have been what tipped the conversation over: clean up
        // now, so the transcript reports it and the next turn starts small.
        await maybeAutoCompact(messages);
        return { text, texts, stats };
      }
      for (const [k, c] of calls.entries()) {
        const name = c.function.name;
        const mutating = MUTATING_TOOLS.has(name);
        const paint = mutating ? s.yellow : s.cyan;
        // Header: what is about to run, how far along the turn is, compact arguments.
        console.log(
          `\n${paint('⚙')} ${tag(READ_TOOLS.has(name) ? 'read' : 'tool', paint)} ${s.bold(name)} ` +
          `${s.dim(`· step ${step} · call ${k + 1}/${calls.length}${isReadOnlyMode() && mutating ? ` · ${mode} mode: project read-only` : ''}`)}\n` +
          `  ${s.dim(summarizeArgs(c.function.arguments))}`
        );
        const running = spinner(`running ${name}…`);
        let result;
        try {
          // Every call in the batch still gets a result, so the history never
          // keeps an assistant tool_calls message with missing answers; a call
          // an interrupt stopped before it ran simply answers with an error.
          if (aborted()) throw abortError();
          const args = JSON.parse(c.function.arguments || '{}');
          result = await runTool(name, args);
        } catch (e) { result = `error: ${e.message}`; }
        finally { running.stop(); }
        const full = String(result);
        const content = full.slice(0, 20000);
        const failed = content.startsWith('error:');
        const blocked = failed && content.includes(READ_ONLY_MARKER);
        stats.calls++;
        if (blocked) stats.blocked++;
        else if (failed) stats.failed++;
        else if (name === 'run_command') stats.commands++;
        else if (mutating) stats.writes++;
        const lines = content ? normalizeEol(content).split('\n').length : 0;
        const mark = blocked ? s.yellow('⊘') : failed ? s.red('✗') : s.green('✓');
        const status = blocked ? 'blocked' : failed ? 'failed' : 'ok';
        console.log(
          `${mark} ${tag('tool result', failed ? s.red : s.green)} ${s.bold(name)} ` +
          `${s.dim(`· ${status} · ${fmtDuration(running.elapsedMs())} · ${lines} line${lines === 1 ? '' : 's'}`)}\n` +
          previewResult(content, { truncatedFrom: full.length > content.length ? full.length : 0 })
        );
        messages.push({ role: 'tool', tool_call_id: c.id, content });
      }
      if (aborted()) break; // the interrupt already stopped this batch: end the turn
    }
    // The loop has no other way out: a reply without tool calls returned in
    // place above, so reaching here means Ctrl+C stopped the turn.
    console.log(`\n${tag('interrupt', s.yellow)} ${s.dim('turn stopped — history is intact')}`);
    console.log(turnSummary(stats, startedAt));
    return { text: '(stopped: interrupted)', texts, stats };
  } finally {
    endExecution(execution);
  }
}

const COMPACT_PROMPT = `[compaction request]
Summarize this session so work can continue without the earlier messages.
Include:
- The user's current request (verbatim if it is short).
- Every file inspected or changed, and what changed.
- Commands run and their results, especially failures.
- Decisions, constraints, and anything still pending.
Be concise and factual, short bullet points, no preamble. Do not call tools.`;

const COMPACT_SUMMARY_PREFIX =
  'Earlier in this session (compacted summary — the raw messages were dropped to free context):';

/** The newest messages a compaction keeps verbatim may take this share of the window. */
const COMPACT_TAIL_SHARE = 0.2;
/** Rough characters per token, for the tail budget (the estimator is calibrated, this is a cap). */
const CHARS_PER_TOKEN = 4;

/**
 * Trailing messages that can be replayed verbatim after a compaction. Never
 * orphans an assistant tool_calls message from its tool results, and stops at
 * the budget: a last reply that alone fills the window is the thing a
 * compaction has to get rid of — the summary says what it said.
 */
function compactTail(messages, keep = 2, budgetChars = Infinity) {
  const tail = [];
  let size = 0;
  for (let i = messages.length - 1; i >= 0 && tail.length < keep; i--) {
    const m = messages[i];
    if (m.role === 'tool' || (m.role === 'assistant' && m.tool_calls)) break;
    const len = String(m.content ?? '').length;
    if (size + len > budgetChars) break;
    size += len;
    tail.unshift(m);
  }
  return tail;
}

/**
 * Replace a conversation with a model-written summary plus the freshest
 * messages. Mutates history in place; returns token counts, or null when
 * nothing was freed (the caller keeps the original messages).
 */
async function compactHistory(history) {
  if (history.length <= 2) {
    console.log(s.dim('nothing to compact yet — the conversation is still empty'));
    return null;
  }
  const before = estimatePromptTokens(history);
  const [systemMsg, ...rest] = history;
  const tail = compactTail(rest, 2, Math.round(contextSize * COMPACT_TAIL_SHARE * CHARS_PER_TOKEN));
  // A compaction is a request of its own and Ctrl+C stops it. Run inside a turn
  // (auto-compaction) it joins that turn's execution instead of replacing it —
  // otherwise ending it would retire the running turn's interrupt handler.
  const outer = activeExecution;
  const execution = outer || beginExecution();
  const spin = spinner('compacting conversation…');
  let summary = '';
  try {
    const msg = await chat([...history, { role: 'user', content: COMPACT_PROMPT }], { tools: false, quiet: true });
    summary = String(msg.content || '').trim();
  } catch (e) {
    spin.stop();
    if (execution.controller.signal.aborted) {
      console.log(`${tag('compact', s.yellow)} compaction interrupted — history kept as is`);
      return null;
    }
    console.log(`${tag('compact', s.red)} compaction failed: ${e.message} — history kept as is`);
    return null;
  } finally {
    if (!outer) endExecution(execution);
  }
  spin.stop();
  if (!summary) {
    console.log(s.dim('compaction produced an empty summary — history kept as is'));
    return null;
  }
  const rebuilt = [systemMsg, { role: 'user', content: `${COMPACT_SUMMARY_PREFIX}\n${summary}` }, ...tail];
  const after = estimatePromptTokens(rebuilt);
  if (after >= before) {
    console.log(s.dim(`compacting would not free anything (${fmtTokens(before)} → ${fmtTokens(after)}) — history kept as is`));
    return null;
  }
  history.length = 0;
  history.push(...rebuilt);
  contextWarned = false;
  compactMode = false; // noteContext re-evaluates before the next request
  // Reported here, not by the caller: an automatic compaction has to say what
  // it did too, and /compact is just one way to start one.
  console.log(`${tag('compact', s.cyan)} conversation: ${fmtTokens(before)} → ${fmtTokens(after)} tokens`);
  return { before, after };
}

/* ------------------------------- plan files ------------------------------ */

/* PLAN mode's deliverable is persisted outside the project: the IMPLEMENT
 * PROMPT goes to a timestamped file under planDir, and IMPLEMENT mode reads
 * its brief from that file. The project itself is untouched until then. */

/**
 * Save the IMPLEMENT PROMPT as a plan file. When the plan grew out of a
 * confirmed rewrite, the file opens with that refined prompt (and the raw
 * request it came from, marked as superseded), so the brief IMPLEMENT mode
 * runs from carries the shaped task as well as the plan written for it —
 * no separate refined-prompt file to keep in step with the plan.
 */
function savePlan(prompt, { refined = '', original = '' } = {}) {
  fs.mkdirSync(planDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let file = path.join(planDir, `plan-${stamp}.md`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(planDir, `plan-${stamp}-${n}.md`);
  const head = String(refined || '').trim()
    ? `# Refined prompt\n\n${String(refined).trim()}\n\n` +
      (String(original || '').trim() ? `# Original request (superseded by the refined prompt above)\n\n${String(original).trim()}\n\n` : '') +
      `# Implement prompt\n\n`
    : '';
  fs.writeFileSync(file, applyEol(`${head}${String(prompt).trim()}\n`, eolFor(null)), 'utf8');
  rememberPlan(file);
  return file;
}

/* ---------------------------- the plan index ---------------------------- */

/*
 * Plans live in planDir, which is deliberately outside the workspace: the
 * project stays untouched until IMPLEMENT mode, and "is plan.md part of the
 * project?" never has to be asked. Two things make that directory usable
 * across sessions — the last plan is remembered by name (so a reopened console
 * can pick the work up), and every plan can be listed.
 */

const PLAN_FILE_RE = /^plan-.+\.md$/;
const LAST_PLAN_FILE = 'last-plan.json';

const lastPlanIndexPath = () => path.join(planDir, LAST_PLAN_FILE);

/** Saved plans, newest first. */
function listPlans() {
  if (!fs.existsSync(planDir)) return [];
  return fs.readdirSync(planDir)
    .filter((name) => PLAN_FILE_RE.test(name))
    .map((name) => {
      const file = path.join(planDir, name);
      let mtime = 0;
      let lines = 0;
      let first = '';
      try {
        mtime = fs.statSync(file).mtimeMs;
        const text = fs.readFileSync(file, 'utf8');
        const all = normalizeEol(text).split('\n').filter((l) => l.trim());
        lines = all.length;
        // A plan saved from a rewrite opens with a "# Refined prompt" section
        // heading; the listing should preview the prompt itself, not the heading.
        first = (all.find((l) => !/^#\s+(refined prompt|original request\b.*|implement prompt)\s*$/i.test(l.trim())) || all[0] || '').trim();
      } catch { /* unreadable plan: listed with what we have */ }
      return { file, name, mtime, lines, first };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** Point the directory at `file`, so the next session can resume from it. */
function rememberPlan(file) {
  try {
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(lastPlanIndexPath(), `${JSON.stringify({ file, savedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  } catch { /* a missing plan index only costs the resume hint */ }
}

/** The plan the previous session left behind, when the file is still there. */
function loadLastPlan() {
  try {
    const data = JSON.parse(fs.readFileSync(lastPlanIndexPath(), 'utf8'));
    const file = String(data?.file || '');
    return file && fs.existsSync(file) ? file : null;
  } catch {
    // Older sessions kept no index: fall back to the newest plan file.
    return listPlans()[0]?.file || null;
  }
}

/** "3 minutes ago" — plans are picked by age more easily than by timestamp. */
function ago(ms) {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return `${Math.round(secs / 86400)} d ago`;
}

function readPlan(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) throw new Error(`plan file ${file} is empty`);
  return text;
}

/** The whole user message for IMPLEMENT mode: the saved plan, and where it lives. */
function implementPrompt(file) {
  return `IMPLEMENT mode. The plan below was written in PLAN mode and saved at ${file} — outside the workspace ` +
    `(${workspace}), which is where plan files belong. It is your complete brief. ` +
    'Carry it out now — project files may be read and modified in this mode. Re-read that file if the plan drops out of context.\n\n' +
    readPlan(file);
}

async function planTurn(history, userText, rewriteContext = null) {
  mode = 'plan';
  history.push({ role: 'user', content: userText });
  const { text, texts } = await loop(history, { tools: true });
  // Look at the whole turn, not just its last reply: a plan written before
  // another tool call, or before Ctrl+C stopped the turn, still counts.
  const prompt = extractImplementPrompt(texts.length ? texts : [text]);
  const planFile = prompt ? savePlan(prompt, rewriteContext || {}) : null;
  return { text, prompt, planFile, interrupted }; // interrupted: Ctrl+C stopped the turn
}

/**
 * One REWRITE turn over its own throwaway history: the raw request (plus any
 * revision feedback the confirmation gate collected) goes in, the REFINED
 * PROMPT block comes out. The history is returned with the result so the
 * gate can ask for a revision in context; it is never merged into the plan
 * history — only the confirmed refined text crosses over.
 */
async function rewriteTurn(rawText, existingHistory = null) {
  mode = 'rewrite';
  const history = existingHistory || [
    { role: 'system', content: rewriteSystem() },
    { role: 'user', content: String(rawText ?? '') },
  ];
  try {
    const { text, texts } = await loop(history, { tools: true });
    const refined = extractRefinedPrompt(texts.length ? texts : [text]);
    return { text, refined, history, interrupted }; // interrupted: Ctrl+C stopped the turn
  } finally {
    mode = 'plan';
  }
}

async function implementTurn(planFile) {
  // The plan file is the user prompt. No system message.
  const history = [{ role: 'user', content: implementPrompt(planFile) }];
  mode = 'implement';
  try {
    return await loop(history, { tools: true });
  } finally {
    mode = 'plan';
  }
}

/* --------------------------------- CLI --------------------------------- */

function loadConfig(p) {
  if (!p || !fs.existsSync(p)) return;
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (cfg.openai) Object.assign(OPENAI, cfg.openai);
  if (cfg.workspace) workspace = path.resolve(cfg.workspace);
  if (cfg.maxTokens !== undefined) {
    if (!Number.isInteger(cfg.maxTokens) || cfg.maxTokens < 256) {
      throw new Error('config maxTokens must be an integer >= 256');
    }
    maxTokens = cfg.maxTokens;
  }
  if (cfg.contextSize !== undefined) {
    if (!Number.isInteger(cfg.contextSize) || cfg.contextSize < 2000) {
      throw new Error('config contextSize must be an integer >= 2000');
    }
    contextSize = cfg.contextSize;
  }
  if (cfg.planDir !== undefined) {
    if (typeof cfg.planDir !== 'string' || !cfg.planDir.trim()) throw new Error('config planDir must be a non-empty string');
    planDir = path.resolve(cfg.planDir);
  }
  if (cfg.planAllowCommands !== undefined) {
    if (!Array.isArray(cfg.planAllowCommands)) throw new Error('config planAllowCommands must be an array of strings');
    planAllowCommands = cfg.planAllowCommands.map(String);
  }
  if (cfg.shell !== undefined) {
    if (typeof cfg.shell !== 'string' || !cfg.shell.trim()) throw new Error('config shell must be a non-empty string');
    shellConfig = cfg.shell.trim();
  }
  if (cfg.autoCompact !== undefined) {
    if (typeof cfg.autoCompact !== 'boolean') throw new Error('config autoCompact must be true or false');
    autoCompact = cfg.autoCompact;
  }
  if (cfg.rewrite !== undefined) {
    if (typeof cfg.rewrite !== 'boolean') throw new Error('config rewrite must be true or false');
    rewriteEnabled = cfg.rewrite;
  }
  if (cfg.lineEndings !== undefined) {
    if (typeof cfg.lineEndings !== 'string' || !cfg.lineEndings.trim()) throw new Error('config lineEndings must be a non-empty string');
    lineEndings = LINE_ENDING_ALIASES[cfg.lineEndings.trim().toLowerCase()] || 'auto'; // unknown styles fall back to auto
  }
  return cfg;
}

function parseArgs(argv) {
  const o = { once: null, config: process.env.BASIC_CONFIG || null, dir: null, help: false, rewrite: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') o.once = argv[++i];
    else if (a === '--config' || a === '-c') o.config = argv[++i];
    else if (a === '--dir' || a === '-d') o.dir = argv[++i];
    else if (a === '--rewrite') o.rewrite = true;
    else if (a === '--no-rewrite') o.rewrite = false;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const HELP = `basic.mjs — rewrite (if enabled), then plan, then implement.

  node basic.mjs [--config file] [--dir path] [--rewrite|--no-rewrite]
  node basic.mjs --once "task"

  /rewrite [task]     rewrite mode: shape a raw request into a good prompt before
                      planning. With a task: run it once now (even when rewrite is
                      off). With on/off: switch it on or off for this session.
                      With nothing: show whether it is on. While a refined prompt
                      waits for confirmation: blank line, y or /accept plans with
                      it, /use-raw plans the original, /cancel drops it, and any
                      other text is revision feedback that rewrites it again.
  /plan [text]        plan mode (default). extra text is context. When rewrite is
                      on, the text is rewritten and confirmed first.
  /implement [target] run a plan. No target: the last plan of this session, or the
                      one the previous session left behind (plans survive a restart).
                      A number: that entry from /plans. A path: that plan file.
                      Anything else: those words become an ad-hoc plan.
  /plans              list the saved plan files, newest first
  /prompt             print the plan /implement would run and its path
  /compact            summarize the conversation to free context
  /reset              clear the conversation (same session, fresh context)
  /verbose            toggle full tool arguments/results (default: compact preview)
  /tools              list tools
  /quit

Ctrl+C stops the running execution — the model request and any command a tool
started — and returns to the prompt with the history intact. Pressing it again
within two seconds, or while the agent is idle, exits.
/reset drops the whole conversation (the system prompt is rebuilt and the plan
pointer is forgotten; the saved plan file stays on disk), so the next request
starts from an empty context.

Everything goes through plan, then implement — through rewrite first when it
is switched on. REWRITE mode is opt-in and read-only exactly like PLAN: config
rewrite: true (BASIC_REWRITE=1, --rewrite, /rewrite on; --no-rewrite and
/rewrite off switch it back off) makes every new task be rewritten before it
is planned, and /rewrite <task> runs the phase once when it is off. The model
may inspect the project with the read-only tools so the refined prompt names
real files and commands, ends with a REFINED PROMPT block (also read
tolerantly), and — interactively — that text waits for you: a blank line, y or
/accept sends it to PLAN mode, any other text rewrites it again with that as
feedback, /use-raw plans your original words instead, and /cancel drops it.
--once cannot ask, so a rewritten --once task continues on its own. A plan
that came from a confirmed rewrite saves its plan file with the refined
prompt as the opening section (the original request follows, marked
superseded), so /prompt and IMPLEMENT mode both see what was actually asked.
PLAN mode is analysis only — the project is read-only. write_file/edit_file
refuse every project path (only the plan directory is writable, and nothing
outside the workspace is touched at all) and run_command only runs read-only
commands (${readOnlyCommandExamples()}, …) that exist on this OS (${shellVia()}).
When the plan is ready the IMPLEMENT PROMPT is saved to a plan file under the plan
directory (config planDir, default <os tmp>/basic-plans); the block is read
tolerantly, but if a reply never writes one the turn says so instead of leaving
/implement with nothing to run. IMPLEMENT mode is the only mode that changes
project files; its user prompt is that plan file.
Paths are relative to the workspace (--dir, or config workspace, default: the
current directory). A tool path outside the workspace is refused — the plan
directory excepted — and tool results print workspace-relative paths, falling
back to the full path only for files outside it.
Workspace and plan directory are separate places and stay that way: plans are
written under the plan directory (config planDir, default <os tmp>/basic-plans),
which is outside the workspace, so plan files are never part of the project. A
planDir configured inside the workspace is moved out with a notice.
Responses stream live. Console labels: [response], [thinking] (when supplied by
the API), ⚙ [read]/[tool] with a step/call counter and a one-line argument
summary, then ✓/✗/⊘ [tool result] with status, duration and the first lines of
the result (the model always gets the full result, up to 20000 chars).
[done] closes every turn with step/tool counts and elapsed time.
Labels are coloured on a terminal — [thinking] is dim, reads are cyan, tools that
can change files are yellow, failed tool results are red. NO_COLOR turns this
off; FORCE_COLOR=1 turns it on for piped output too.
While work is in progress a live line (thinking…, composing tool call <name>…,
running <tool>…) shows elapsed time; it is erased when the next output starts.
Config maxTokens sets the reply budget (default 4096, minimum 256).
Config contextSize sets the model's context window (default 64000, minimum 2000).
The conversation is measured before every request. Once it is estimated at 90%
of contextSize it is compacted automatically — the model summarizes it and the
originals are dropped — so a turn is not lost to "context length exceeded"
(config autoCompact: false turns that off and only trims each request). If a
request is refused for being too long anyway, the same thing happens once and
the request goes out again. /compact does it on demand.
Reading costs tokens, so: search_files finds code without opening files,
list_files maps a directory, and read_file reads a window (200 lines by
default) — the model is told to use them instead of reading whole files.
Invalid tool-call JSON is retried up to 3 times with smaller-call instructions.
A turn has no step limit: it keeps stepping until the model replies without
tool calls (the task is done) or Ctrl+C stops it — auto-compaction keeps a
long turn inside the context window, so neither budget cuts a task off.
Files keep their own line endings: they are matched and shown as LF and
written back as CRLF, CR or LF exactly as found, never mixed and never
silently converted (a new file gets the OS style). Config lineEndings
("auto" | "lf" | "crlf" | "cr" | "native") can force a style for writes.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
  const cfg = loadConfig(opts.config);
  if (opts.rewrite !== null) rewriteEnabled = opts.rewrite; // --rewrite/--no-rewrite beats the config
  if (opts.dir) workspace = path.resolve(opts.dir);
  separatePlanDir(); // plans live outside the project, or the two get confused
  mcp = await connectMcp(cfg?.mcp?.servers);

  const planHistory = [{ role: 'system', content: planSystem() }];
  // Plans survive the console: the last one is picked up, so a reopened session
  // can carry on with /implement instead of planning the same task again.
  let lastPlanFile = loadLastPlan();

  const savedNote = (file) => `\n${s.green('saved plan')} → ${file} — ${s.dim('/implement to run it')}`;
  /** The plan `/implement n` means, or null when `n` is not one of them. */
  const planByIndex = (n) => listPlans()[n - 1]?.file || null;
  /** One line per saved plan: index, age, size, and what it is about. */
  const printPlans = () => {
    const plans = listPlans();
    if (!plans.length) {
      console.log(s.dim(`no saved plans in ${planDir} yet — a PLAN turn that ends with the IMPLEMENT PROMPT block writes one`));
      return;
    }
    console.log(`${s.dim(`plan directory (outside the workspace): ${planDir}`)}`);
    for (const [i, p] of plans.entries()) {
      const head = p.first ? s.dim(` — ${p.first.slice(0, 90)}`) : '';
      console.log(`  ${s.cyan(String(i + 1))}. ${path.basename(p.file)}  ${s.dim(`${ago(p.mtime)} · ${p.lines} line${p.lines === 1 ? '' : 's'}`)}${head}`);
    }
    console.log(s.dim(`  /implement <number> runs one, /prompt shows the current plan`));
  };
  /** Printed when a PLAN turn ended without a plan, so the silence is explained. */
  const noPlanNote = () => console.log(
    s.dim('no IMPLEMENT PROMPT block in that reply — ask again in /plan, or run ') +
    s.cyan('/implement <instructions>') + s.dim(' to hand the work over directly')
  );
  /** After a plan turn: remember the plan file, or say why there is none. */
  const finishPlanTurn = async (history, userText, rewriteContext = null) => {
    const { planFile } = await planTurn(history, userText, rewriteContext);
    if (!planFile) { noPlanNote(); return null; }
    lastPlanFile = planFile;
    console.log(savedNote(planFile));
    return planFile;
  };

  /* A refined prompt waiting at the confirmation gate, or null. Holds the
   * rewrite history so revision feedback can be applied in context; only the
   * confirmed text (or, with /use-raw, the original) reaches planHistory. */
  let pendingRewrite = null;

  const showRefined = (pending) => {
    console.log(`\n${tag('refined', s.cyan)} ${s.dim('this — and only this — is what PLAN mode receives if you confirm it')}`);
    console.log(pending.refined);
    console.log(s.dim('  blank line, y or /accept: plan with it · type feedback: rewrite it again · /use-raw: plan the original · n or /cancel: drop it'));
  };

  /** Run REWRITE mode for `rawText` and park the result at the confirmation gate. */
  const startRewriteTask = async (rawText) => {
    console.log(`${tag('rewrite', s.cyan)} ${s.dim('project read-only · refining the request before planning')}`);
    const result = await rewriteTurn(rawText);
    if (result.interrupted) {
      console.log(s.dim('rewrite stopped — nothing is waiting for confirmation'));
      return null;
    }
    if (!result.refined) {
      console.log(
        s.dim('no REFINED PROMPT block in that reply — nothing was planned. Run ') +
        s.cyan('/rewrite <task>') + s.dim(' again, or plan the words as written with rewrite off')
      );
      return null;
    }
    pendingRewrite = { original: String(rawText), refined: result.refined, history: result.history };
    showRefined(pendingRewrite);
    return pendingRewrite;
  };

  /** Leave the gate: plan with the refined text, or with the original on /use-raw. */
  const acceptRewrite = async (pending, { useRaw = false } = {}) => {
    pendingRewrite = null;
    if (useRaw) {
      console.log(`${tag('plan', s.magenta)} ${s.dim('planning your original words — the refined prompt was set aside')}`);
      await finishPlanTurn(planHistory, pending.original);
      return;
    }
    console.log(`${tag('plan', s.magenta)} ${s.dim('planning the confirmed refined prompt')}`);
    await finishPlanTurn(planHistory, pending.refined, { refined: pending.refined, original: pending.original });
  };

  /** Feedback at the gate is a revision request, not a new task. */
  const reviseRewrite = async (pending, feedback) => {
    console.log(`${tag('rewrite', s.cyan)} ${s.dim('revising the refined prompt with your feedback')}`);
    pending.history.push({
      role: 'user',
      content: `The user has not confirmed the refined prompt yet. Revise it using this feedback, keeping everything they did not object to:\n\n${feedback}\n\nOutput only the updated REFINED PROMPT block.`,
    });
    const result = await rewriteTurn('', pending.history);
    if (result.interrupted) {
      console.log(s.dim('revision stopped — the previous refined prompt is still waiting'));
      showRefined(pending);
      return;
    }
    if (!result.refined) {
      console.log(s.dim('that revision produced no REFINED PROMPT block — the previous refined prompt is still waiting'));
      showRefined(pending);
      return;
    }
    pending.refined = result.refined;
    pending.history = result.history;
    showRefined(pending);
  };

  async function handle(line) {
    const t = line.trim();
    // The confirmation gate owns the keyboard until the refined prompt is
    // accepted, revised, replaced by the original, or dropped — planning
    // never starts from text the user has not seen.
    if (pendingRewrite) {
      if (t === '' || t === '/accept' || t === '/plan' || /^(y|yes)$/i.test(t)) {
        await acceptRewrite(pendingRewrite);
        return;
      }
      if (t === '/cancel' || t === '/reject' || /^(cancel|reject|n|no)$/i.test(t)) {
        pendingRewrite = null;
        console.log(`${tag('rewrite', s.yellow)} ${s.dim('refined prompt dropped — nothing was planned')}`);
        return;
      }
      if (t === '/use-raw') {
        await acceptRewrite(pendingRewrite, { useRaw: true });
        return;
      }
      if (t === '/quit' || t === '/exit') process.exit(0);
      if (t.startsWith('/')) {
        console.log(s.dim('a refined prompt is waiting for confirmation — blank line, y or /accept plans with it, /use-raw plans the original, /cancel drops it, and plain text (no slash) revises it'));
        return;
      }
      await reviseRewrite(pendingRewrite, t);
      return;
    }
    if (!t) return;
    if (t === '/quit' || t === '/exit') process.exit(0);
    if (t === '/help') { console.log(HELP); return; }
    if (t === '/tools') {
      console.log(openaiTools().map((x) => x.function.name).join(', '));
      return;
    }
    if (t === '/verbose') {
      verbose = !verbose;
      console.log(s.dim(`tool output: ${verbose ? 'verbose (full arguments and results)' : 'compact preview'}`));
      return;
    }
    if (t === '/plans' || t === '/plan list') {
      printPlans();
      return;
    }
    if (t === '/prompt') {
      if (!lastPlanFile) {
        console.log(s.dim('(no plan saved yet)'));
        console.log(s.dim(`  a PLAN reply that ends with the IMPLEMENT PROMPT block saves one under ${planDir}`));
        return;
      }
      console.log(`${s.dim(`plan file: ${lastPlanFile}`)}\n${readPlan(lastPlanFile)}`);
      return;
    }
    if (t === '/compact') {
      await compactHistory(planHistory); // it reports what it freed (or why not)
      return;
    }
    if (t === '/reset') {
      // Fresh context in the same session: the system prompt is rebuilt and the
      // whole history is dropped. The plan pointer goes too (a fresh context
      // implies a fresh plan) — the saved plan file itself stays on disk.
      const dropped = planHistory.length - 1;
      planHistory.length = 0;
      planHistory.push({ role: 'system', content: planSystem() });
      contextWarned = false; // the new history decides whether compact mode is on
      compactMode = false;
      lastPlanFile = null;
      pendingRewrite = null; // a refined prompt from the old context goes with it
      console.log(
        `${tag('reset', s.cyan)} conversation cleared — ${dropped} message${dropped === 1 ? '' : 's'} dropped. ` +
        `${s.dim('The next request starts fresh.')}`
      );
      return;
    }
    if (t === '/rewrite' || t.startsWith('/rewrite ')) {
      const rest = t.slice(8).trim();
      if (!rest) {
        console.log(
          `${tag('rewrite', s.cyan)} rewrite is ${s.bold(rewriteEnabled ? 'on' : 'off')} ` +
          s.dim(rewriteEnabled
            ? '— every new task is refined and confirmed before planning. /rewrite off switches it off; /rewrite <task> refines one task now.'
            : '— /rewrite <task> refines one task now; /rewrite on (or config rewrite: true) refines every task before planning.')
        );
        return;
      }
      if (/^(on|true|yes)$/i.test(rest)) {
        rewriteEnabled = true;
        console.log(`${tag('rewrite', s.cyan)} ${s.dim('on — new tasks are refined and confirmed before planning')}`);
        return;
      }
      if (/^(off|false|no)$/i.test(rest)) {
        rewriteEnabled = false;
        console.log(`${tag('rewrite', s.cyan)} ${s.dim('off — new tasks go straight to planning')}`);
        return;
      }
      await startRewriteTask(rest);
      return;
    }
    if (t === '/plan' || t.startsWith('/plan ')) {
      mode = 'plan';
      const rest = t.slice(5).trim();
      if (!rest) {
        console.log(`${tag('plan', s.magenta)} ${s.dim(`project read-only · plans go to ${planDir}`)}`);
        return;
      }
      if (rewriteEnabled) { await startRewriteTask(rest); return; }
      console.log(`${tag('plan', s.magenta)} ${s.dim(`project read-only · plans go to ${planDir}`)}`);
      await finishPlanTurn(planHistory, rest);
      return;
    }
    if (t === '/implement' || t.startsWith('/implement ')) {
      const extra = t.slice(10).trim();
      let planFile = lastPlanFile;
      if (/^\d+$/.test(extra)) {
        // /implement 2 — the second plan in /plans, newest first.
        planFile = planByIndex(Number(extra));
        if (!planFile) {
          console.log(s.dim(`no plan #${extra} — /plans lists the saved ones`));
          return;
        }
      } else if (extra) {
        // A path to an existing plan file, or ad-hoc text that becomes one.
        const candidate = resolvePath(extra);
        planFile = fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : savePlan(extra);
      }
      if (!planFile) {
        console.log(s.dim('no plan saved yet — stay in /plan'));
        console.log(
          s.dim('  (the last PLAN reply had no IMPLEMENT PROMPT block. ') +
          s.cyan('/implement <instructions>') + s.dim(' runs text directly, ') +
          s.cyan('/implement <file>') + s.dim(' runs a saved plan file)')
        );
        return;
      }
      if (!fs.existsSync(planFile)) {
        console.log(s.red(`plan file is gone: ${planFile}`) + s.dim(' — plan again, or pass another plan file'));
        return;
      }
      lastPlanFile = planFile;
      rememberPlan(planFile); // a restart resumes from the plan that ran last
      console.log(`${tag('implement', s.cyan)} ${s.dim(`plan: ${planFile}`)}`);
      await implementTurn(planFile);
      console.log(`${tag('plan', s.magenta)} ${s.dim('back to plan — project read-only again')}`);
      return;
    }
    if (mode === 'plan') {
      if (rewriteEnabled) { await startRewriteTask(t); return; }
      await finishPlanTurn(planHistory, t);
    }
  }

  if (opts.once) {
    // --once has no keyboard to confirm at, so a switched-on rewrite runs and
    // the refined prompt it produced (printed here, and embedded in the plan
    // file) is what planning receives.
    let taskText = opts.once;
    let rewriteContext = null;
    if (rewriteEnabled) {
      console.log(`${tag('rewrite', s.cyan)} ${s.dim('project read-only · refining the request before planning')}`);
      const rewritten = await rewriteTurn(opts.once);
      if (rewritten.interrupted) {
        console.error(s.dim('interrupted'));
        mcp.closeAll();
        process.exitCode = 130;
        return;
      }
      if (!rewritten.refined) {
        console.error(s.red('rewrite did not produce REFINED PROMPT'));
        console.error(s.dim('the reply held no REFINED PROMPT block — raise config maxTokens if it was cut off, or run again with --no-rewrite'));
        process.exitCode = 1;
        mcp.closeAll();
        return;
      }
      taskText = rewritten.refined;
      rewriteContext = { refined: rewritten.refined, original: opts.once };
      console.log(`\n${tag('refined', s.cyan)} ${s.dim('--once cannot ask for confirmation, so planning uses this refined prompt:')}\n${taskText}`);
    }
    const { planFile, interrupted: stopped } = await planTurn(planHistory, taskText, rewriteContext);
    if (stopped) { // Ctrl+C: there is no plan to implement, so just leave
      console.error(s.dim('interrupted'));
      mcp.closeAll();
      process.exitCode = 130;
      return;
    }
    if (!planFile) {
      console.error(s.red('plan did not produce IMPLEMENT PROMPT'));
      console.error(s.dim(`the reply held no IMPLEMENT PROMPT block — raise config maxTokens if it was cut off, or ask again`));
      process.exitCode = 1;
      mcp.closeAll();
      return;
    }
    lastPlanFile = planFile;
    console.log(savedNote(planFile));
    console.log(`\n${tag('implement', s.cyan)} ${s.dim(`plan: ${planFile}`)}\n`);
    await implementTurn(planFile);
    mcp.closeAll();
    if (interrupted) process.exitCode = 130; // Ctrl+C stopped the implement turn
    return;
  }

  // Workspace and plan directory are named separately and never overlap: the
  // project is what gets changed, the plan directory is where plans are kept.
  console.log(`${s.bold('basic.mjs')}  ${s.dim(`model=${OPENAI.model}  mode=plan  rewrite=${rewriteEnabled ? 'on' : 'off'}`)}`);
  console.log(`${s.dim('workspace  (the project, read-only until /implement):')} ${workspace}`);
  console.log(`${s.dim('plans      (outside the workspace):')} ${planDir}${s.dim(`  ·  context ${fmtTokens(contextSize)} tokens`)}`);
  console.log(`${s.dim('rewrite    (before planning):')} ${rewriteEnabled ? 'on — tasks are refined, confirmed, then planned' : `off — ${s.cyan('/rewrite <task>')} refines one task`}`);
  if (lastPlanFile) {
    console.log(`${s.dim('last plan:')} ${lastPlanFile} ${s.dim(`— /implement to run it, /plans to list them`)}`);
  }
  console.log(rewriteEnabled
    ? `${s.dim('describe the task. agent refines it, you confirm, it plans, then')} ${s.cyan('/implement')}${s.dim('.')}`
    : `${s.dim('describe the task. agent plans, then')} ${s.cyan('/implement')}${s.dim('.')}`);
  console.log(`${s.dim('Ctrl+C stops the running turn (press twice to quit);')} ${s.cyan('/reset')} ${s.dim('clears the context.')}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => rl.question(`${s.cyan(`${pendingRewrite ? 'confirm' : mode}>`)} `, async (line) => {
    try { await handle(line); }
    catch (e) { console.error(s.red(e.message)); }
    ask();
  });
  // On a TTY, readline keeps stdin raw and reports Ctrl+C itself; the process
  // handler covers the non-TTY and --once cases. Both land in onInterrupt.
  rl.on('SIGINT', onInterrupt);
  rl.on('close', () => { mcp.closeAll(); process.exit(0); });
  ask();
}

main().catch((e) => {
  console.error(s.red(e.stack || String(e))); // stack: unexpected errors need the trail
  process.exit(1);
});
