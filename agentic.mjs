#!/usr/bin/env node
/**
 * agentic.mjs — load an agent (.md file), give it a prompt, get the task done.
 *
 *   node agentic.mjs --once "add a --version flag"
 *   node agentic.mjs --agent researcher --once "how does auth work here?"
 *   node agentic.mjs --agents ./my-agents --agent coder "fix the failing test"
 *   node agentic.mjs                       # interactive; /agent switches agents
 *
 * Agents
 *   An agent is a Markdown file in the agents folder (config `agentsDir`,
 *   `--agents <dir>`, `AGENTIC_AGENTS_DIR`; default: `./agents` when it exists,
 *   else `./.github/agents`, else `./agents`). `*.md` and `*.agent.md` files are
 *   loaded (README.md is skipped); the file name — minus `.agent.md`/`.md` — is
 *   the agent name unless the frontmatter says `name:`.
 *
 *   The file may open with YAML frontmatter (the small subset Copilot custom
 *   agents use — scalars, inline/block lists; no YAML library needed):
 *
 *     ---
 *     name: coder
 *     description: 'Implements tasks end to end and verifies them.'
 *     tools: ['read', 'search', 'edit', 'execute']   # aliases, see below
 *     model: gpt-4o-mini          # optional per-agent overrides
 *     temperature: 0.2
 *     maxSteps: 50
 *     maxTokens: 4096
 *     readOnly: false
 *     promptMode: append          # append (default) | replace
 *     ---
 *     # Coder
 *     You implement the task…      <- this body is the agent's system prompt
 *
 *   A file without frontmatter is just a system prompt with all tools.
 *   `tools:` restricts the built-ins by alias (or exact tool name):
 *     read -> read_file + list_dir · search -> search_files ·
 *     edit -> write_file + edit_file · execute -> run_command ·
 *     mcp -> every MCP tool · web/todo/agent -> no built-in here, ignored
 *   No `tools:` (or `tools: ['*']`) means every built-in plus MCP tools.
 *   An agent whose tools give it no way to edit — or that sets
 *   `readOnly: true` — is enforced read-only, not just asked: the writing
 *   tools are not offered and run_command only accepts read-only commands.
 *
 *   Switch agents with `--agent <name>` / `--agent-file <path>`, config
 *   `agent`, or interactively: `/agents` lists them, `/agent <name>` switches
 *   (the conversation is kept, the system prompt is rebuilt, and the model is
 *   told about the switch), `/agent` shows the current one.
 *
 * Config (optional JSON — `--config <path>` or `AGENTIC_CONFIG`; without one,
 * `./agentic.config.json` then `~/.agentic/config.json` are used if present)
 *   { openai: { baseURL, apiKey, model }, contextSize: 64000 (alias:
 *     maxContext / maxcontext), maxTokens: 4096, maxSteps: 50, temperature: 0.2,
 *     streaming: true, workspace, shell, lineEndings: "auto", searchIgnore: [],
 *     commandTimeout: 60, autoCompact: true, promptStyle: "full",
 *     instructions, agentsDir: "./agents", agent: "coder",
 *     mcp: { servers: {
 *       name: { command, args?, env? }          // stdio
 *       name: { type: "http", url, headers? }   // HTTP
 *   } } }
 *   Env overrides: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL,
 *   AGENTIC_MODEL, AGENTIC_CONTEXT_SIZE / AGENTIC_MAX_CONTEXT,
 *   AGENTIC_MAX_STEPS, AGENTIC_TEMPERATURE, AGENTIC_STREAMING,
 *   AGENTIC_AGENTS_DIR, AGENTIC_AGENT.
 *
 * Tools (from lib/tools.js, shared with harness.js)
 *   read_file, write_file, edit_file, list_dir, search_files, run_command,
 *   plus every tool of the configured MCP servers (`mcp_<server>_<tool>`).
 *
 * Context
 *   History is measured before every request against contextSize/maxContext.
 *   At >= 90% it is compacted automatically (config autoCompact): the model
 *   summarizes it and the originals are dropped — the newest messages are
 *   kept verbatim, never splitting a tool call from its results; a request
 *   the server refuses for being too long is compacted and retried once.
 *   /compact does it on demand, /reset drops the conversation.
 *
 * Loops
 *   A turn ends when the model replies without calling a tool. A call that is
 *   identical to one already made in the turn — same tool, same arguments —
 *   is not executed again while nothing has changed since (the file's content
 *   for the file tools; no write, MCP call or state-changing command for the
 *   rest): the model is told the work is already done instead, so an edit is
 *   never applied twice. Three replies in a row of nothing but such repeats
 *   stop the tool loop, and the model gives its final answer with no tools
 *   offered. Three steps before maxSteps it is told to wrap up.
 *
 * Ctrl+C interrupts the running turn (request + running commands' agent
 * loop) and returns to the prompt; a second press, or one while idle, exits.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  calibrateTokens,
  chatCompletion,
  estimatePromptTokens,
  oversizedToolCallNudge,
  smallerReplyTokenLimit,
  TOOL_CALL_PARSE_ERROR,
} from './lib/llm.js';
import { connectMcpServers } from './lib/mcp.js';
import { isReadOnlyCommand } from './lib/plan.js';
import { buildSystemPrompt, gitInfo } from './lib/prompt.js';
import { createTools, expandHome, normalizeEol, shellInfo, TOOL_LIMITS } from './lib/tools.js';
import { fmtDuration, fmtTokens, s } from './lib/ui.js';

/* ------------------------------- defaults -------------------------------- */

export const DEFAULT_CONFIG = {
  openai: { baseURL: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
  contextSize: 64000, // alias on input: maxContext / maxcontext
  maxTokens: 4096,
  maxSteps: 50,
  temperature: 0.2,
  streaming: true,
  workspace: null,
  shell: null,
  lineEndings: 'auto',
  searchIgnore: [],
  commandTimeout: 60,
  autoCompact: true,
  promptStyle: 'full',
  instructions: null,
  agentsDir: null, // resolved by resolveAgentsDir()
  agent: null, // default agent name; null = first agent found
  mcp: { servers: {} },
};

const COMPACT_AT = 0.9;
/** Trailing messages a compaction keeps verbatim (more when that would split a tool call from its results). */
const COMPACT_KEEP = 4;
export const COMPACT_TAG = '[agentic compaction request]';
const COMPACT_PROMPT =
  `${COMPACT_TAG}\nSummarize this session so work can continue without the earlier messages. ` +
  'Include the current request, files inspected/changed, commands and results, decisions and anything pending. ' +
  'Say plainly which changes are already applied and verified, so they are not redone. ' +
  'Concise bullet points, no preamble. Do not call tools.';
const COMPACT_SUMMARY_PREFIX =
  'Earlier in this session (compacted summary — the raw messages were dropped to free context; ' +
  'work it lists as done is already applied, do not redo it):';
const CONTINUE_TAG = '[continue]';
const MAX_CONTINUATIONS = 6;
const MAX_OVERSIZED_RETRIES = 3;
/** Steps before maxSteps at which the model is told to wrap the task up (as in lib/agent.js). */
const WRAP_UP_LEFT = 3;
/** Replies in a row made of nothing but repeated calls before the tool loop is stopped. */
const REPEAT_STREAK_LIMIT = 3;
const TOOL_RESULT_CAP = TOOL_LIMITS.toolResultCap;

/* --------------------------- frontmatter parsing -------------------------- */

const unquote = (v) => {
  const t = String(v).trim();
  const q = t[0];
  return (q === "'" || q === '"') && t.length > 1 && t.endsWith(q) ? t.slice(1, -1) : t;
};

function scalar(v) {
  const t = String(v).trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith('[') && t.endsWith(']')) {
    return t.slice(1, -1).split(',').map((p) => unquote(p)).filter((p) => p !== '');
  }
  return unquote(t);
}

/**
 * Split a Markdown agent file into { data, body }. Understands the YAML
 * subset agent files actually use: `key: value`, inline lists, and block
 * lists of scalars or of flat mappings (Copilot `handoffs:`). Unknown shapes
 * are kept as strings rather than failing — an agent file is a prompt first.
 */
export function parseFrontmatter(raw, file = '<agent>') {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---[ \t]*\n?/);
  if (!m) return { data: {}, body: text.trim() };
  const data = {};
  let listKey = null;
  let entry = null;
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const item = line.match(/^\s+-\s*(.*)$/);
    if (item && listKey) {
      const kv = item[1].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (kv) { entry = { [kv[1]]: scalar(kv[2]) }; data[listKey].push(entry); }
      else { entry = null; data[listKey].push(scalar(item[1])); }
      continue;
    }
    const nested = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
    if (nested && listKey && entry) { entry[nested[1]] = scalar(nested[2]); continue; }
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!top) throw new Error(`${file}: frontmatter line not understood: ${line}`);
    if (top[2].trim() === '') { listKey = top[1]; entry = null; data[listKey] = []; }
    else { listKey = null; entry = null; data[top[1]] = scalar(top[2]); }
  }
  return { data, body: text.slice(m[0].length).trim() };
}

/* --------------------------------- agents --------------------------------- */

/** Tool aliases an agent's `tools:` list may use -> built-in tool names. */
export const TOOL_ALIASES = {
  read: ['read_file', 'list_dir'],
  read_file: ['read_file'],
  list: ['list_dir'],
  list_dir: ['list_dir'],
  search: ['search_files'],
  search_files: ['search_files'],
  edit: ['write_file', 'edit_file'],
  write: ['write_file'],
  write_file: ['write_file'],
  edit_file: ['edit_file'],
  execute: ['run_command'],
  run_command: ['run_command'],
  shell: ['run_command'],
};
export const BUILTIN_TOOL_NAMES = ['read_file', 'write_file', 'edit_file', 'list_dir', 'search_files', 'run_command'];
const WRITER_TOOLS = ['write_file', 'edit_file'];

/**
 * Resolve an agent's frontmatter `tools:` to { builtins, mcp, readOnly }.
 * No list (or '*') = everything. A list without any writer makes the agent
 * read-only: `run_command` then only accepts read-only commands.
 */
export function resolveAgentTools(agent) {
  const raw = agent?.data?.tools;
  if (raw == null || raw === '' || (Array.isArray(raw) && (raw.length === 0 || raw.includes('*')))) {
    return { builtins: [...BUILTIN_TOOL_NAMES], mcp: true, readOnly: agent?.data?.readOnly === true };
  }
  const list = (Array.isArray(raw) ? raw : [raw]).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  const builtins = new Set();
  let mcp = false;
  for (const t of list) {
    if (t === 'mcp' || t.startsWith('mcp_')) { mcp = true; continue; }
    for (const name of TOOL_ALIASES[t] || []) builtins.add(name);
  }
  const canWrite = WRITER_TOOLS.some((t) => builtins.has(t));
  return { builtins: [...builtins], mcp, readOnly: agent?.data?.readOnly === true || !canWrite };
}

const agentNameOf = (file, data) =>
  String(data?.name || path.basename(file).replace(/\.agent\.md$/i, '').replace(/\.md$/i, '')).trim();

/** Load one agent file: { name, file, description, data, body, tools }. */
export function loadAgentFile(file) {
  const abs = path.resolve(file);
  const { data, body } = parseFrontmatter(fs.readFileSync(abs, 'utf8'), abs);
  const agent = { name: agentNameOf(abs, data), file: abs, description: String(data.description || ''), data, body };
  agent.tools = resolveAgentTools(agent);
  return agent;
}

/** Every agent in a folder (top level, `*.md` / `*.agent.md`, README skipped), sorted by name. */
export function loadAgents(dir) {
  const abs = path.resolve(expandHome(String(dir || '')));
  if (!fs.existsSync(abs)) return { dir: abs, agents: [], errors: [`agents folder not found: ${abs}`] };
  const agents = [];
  const errors = [];
  const seen = new Map();
  for (const name of fs.readdirSync(abs).sort()) {
    if (!/\.md$/i.test(name) || /^readme\.md$/i.test(name)) continue;
    const file = path.join(abs, name);
    try {
      if (!fs.statSync(file).isFile()) continue;
      const agent = loadAgentFile(file);
      if (!agent.name) { errors.push(`${file}: agent has no name — skipped`); continue; }
      if (seen.has(agent.name)) { errors.push(`duplicate agent "${agent.name}" in ${file} (first: ${seen.get(agent.name)}) — skipped`); continue; }
      seen.set(agent.name, file);
      agents.push(agent);
    } catch (e) {
      errors.push(`${file}: ${e.message}`);
    }
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));
  return { dir: abs, agents, errors };
}

/** `--agents` / config / env win; else ./agents, else ./.github/agents, else ./agents. */
export function resolveAgentsDir(explicit, cwd = process.cwd()) {
  if (explicit) return path.resolve(cwd, expandHome(String(explicit)));
  for (const cand of ['agents', '.github/agents']) {
    const abs = path.join(cwd, cand);
    try { if (fs.statSync(abs).isDirectory()) return abs; } catch { /* keep looking */ }
  }
  return path.join(cwd, 'agents');
}

/** Pick an agent by name (case-insensitive) or fall back to the first. */
export function pickAgent(agents, wanted) {
  if (!agents.length) return null;
  if (wanted) {
    const hit = agents.find((a) => a.name.toLowerCase() === String(wanted).toLowerCase());
    if (hit) return hit;
  }
  return agents[0];
}

/* --------------------------------- config --------------------------------- */

const truthy = (v) => ['1', 'true', 'on', 'yes'].includes(String(v).toLowerCase());

function cleanList(v) {
  return (Array.isArray(v) ? v : []).map((x) => String(x ?? '').trim()).filter(Boolean);
}

/** Merge a raw config object over the defaults, honouring the maxContext alias, and validate. */
export function normalizeConfig(raw = {}, { cwd = process.cwd() } = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  if (raw && typeof raw === 'object') {
    Object.assign(cfg, raw);
    cfg.openai = { ...DEFAULT_CONFIG.openai, ...(raw.openai || {}) };
    cfg.mcp = { servers: {}, ...(raw.mcp || {}) };
    cfg.mcp.servers = raw.mcp?.servers && typeof raw.mcp.servers === 'object' ? raw.mcp.servers : {};
    // maxContext (any casing) is the alias basic-style configs and the CLI use
    const alias = raw.maxContext ?? raw.maxcontext ?? raw['max-context'];
    if (alias !== undefined && raw.contextSize === undefined) cfg.contextSize = alias;
  }
  if (process.env.OPENAI_BASE_URL) cfg.openai.baseURL = process.env.OPENAI_BASE_URL;
  if (process.env.OPENAI_API_KEY) cfg.openai.apiKey = process.env.OPENAI_API_KEY;
  if (process.env.OPENAI_MODEL) cfg.openai.model = process.env.OPENAI_MODEL;
  if (process.env.AGENTIC_MODEL) cfg.openai.model = process.env.AGENTIC_MODEL;
  if (process.env.AGENTIC_CONTEXT_SIZE || process.env.AGENTIC_MAX_CONTEXT) {
    cfg.contextSize = Number(process.env.AGENTIC_CONTEXT_SIZE || process.env.AGENTIC_MAX_CONTEXT);
  }
  if (process.env.AGENTIC_MAX_TOKENS) cfg.maxTokens = Number(process.env.AGENTIC_MAX_TOKENS);
  if (process.env.AGENTIC_MAX_STEPS) cfg.maxSteps = Number(process.env.AGENTIC_MAX_STEPS);
  if (process.env.AGENTIC_TEMPERATURE) cfg.temperature = Number(process.env.AGENTIC_TEMPERATURE);
  if (process.env.AGENTIC_STREAMING !== undefined) cfg.streaming = truthy(process.env.AGENTIC_STREAMING);
  if (process.env.AGENTIC_AGENTS_DIR) cfg.agentsDir = process.env.AGENTIC_AGENTS_DIR;
  if (process.env.AGENTIC_AGENT) cfg.agent = process.env.AGENTIC_AGENT;

  if (!cfg.openai || typeof cfg.openai.baseURL !== 'string' || !cfg.openai.baseURL) {
    throw new Error('config error: openai.baseURL must be a non-empty string');
  }
  cfg.openai.baseURL = cfg.openai.baseURL.replace(/\/+$/, '');
  if (typeof cfg.openai.model !== 'string' || !cfg.openai.model) throw new Error('config error: openai.model is required');
  cfg.openai.apiKey = cfg.openai.apiKey == null ? '' : String(cfg.openai.apiKey);
  cfg.contextSize = Math.max(2000, Math.floor(Number(cfg.contextSize) || DEFAULT_CONFIG.contextSize));
  cfg.maxTokens = Math.max(256, Math.floor(Number(cfg.maxTokens) || DEFAULT_CONFIG.maxTokens));
  cfg.maxSteps = Number.isFinite(Number(cfg.maxSteps)) && Number(cfg.maxSteps) >= 1
    ? Math.min(1000, Math.floor(Number(cfg.maxSteps))) : DEFAULT_CONFIG.maxSteps;
  cfg.temperature = Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : DEFAULT_CONFIG.temperature;
  cfg.commandTimeout = Number(cfg.commandTimeout) || DEFAULT_CONFIG.commandTimeout;
  cfg.streaming = Boolean(cfg.streaming);
  cfg.autoCompact = cfg.autoCompact !== false;
  cfg.searchIgnore = cleanList(cfg.searchIgnore);
  cfg.promptStyle = String(cfg.promptStyle || 'full').toLowerCase() === 'compact' ? 'compact' : 'full';
  cfg.instructions = cfg.instructions == null || String(cfg.instructions).trim() === '' ? null : String(cfg.instructions);
  cfg.agentsDir = cfg.agentsDir ? path.resolve(cwd, expandHome(String(cfg.agentsDir))) : null;
  cfg.agent = cfg.agent ? String(cfg.agent) : null;
  if (cfg.workspace) cfg.workspace = path.resolve(cwd, expandHome(String(cfg.workspace)));
  return cfg;
}

/** Default config lookup: explicit path, else ./agentic.config.json, else ~/.agentic/config.json. */
export function findConfigPath(explicit, cwd = process.cwd()) {
  if (explicit) return path.resolve(cwd, expandHome(explicit));
  if (process.env.AGENTIC_CONFIG) return path.resolve(cwd, expandHome(process.env.AGENTIC_CONFIG));
  for (const cand of [path.join(cwd, 'agentic.config.json'), path.join(os.homedir(), '.agentic', 'config.json')]) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

/** Load + normalize the config file (a missing default file is fine; an explicit missing one is not). */
export function loadAgenticConfig(explicitPath, { cwd = process.cwd() } = {}) {
  const configPath = findConfigPath(explicitPath, cwd);
  if (!configPath) return { config: normalizeConfig({}, { cwd }), path: null };
  if (explicitPath && !fs.existsSync(configPath)) throw new Error(`config file not found: ${configPath}`);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (e) { throw new Error(`failed to parse ${configPath}: ${e.message}`); }
  return { config: normalizeConfig(raw, { cwd }), path: configPath };
}

/* ------------------------------- system prompt ---------------------------- */

/** config.instructions: literal text, or a single-line path to a file (as in lib/agent.js). */
function resolveInstructions(instructions, cwd) {
  const text = String(instructions ?? '').trim();
  if (!text) return '';
  if (!text.includes('\n')) {
    try {
      const file = path.resolve(cwd, expandHome(text));
      if (fs.statSync(file).isFile()) return fs.readFileSync(file, 'utf8').trim();
    } catch { /* literal text */ }
  }
  return text;
}

/**
 * How a turn ends. These are facts about this harness, not agent persona, so
 * every agent gets them — `promptMode: replace` included, like the env block:
 * a model that does not know the loop only ends on a reply without tool calls
 * keeps "verifying" finished work until maxSteps.
 */
export const TURN_RULES = [
  '# Ending the turn',
  '- The turn ends when you reply without calling a tool. Once the request is done and verified, stop calling tools and give your final summary.',
  '- A successful tool result is the confirmation: do not re-read, re-apply or re-run work that already succeeded. ' +
    'An identical call made again with nothing changed since is not executed — you get a note instead, and repeating anyway ends the tool loop.',
].join('\n');

/**
 * The system prompt for an agent: the shared coding-harness prompt (env,
 * tool discipline, definition of done) and the turn rules, with the agent
 * file's body appended — last, so the agent wins on conflict — unless the
 * agent asks for `promptMode: replace`, in which case its body IS the prompt
 * (plus env and the turn rules).
 */
export function buildAgentSystemPrompt({ config, agent, cwd }) {
  const body = String(agent?.body || '').trim();
  const header = agent ? `# Agent: ${agent.name}${agent.description ? `\n${agent.description}` : ''}` : '';
  if (String(agent?.data?.promptMode || 'append').toLowerCase() === 'replace' && body) {
    const env = [
      '# Environment',
      `- Workspace (cwd): ${cwd}`,
      `- Platform: ${shellInfo(config)}`,
      `- Today: ${new Date().toISOString().slice(0, 10)}`,
    ];
    const git = gitInfo(cwd);
    if (git) env.push(`- Git: ${git}`);
    const extra = resolveInstructions(config.instructions, cwd);
    return [body, env.join('\n'), TURN_RULES, extra ? `# User instructions\n${extra}` : ''].filter(Boolean).join('\n\n');
  }
  return buildSystemPrompt({
    cwd,
    platform: shellInfo(config),
    git: gitInfo(cwd),
    style: config.promptStyle,
    instructions: resolveInstructions(config.instructions, cwd),
    blocks: [TURN_RULES, [header, body].filter(Boolean).join('\n\n')],
  });
}

/** Effective per-turn settings: frontmatter overrides beat the config. */
export function effectiveSettings(config, agent) {
  const d = agent?.data || {};
  const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
  return {
    model: d.model ? String(d.model) : config.openai.model,
    temperature: Number.isFinite(Number(d.temperature)) ? Number(d.temperature) : config.temperature,
    maxTokens: Math.max(256, Math.floor(num(d.maxTokens, config.maxTokens))),
    maxSteps: Math.min(1000, Math.floor(num(d.maxSteps, config.maxSteps))),
  };
}

/* ------------------------------ repeat guard ------------------------------ */

/*
 * A model that has finished does not always stop. It re-reads the file it
 * just edited, applies the same edit again, re-runs the same check — and the
 * loop only ends at maxSteps. That is not only wasted steps: an edit whose
 * new_text contains its old_text (an insertion) applies cleanly every time,
 * so each round duplicates the change in the file.
 *
 * The guard sits between the model and the tools. A call identical to one
 * already made in this turn — same tool, same arguments — is not executed
 * again while nothing has changed since: its result would be the same, or,
 * for a write, the work is already in place. The model gets a note saying so
 * instead. "Nothing has changed" is measured on the file itself for the file
 * tools (a hash of its content, so an unrelated `npm test` in between does
 * not re-arm an edit), and with a change counter for the rest: it moves on
 * every write that changed a file, every MCP call and every command that ran
 * and is not read-only. MCP calls are never refused — their side effects are
 * unknown, so repeating one may be the point — and a command that ran and
 * failed gets one identical retry, because failures can be transient.
 */

/** Opens every note the guard sends back, and the nudge that ends a stuck loop. */
export const REPEAT_TAG = '[repeated call]';

const stopRepeatingNudge = (n) =>
  `[system] ${REPEAT_TAG} Stopping the tool loop: your last ${n} replies only repeated tool calls that had already run, ` +
  'with nothing changed in between — that work is already done. No tools are available for the rest of this turn. ' +
  'Reply now with your final answer: what was changed, how it was verified, and anything still left to do.';
const STOPPED_REPEATING =
  '(stopped: the model kept repeating tool calls that had already run — the work above is already in place)';

const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);
const NEXT_STEP =
  'Do not repeat it: take the next, different step — or, if the task is done, stop calling tools and reply with your final summary.';

/** JSON with sorted keys, so the order the model wrote the arguments in does not matter. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** What a file looks like right now: a hash of its bytes, or why there is none. */
function fileState(abs) {
  let st;
  try { st = fs.statSync(abs); } catch { return 'missing'; }
  if (st.isDirectory()) return 'directory';
  if (st.size > TOOL_LIMITS.maxReadBytes) return `large:${st.size}:${st.mtimeMs}`;
  try { return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex'); }
  catch { return `unreadable:${st.mtimeMs}`; }
}

function readText(abs) {
  try { return normalizeEol(fs.readFileSync(abs, 'utf8')); } catch { return null; }
}

/** Non-overlapping occurrences, the way edit_file counts its matches. */
function countOccurrences(text, needle) {
  let count = 0;
  for (let at = text.indexOf(needle); needle && at >= 0; at = text.indexOf(needle, at + needle.length)) count++;
  return count;
}

function firstLine(text, max = 160) {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * Every tool says "Error: …" when it fails; run_command also reports an exit
 * code. The first "exit code:" line is the harness's own — it comes before the
 * command's stdout, which could print one too.
 */
function callFailed(name, output) {
  if (/^\s*error\b/i.test(output)) return true;
  const exit = name === 'run_command' ? output.match(/^exit code: (.*)$/m) : null;
  return Boolean(exit) && exit[1].trim() !== '0';
}

function repeatNote(name, file, prev) {
  if (!prev.ok) {
    return `${REPEAT_TAG} Not run again: this exact ${name} call already failed at step ${prev.step} (${prev.brief}) and nothing has changed since, ` +
      'so it would fail the same way. Change the arguments or the approach, or report the blocker in your final reply.';
  }
  switch (name) {
    case 'edit_file':
      return `${REPEAT_TAG} Not applied again: this exact edit was already applied to ${file} at step ${prev.step}, and the file has not changed since — ` +
        `applying it again would duplicate the change or fail. The edit is done. ${NEXT_STEP}`;
    case 'write_file':
      return `${REPEAT_TAG} Not written again: ${file} already has exactly this content (written at step ${prev.step}). ${NEXT_STEP}`;
    case 'read_file':
      return `${REPEAT_TAG} Not read again: you already read this exact part of ${file} at step ${prev.step}, and the file has not changed since — ` +
        `its content is in the conversation above. ${NEXT_STEP}`;
    case 'run_command':
      return `${REPEAT_TAG} Not run again: this exact command already ran at step ${prev.step} (${prev.brief}) and nothing has changed since, ` +
        `so it would give the same result — its output is above. ${NEXT_STEP}`;
    default:
      return `${REPEAT_TAG} Not run again: this exact ${name} call already ran at step ${prev.step} and nothing has changed since — its result is above. ${NEXT_STEP}`;
  }
}

/**
 * One guard per turn. `run(name, args, execute, { step })` either executes the
 * call through `execute()` or, for a repeat, answers without running anything:
 * `{ output, repeated, reason }`. `forgetReads()` is for after a compaction:
 * the results the model could look back at are gone, so fetching them again
 * is legitimate — what the file tools wrote is still on disk, so the write
 * records stay.
 */
export function createRepeatGuard({ cwd = process.cwd() } = {}) {
  const root = () => (typeof cwd === 'function' ? cwd() : cwd);
  const resolve = (p) => path.resolve(root(), expandHome(p) || '.');
  const records = new Map(); // call signature -> { step, state, ok, failures, retryable, brief, write }
  let changes = 0;
  let skipped = 0;

  const keyOf = (name, args) => {
    const a = typeof args.path === 'string' ? { ...args, path: resolve(args.path) } : args; // app.js === ./app.js
    return `${name}\u0000${stableStringify(a)}`;
  };
  /** null = never a repeat: MCP and unknown tools, whose side effects are unknown. */
  const stateOf = (name, args) => {
    if (FILE_TOOLS.has(name)) return fileState(resolve(args.path));
    return BUILTIN_TOOL_NAMES.includes(name) ? `changes:${changes}` : null;
  };

  /**
   * An insertion (new_text wraps old_text) that is already applied everywhere
   * it could apply: every occurrence of old_text in the file sits inside a
   * copy of new_text. Applying it would only duplicate the insertion. When
   * old_text also occurs on its own, there is a real target — the edit runs,
   * and edit_file itself reports an ambiguous match.
   */
  const insertionPresent = (args) => {
    const oldText = normalizeEol(String(args.old_text ?? ''));
    const newText = normalizeEol(String(args.new_text ?? ''));
    if (!oldText || newText === oldText || !newText.includes(oldText)) return false;
    const text = readText(resolve(args.path));
    const copies = text === null ? 0 : countOccurrences(text, newText);
    return copies > 0 && countOccurrences(text, oldText) === copies * countOccurrences(newText, oldText);
  };

  function skip(output, reason) {
    skipped++;
    return { output, repeated: true, reason };
  }

  async function run(name, rawArgs, execute, { step = 0 } = {}) {
    // Arguments that are not an object (a model can send any JSON) still key
    // the call by their value; the state checks only need the object form.
    const isObject = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs);
    const args = isObject ? rawArgs : {};
    const file = typeof args.path === 'string' ? args.path : '';
    const key = keyOf(name, isObject ? rawArgs : { value: rawArgs });
    const before = stateOf(name, args);
    const prev = records.get(key);
    if (before !== null && prev && prev.state === before && !(prev.retryable && prev.failures < 2)) {
      return skip(repeatNote(name, file, prev), `identical to the call at step ${prev.step}, nothing changed since`);
    }
    // The way "start the task over" corrupts a file when the identical-call
    // record cannot help — a new turn, or the same edit with the whitespace
    // of the arguments changed: an insertion whose result is already there
    // would be added a second time.
    if (name === 'edit_file' && insertionPresent(args)) {
      return skip(
        `${REPEAT_TAG} Not applied: ${file} already contains new_text. This edit only adds text around old_text, and that text is already there — ` +
          `applying it again would duplicate it. The change is already in place. ${NEXT_STEP} ` +
          '(If a second copy is really intended, include more surrounding context in old_text.)',
        'new_text is already in the file'
      );
    }

    let output = String(await execute());
    const ok = !callFailed(name, output);
    const ran = /^exit code: /m.test(output);
    if (before === null) changes++; // MCP: assume it did something
    else if (name === 'run_command' && ran && !isReadOnlyCommand(args.command, [], { ignoreOs: true }).ok) changes++;
    const after = stateOf(name, args);
    if (WRITE_TOOLS.has(name) && after !== before) changes++;
    // A failed edit whose new_text is already in the file was most likely
    // applied earlier — say so, or the model keeps varying old_text.
    if (name === 'edit_file' && !ok && /old_text not found/.test(output)) {
      const newText = normalizeEol(String(args.new_text ?? '')).trim();
      if (/[A-Za-z0-9]/.test(newText) && readText(resolve(args.path))?.includes(newText)) {
        output += `\nNote: new_text already appears in ${file} — if this edit was meant to put it there, the change is already applied: do not retry it.`;
      }
    }
    if (after !== null) {
      records.set(key, {
        step,
        state: after,
        ok,
        failures: ok ? 0 : prev && !prev.ok && prev.state === before ? prev.failures + 1 : 1,
        retryable: !ok && name === 'run_command' && ran,
        brief: name === 'run_command' && ran ? firstLine(output.match(/^exit code: .*$/m)[0]) : firstLine(output),
        write: WRITE_TOOLS.has(name),
      });
    }
    return { output, repeated: false, reason: '' };
  }

  return {
    run,
    forgetReads() {
      for (const [key, rec] of records) if (!rec.write) records.delete(key);
    },
    get skipped() { return skipped; },
  };
}

/**
 * Where a compaction's verbatim tail starts: about `keep` messages from the
 * end, moved back so it never opens on a tool result. A tool message is only
 * valid right after the assistant message that called it; cutting between
 * them sends the summarizer an unanswered tool call (strict servers reject
 * the request) and keeps results whose calls were summarized away — the model
 * then looks at outcomes of work it no longer remembers doing, and redoes it.
 */
export function compactionCut(history, keep = COMPACT_KEEP) {
  let cut = Math.max(1, history.length - keep);
  while (cut > 1 && history[cut]?.role === 'tool') cut--;
  return cut;
}

/* ---------------------------------- agent --------------------------------- */

/**
 * One session: a conversation driven by whichever agent is current.
 * Switching replaces the system prompt in place and notes the switch in the
 * history, so one conversation can be researched by one agent and built by
 * another — the .md files are the only difference between them.
 */
export function createSession({ config, builtins, mcp, agents = [], agent = null, log = console.log }) {
  const history = [];
  let current = agent || agents[0] || null;
  let activeController = null;
  const stats = { calls: 0, promptTokens: 0, completionTokens: 0, compactions: 0, steps: 0 };

  const settings = () => effectiveSettings(config, current);
  const llmConfig = () => {
    const st = settings();
    return { ...config, openai: { ...config.openai, model: st.model }, temperature: st.temperature };
  };
  const systemPrompt = () => buildAgentSystemPrompt({ config, agent: current, cwd: builtins.cwd });

  /** Tools offered to the current agent: its allowlist ∩ builtins, plus MCP when allowed. */
  function offeredTools() {
    if (!current) return [...builtins.listTools(), ...(mcp ? mcp.listTools() : [])];
    const excluded = BUILTIN_TOOL_NAMES.filter((n) => !current.tools.builtins.includes(n));
    const list = builtins.listTools({ readOnly: current.tools.readOnly, exclude: excluded });
    return [...list, ...(current.tools.mcp && mcp ? mcp.listTools() : [])];
  }

  async function executeTool(name, args) {
    if (mcp?.has(name)) {
      if (current && !current.tools.mcp) return `Error: MCP tools are not available to agent "${current.name}"`;
      try { return String(await mcp.call(name, args || {})); }
      catch (e) { return `Error: ${e.message}`; }
    }
    // Defence in depth: a call for a tool the agent was never offered (left
    // over from before a switch, or invented) is refused, not executed.
    if (current && BUILTIN_TOOL_NAMES.includes(name) && !current.tools.builtins.includes(name)) {
      return `Error: the ${name} tool is not available to agent "${current.name}" (tools: ${current.tools.builtins.join(', ') || 'none'})`;
    }
    return builtins.execute(name, args, { readOnly: current?.tools.readOnly === true });
  }

  function reset() {
    history.length = 0;
    history.push({ role: 'system', content: systemPrompt() });
  }

  /** Switch agents: new system prompt, conversation kept, model told. */
  function switchAgent(next) {
    if (!next || next === current) return current;
    const from = current?.name || '(none)';
    current = next;
    if (history.length && history[0].role === 'system') history[0].content = systemPrompt();
    else reset();
    if (history.length > 1) {
      history.push({
        role: 'user',
        content: `[system] The agent was switched from "${from}" to "${next.name}". Follow the new system prompt from here on.`,
      });
    }
    return current;
  }

  async function compact(signal) {
    // The cut never separates a tool call from its results (see compactionCut),
    // so both the summary request and the rebuilt history stay valid chat.
    const cut = compactionCut(history);
    const middle = history.slice(1, cut);
    if (!middle.length) return false;
    const head = history[0];
    const request = [head, ...middle, { role: 'user', content: COMPACT_PROMPT }];
    const result = await chatCompletion({ config: llmConfig(), messages: request, tools: [], maxTokens: 1500, signal });
    const summary = String(result.message?.content || '').trim();
    if (!summary) return false;
    const rebuilt = [head, { role: 'user', content: `${COMPACT_SUMMARY_PREFIX}\n${summary}` }, ...history.slice(cut)];
    // A summary no smaller than what it replaces frees nothing and costs the
    // detail of the raw messages.
    if (estimatePromptTokens(rebuilt) >= estimatePromptTokens(history)) return false;
    history.length = 0;
    history.push(...rebuilt);
    stats.compactions++;
    return true;
  }

  /**
   * Run one user prompt to completion (tool loop). Returns { text, steps,
   * interrupted, notice } — `notice` marks a text the harness wrote itself (a
   * stop message): it was never streamed, so the caller must print it.
   */
  async function turn(userText, { onText = null } = {}) {
    if (!current) throw new Error('no agent loaded — point --agents at a folder with .md agent files (or run --init-agents)');
    history.push({ role: 'user', content: String(userText) });
    const controller = new AbortController();
    activeController = controller;
    const st = settings();
    const guard = createRepeatGuard({ cwd: () => builtins.cwd });
    let steps = 0;
    let continuations = 0;
    let oversizedRetries = 0;
    let replyLimit = st.maxTokens;
    let compactedAfterOverflow = false;
    let repeatStreak = 0; // replies in a row that only repeated finished calls
    let finishing = false; // the tool loop was stopped: one last reply, without tools
    let wrapUpSent = false;
    const started = Date.now();
    try {
      // While finishing, the loop may go one request past maxSteps: the final
      // answer is what the user is waiting for, and a reply requested without
      // tools always ends the turn.
      while (steps < st.maxSteps || finishing) {
        // Context budget: compact before the request no longer fits.
        if (config.autoCompact && estimatePromptTokens(history) >= COMPACT_AT * (config.contextSize - replyLimit)) {
          try {
            if (await compact(controller.signal)) {
              guard.forgetReads(); // the results it remembers were summarized away
              log(s.dim('  · context compacted'));
            }
          } catch { /* a request the server refuses as too long is compacted again below */ }
        }
        // Approaching the step limit: ask for a finish instead of being cut off mid-task.
        if (!finishing && !wrapUpSent && steps > 0 && st.maxSteps - steps === WRAP_UP_LEFT) {
          wrapUpSent = true;
          history.push({
            role: 'user',
            content: `[system] ${WRAP_UP_LEFT} steps left in this turn — finish the task now, or state clearly what remains to be done.`,
          });
          log(s.dim(`  · ${WRAP_UP_LEFT} steps left — telling the model to wrap up`));
        }
        let result;
        try {
          let streamed = '';
          result = await chatCompletion({
            config: llmConfig(),
            messages: history,
            tools: finishing ? [] : offeredTools(),
            maxTokens: replyLimit,
            signal: controller.signal,
            onDelta: onText ? (t) => { streamed += t; onText(t); } : undefined,
          });
          if (result.usage) {
            calibrateTokens(history, result.usage.prompt_tokens);
            stats.promptTokens += Number(result.usage.prompt_tokens) || 0;
            stats.completionTokens += Number(result.usage.completion_tokens) || 0;
          }
          stats.calls++;
        } catch (e) {
          if (controller.signal.aborted || e?.name === 'AbortError') return { text: '', steps, interrupted: true };
          if (e?.kind === TOOL_CALL_PARSE_ERROR && oversizedRetries < MAX_OVERSIZED_RETRIES) {
            oversizedRetries++;
            const smaller = smallerReplyTokenLimit(replyLimit);
            history.push({ role: 'user', content: oversizedToolCallNudge(replyLimit, smaller) });
            replyLimit = smaller;
            continue;
          }
          if (!compactedAfterOverflow && /context|too many tokens|too long/i.test(e?.message || '') && (await compact(controller.signal).catch(() => false))) {
            compactedAfterOverflow = true;
            guard.forgetReads();
            continue;
          }
          throw e;
        }
        const msg = result.message;
        history.push(msg);
        steps++;
        stats.steps++;
        const truncated = ['length', 'max_tokens', 'max_token', 'model_length', 'token_limit'].includes(String(result.finishReason || '').toLowerCase());
        // No tools were offered for the final answer, so a call in it could
        // never be answered — and an unanswered tool_calls message would make
        // the next request invalid. Only its text counts; a reply that was
        // nothing but calls (cut off or not) ends the turn with the notice,
        // which also keeps the history free of an empty assistant message.
        if (finishing && msg.tool_calls) {
          delete msg.tool_calls;
          if (!String(msg.content ?? '').trim()) {
            msg.content = STOPPED_REPEATING;
            return { text: STOPPED_REPEATING, steps, interrupted: false, notice: true };
          }
        }
        const toolCalls = msg.tool_calls || [];
        if (!toolCalls.length) {
          if (truncated && continuations < MAX_CONTINUATIONS) {
            continuations++;
            history.push({ role: 'user', content: `${CONTINUE_TAG} Your previous message was cut off by the token limit. Continue exactly where you left off.` });
            continue;
          }
          if (finishing && !String(msg.content || '').trim()) {
            msg.content = STOPPED_REPEATING;
            return { text: STOPPED_REPEATING, steps, interrupted: false, notice: true };
          }
          return { text: String(msg.content || ''), steps, interrupted: false };
        }
        continuations = 0;
        let repeated = 0;
        for (const tc of toolCalls) {
          const name = tc.function?.name || '(unknown)';
          let args = {};
          let parseError = null;
          try { args = JSON.parse(tc.function?.arguments || '{}'); }
          catch (e) { parseError = e; }
          log(`\n${s.dim('──')} ${s.cyan('⚙ ' + name)} ${s.dim(JSON.stringify(args).slice(0, 160))}`);
          let output;
          let skipped = '';
          if (parseError) {
            output = truncated
              ? 'Error: this tool call was cut off by the model token limit before its arguments were complete. Re-issue the complete tool call.'
              : `Error: invalid tool arguments JSON: ${parseError.message}`;
          } else {
            const done = await guard.run(name, args, () => executeTool(name, args), { step: steps });
            output = done.output;
            if (done.repeated) { repeated++; skipped = done.reason; }
          }
          if (String(output).length > TOOL_RESULT_CAP) {
            output = String(output).slice(0, TOOL_RESULT_CAP) + `\n…[truncated at ${TOOL_RESULT_CAP} chars]`;
          }
          log(skipped ? s.yellow(`↺ not run again: ${skipped}`) : s.dim(String(output).split('\n').slice(0, 6).join('\n')));
          history.push({ role: 'tool', tool_call_id: tc.id, content: String(output) });
        }
        // A reply that only repeated finished work made no progress. A few in
        // a row and the model is not going to stop by itself, notes or not:
        // take the tools away and ask for the final answer.
        repeatStreak = repeated === toolCalls.length ? repeatStreak + 1 : 0;
        if (repeatStreak >= REPEAT_STREAK_LIMIT) {
          finishing = true;
          history.push({ role: 'user', content: stopRepeatingNudge(repeatStreak) });
          log(s.yellow(`  · ${repeatStreak} replies in a row only repeated work that was already done — stopping the tool loop and asking for the final answer`));
        }
      }
      return { text: `(stopped: reached the ${st.maxSteps}-step limit — say "continue" or raise maxSteps)`, steps, interrupted: false, notice: true };
    } finally {
      if (activeController === controller) activeController = null;
      const repeats = guard.skipped ? ` repeats-skipped=${guard.skipped}` : '';
      log(s.dim(`\n[done] agent=${current?.name} steps=${steps}${repeats} elapsed=${fmtDuration(Date.now() - started)} context≈${fmtTokens(estimatePromptTokens(history))}/${fmtTokens(config.contextSize)} tokens`));
    }
  }

  reset();
  return {
    turn,
    reset,
    compact: () => compact(activeController?.signal),
    switchAgent,
    offeredTools,
    history,
    stats: () => ({ ...stats }),
    get agent() { return current; },
    cancel() { activeController?.abort(); },
  };
}

/* ------------------------------ agent templates --------------------------- */

export const EXAMPLE_AGENTS = {
  'coder.md': `---\nname: coder\ndescription: 'Implements a task end to end: reads first, smallest correct diff, verifies, reports.'\ntools: ['read', 'search', 'edit', 'execute', 'mcp']\n---\n\n# Coder\n\nYou implement the user's task in this workspace. Read before you change, make\nthe smallest correct diff, run the verification the change calls for (tests,\nbuild, a repro command), fix what fails, and report what changed file by file\nwith the verification result. Do not commit or push unless asked.\n`,
  'researcher.md': `---\nname: researcher\ndescription: 'Read-only: answers questions about the codebase with file evidence, never changes it.'\ntools: ['read', 'search']\nreadOnly: true\n---\n\n# Researcher\n\nYou answer questions about this codebase. You are read-only: inspect with\nsearch_files and read_file, cite \`file:line\` for every claim, and say plainly\nwhat you could not find. Never propose edits as if you had made them.\n`,
  'reviewer.md': `---\nname: reviewer\ndescription: 'Read-only: reviews the current diff for bugs, risks and missing tests.'\ntools: ['read', 'search', 'execute']\nreadOnly: true\n---\n\n# Reviewer\n\nYou review the working tree (start with \`git status\` and \`git diff\`). Report\nfindings first, ordered by severity, each with the file and line, the failure\nit causes, and the fix you would expect. Note missing tests. You change\nnothing.\n`,
};

const EXAMPLE_CONFIG = () => JSON.stringify({ ...DEFAULT_CONFIG, openai: { ...DEFAULT_CONFIG.openai, apiKey: 'sk-REPLACE_ME' }, agentsDir: './agents', agent: 'coder' }, null, 2) + '\n';

/** Write the example agents into `dir` (never overwriting). Returns written file names. */
export function writeExampleAgents(dir) {
  const abs = path.resolve(expandHome(String(dir)));
  fs.mkdirSync(abs, { recursive: true });
  const written = [];
  for (const [name, content] of Object.entries(EXAMPLE_AGENTS)) {
    const file = path.join(abs, name);
    if (!fs.existsSync(file)) { fs.writeFileSync(file, content, 'utf8'); written.push(name); }
  }
  return written;
}

/* ----------------------------------- CLI ---------------------------------- */

function parseArgs(argv) {
  const o = {
    once: null, promptFile: null, config: null, agentsDir: null, agent: null, agentFile: null,
    dir: null, model: null, maxContext: null, help: false, listAgents: false, init: false,
    initAgents: null, noStream: false, positional: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--once' || a === '--task' || a === '-p' || a === '--prompt') o.once = next();
    else if (a === '--prompt-file') o.promptFile = next();
    else if (a === '--config' || a === '-c') o.config = next();
    else if (a === '--agents' || a === '--agents-dir') o.agentsDir = next();
    else if (a === '--agent') o.agent = next();
    else if (a === '--agent-file') o.agentFile = next();
    else if (a === '--dir' || a === '-d') o.dir = next();
    else if (a === '--model') o.model = next();
    else if (a === '--max-context' || a === '--context-size') o.maxContext = Number(next());
    else if (a === '--list-agents') o.listAgents = true;
    else if (a === '--init') o.init = true;
    else if (a === '--init-agents') o.initAgents = next() || 'agents';
    else if (a === '--no-stream') o.noStream = true;
    else if (a === '--stream') o.noStream = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown flag: ${a} (see --help)`);
    else o.positional.push(a);
  }
  if (o.once == null && o.positional.length) o.once = o.positional.join(' ');
  return o;
}

const HELP = `agentic.mjs — load an agent (.md), give it a prompt, get the task done.

  node agentic.mjs --once "task" [--agent name] [--agents dir] [--config file]
  node agentic.mjs --agent researcher --once "how does auth work?"
  node agentic.mjs --agent-file ./my-agent.md --prompt-file task.md
  node agentic.mjs "task"                  same as --once "task"
  node agentic.mjs                         interactive

Flags
  --once/--task/-p/--prompt <text>  run one task and exit
  --prompt-file <path>              read the task from a file (with --once text: appended)
  --agent <name>                    agent to start with (default: config agent, else first)
  --agent-file <path>               load this one .md file as the agent
  --agents/--agents-dir <dir>       folder of agent .md files
  --config/-c <path>                JSON config (default: ./agentic.config.json,
                                    else ~/.agentic/config.json, else defaults + env)
  --dir/-d <path>                   workspace root for the tools
  --model <name>                    override openai.model
  --max-context <n>                 override contextSize/maxContext
  --no-stream                       do not stream the reply
  --list-agents                     list the agents in the folder and exit (no API call)
  --init                            write an example config (--config path, default ./agentic.config.json)
  --init-agents [dir]               write example agents (coder, researcher, reviewer)
  --help

Interactive commands
  /agents             list agents (* = current)
  /agent [name]       show or switch the current agent (conversation is kept)
  /tools              list the tools the current agent may use
  /config             show the effective config (API key masked)
  /compact            summarize the conversation to free context
  /reset              drop the conversation (same agent, fresh context)
  /help, /quit

Agents are .md files: optional frontmatter (name, description, tools,
model, temperature, maxSteps, maxTokens, readOnly, promptMode) and a body
that becomes the system prompt. See the header of agentic.mjs and agents/.
Ctrl+C stops the running turn; press it again (or while idle) to exit.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
  const cwd = process.cwd();

  if (opts.initAgents != null) {
    const written = writeExampleAgents(path.resolve(cwd, expandHome(opts.initAgents)));
    console.log(written.length ? `wrote ${written.join(', ')} to ${opts.initAgents}` : `agents already present in ${opts.initAgents} — nothing written`);
    if (!opts.once && !opts.init) return;
  }
  if (opts.init) {
    const target = opts.config ? path.resolve(cwd, expandHome(opts.config)) : path.join(cwd, 'agentic.config.json');
    if (fs.existsSync(target)) { console.log(`config already exists: ${target} — nothing written`); }
    else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, EXAMPLE_CONFIG(), 'utf8'); console.log(`wrote ${target}`); }
    if (!opts.once) return;
  }

  const { config, path: configPath } = loadAgenticConfig(opts.config, { cwd });
  if (opts.dir) config.workspace = path.resolve(cwd, expandHome(opts.dir));
  if (opts.model) config.openai.model = opts.model;
  if (opts.maxContext) config.contextSize = Math.max(2000, Math.floor(opts.maxContext));
  if (opts.noStream) config.streaming = false;
  if (opts.agentsDir) config.agentsDir = path.resolve(cwd, expandHome(opts.agentsDir));

  const workspace = config.workspace || cwd;
  const agentsDir = resolveAgentsDir(config.agentsDir, workspace === cwd ? cwd : cwd);
  const { agents, errors } = loadAgents(agentsDir);
  for (const e of errors) console.error(s.yellow(`agent: ${e}`));
  if (opts.agentFile) {
    const one = loadAgentFile(path.resolve(cwd, expandHome(opts.agentFile)));
    if (!agents.some((a) => a.name === one.name)) agents.push(one);
    opts.agent = one.name;
  }
  if (opts.listAgents) {
    if (!agents.length) { console.log(`no agents in ${agentsDir} — create one (a .md file) or run: node agentic.mjs --init-agents ${path.relative(cwd, agentsDir) || 'agents'}`); return; }
    for (const a of agents) {
      console.log(`${a.name}  ${s.dim(`tools=${a.tools.builtins.join(',') || 'none'}${a.tools.mcp ? '+mcp' : ''}${a.tools.readOnly ? ' read-only' : ''}`)}`);
      if (a.description) console.log(`  ${s.dim(a.description)}`);
      console.log(`  ${s.dim(a.file)}`);
    }
    return;
  }
  if (!agents.length) {
    console.error(s.red(`no agents found in ${agentsDir}`));
    console.error(s.dim('create a .md agent file there, pass --agents <dir> / --agent-file <file>, or run: node agentic.mjs --init-agents'));
    process.exitCode = 1;
    return;
  }
  const wanted = opts.agent || config.agent;
  const startAgent = pickAgent(agents, wanted);
  if (wanted && startAgent.name.toLowerCase() !== String(wanted).toLowerCase()) {
    console.error(s.red(`agent "${wanted}" not found in ${agentsDir} — available: ${agents.map((a) => a.name).join(', ')}`));
    process.exitCode = 1;
    return;
  }

  const builtins = createTools({ ...config, workspace });
  const mcp = await connectMcpServers(config.mcp, { onLog: (level, msg) => console.error(level === 'error' ? s.red(msg) : s.dim(msg)) });
  const session = createSession({ config, builtins, mcp, agents, agent: startAgent });

  let prompt = opts.once || '';
  if (opts.promptFile) {
    const file = path.resolve(cwd, expandHome(opts.promptFile));
    const text = fs.readFileSync(file, 'utf8');
    prompt = prompt ? `${text}\n\n${prompt}` : text;
  }

  const runTurn = async (text) => {
    let streamed = false;
    const out = await session.turn(text, { onText: config.streaming ? (t) => { streamed = true; process.stdout.write(t); } : null });
    if (streamed) process.stdout.write('\n');
    // A stop notice is the harness's own text and was never streamed: print it
    // even when the model's earlier replies were.
    if (out.text && (!streamed || out.notice)) console.log(out.text);
    return out;
  };

  if (prompt) {
    try {
      const out = await runTurn(prompt);
      if (out.interrupted) process.exitCode = 130;
    } finally { mcp.closeAll(); }
    return;
  }

  // Interactive
  console.log(`${s.bold('agentic.mjs')}  ${s.dim(`model=${config.openai.model}  agent=${session.agent.name}  context=${fmtTokens(config.contextSize)}`)}`);
  console.log(`${s.dim('workspace:')} ${builtins.cwd}`);
  console.log(`${s.dim('agents:')}    ${agentsDir} ${s.dim(`(${agents.map((a) => a.name).join(', ')}) — /agent <name> switches`)}`);
  if (configPath) console.log(`${s.dim('config:')}    ${configPath}`);
  console.log(s.dim('type a task, /agents to list agents, /help for commands. Ctrl+C stops a turn.\n'));

  let lastInterruptAt = 0;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const onInterrupt = () => {
    const now = Date.now();
    const second = now - lastInterruptAt < 2000;
    lastInterruptAt = now;
    // A turn is running if a controller exists; session.cancel() is a no-op otherwise.
    session.cancel();
    if (second) { mcp.closeAll(); process.exit(0); }
    if (!process.stdin.isTTY) { /* piped input: one Ctrl+C from the process is a quit */ }
  };
  rl.on('SIGINT', onInterrupt);
  process.on('SIGINT', () => { if (!process.stdin.isTTY) { session.cancel(); mcp.closeAll(); process.exit(130); } });

  // 'line' events (not rl.question recursion) so piped stdin is processed
  // line by line too: each line is chained behind the previous turn, and the
  // prompt — which names the current agent — is redrawn after every one.
  const handleLine = async (line) => {
    const t = String(line || '').trim();
    try {
      if (t === '/quit' || t === '/exit') { rl.close(); return; }
      else if (t === '/help') console.log(HELP);
      else if (t === '/agents') {
        for (const a of agents) console.log(`${a === session.agent ? '*' : ' '} ${a.name}${a.description ? s.dim(` — ${a.description}`) : ''}`);
      } else if (t === '/agent' || t.startsWith('/agent ')) {
        const name = t.slice(6).trim();
        if (!name) console.log(`${session.agent.name}  ${s.dim(session.agent.file)}`);
        else {
          const next = agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
          if (!next) console.log(s.red(`no agent "${name}" — /agents lists them`));
          else { session.switchAgent(next); console.log(s.dim(`agent: ${next.name} (system prompt rebuilt, conversation kept)`)); }
        }
      } else if (t === '/tools') console.log(session.offeredTools().map((x) => x.name).join(', '));
      else if (t === '/config') {
        const masked = { ...config, openai: { ...config.openai, apiKey: config.openai.apiKey ? '(set)' : '(empty)' }, agentsDir, agent: session.agent.name, workspace: builtins.cwd };
        console.log(JSON.stringify(masked, null, 2));
      } else if (t === '/reset') { session.reset(); console.log(s.dim('conversation cleared')); }
      else if (t === '/compact') console.log(s.dim((await session.compact().catch((e) => { console.error(s.red(e.message)); return false; })) ? 'compacted' : 'nothing to compact'));
      else if (t) await runTurn(t);
    } catch (e) {
      console.error(s.red(e.stack || e.message));
    }
    rl.setPrompt(`${s.cyan(`${session.agent.name}>`)} `);
    rl.prompt();
  };
  let chain = Promise.resolve();
  rl.setPrompt(`${s.cyan(`${session.agent.name}>`)} `);
  rl.on('line', (line) => { chain = chain.then(() => handleLine(line)); });
  // Piped stdin hits EOF at once: let the queued lines/turns finish first.
  rl.on('close', async () => { await chain; mcp.closeAll(); process.exit(0); });
  rl.prompt();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => { console.error(s.red(e.stack || String(e))); process.exit(1); });
}
