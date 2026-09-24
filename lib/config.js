/* Config: loaded from a common path (~/.coding-harness/config.json) by default. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.coding-harness', 'config.json');

export const DEFAULT_CONFIG = {
  _readme:
    'coding-harness configuration. baseURL must include the API root (e.g. .../v1 for OpenAI-compatible servers). ' +
    'Env overrides: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL, HARNESS_STREAMING, HARNESS_CONTEXT_SIZE, HARNESS_TEMPERATURE, ' +
    'HARNESS_INSTRUCTIONS.',
  openai: {
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'sk-REPLACE_ME',
    model: 'gpt-4o-mini',
  },
  contextSize: 64000,
  maxTokens: 4096,
  temperature: 0.2,
  streaming: true,
  workspace: null,
  shell: null,
  lineEndings: 'auto',
  instructions: null,
  autoCompact: true,
  commandTimeout: 60,
  mcp: {
    servers: {},
  },
};

/** Accepted `lineEndings` values (with friendly aliases) — see resolveEol() in tools.js. */
const LINE_ENDING_ALIASES = {
  auto: 'auto',
  lf: 'lf',
  unix: 'lf',
  crlf: 'crlf',
  win: 'crlf',
  windows: 'crlf',
  cr: 'cr',
  mac: 'cr',
  native: 'native',
  os: 'native',
  system: 'native',
};

function deepMerge(base, raw) {
  const out = { ...base, ...(raw || {}) };
  out.openai = { ...base.openai, ...(raw?.openai || {}) };
  out.mcp = { servers: {}, ...(raw?.mcp || {}) };
  out.mcp.servers = raw?.mcp?.servers || {};
  return out;
}

function truthy(v) {
  return ['1', 'true', 'on', 'yes'].includes(String(v).toLowerCase());
}

function applyEnvOverrides(cfg) {
  if (process.env.OPENAI_BASE_URL) cfg.openai.baseURL = process.env.OPENAI_BASE_URL;
  if (process.env.OPENAI_API_KEY) cfg.openai.apiKey = process.env.OPENAI_API_KEY;
  if (process.env.OPENAI_MODEL) cfg.openai.model = process.env.OPENAI_MODEL;
  if (process.env.HARNESS_STREAMING !== undefined) cfg.streaming = truthy(process.env.HARNESS_STREAMING);
  if (process.env.HARNESS_CONTEXT_SIZE) cfg.contextSize = Number(process.env.HARNESS_CONTEXT_SIZE);
  if (process.env.HARNESS_TEMPERATURE) cfg.temperature = Number(process.env.HARNESS_TEMPERATURE);
  if (process.env.HARNESS_INSTRUCTIONS) cfg.instructions = process.env.HARNESS_INSTRUCTIONS;
}

function validate(cfg) {
  if (!cfg.openai || typeof cfg.openai.baseURL !== 'string' || !cfg.openai.baseURL) {
    throw new Error('config error: openai.baseURL must be a non-empty string');
  }
  if (typeof cfg.openai.model !== 'string' || !cfg.openai.model) {
    throw new Error('config error: openai.model is required');
  }
  cfg.contextSize = Number(cfg.contextSize) || DEFAULT_CONFIG.contextSize;
  cfg.maxTokens = Number(cfg.maxTokens) || DEFAULT_CONFIG.maxTokens;
  cfg.temperature = Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : DEFAULT_CONFIG.temperature;
  cfg.commandTimeout = Number(cfg.commandTimeout) || DEFAULT_CONFIG.commandTimeout;
  cfg.streaming = Boolean(cfg.streaming);
  cfg.lineEndings = LINE_ENDING_ALIASES[String(cfg.lineEndings ?? 'auto').trim().toLowerCase()] || 'auto';
  cfg.instructions =
    cfg.instructions == null || String(cfg.instructions).trim() === '' ? null : String(cfg.instructions).trim();
  cfg.autoCompact = cfg.autoCompact !== false;
  if (cfg.contextSize < 2000) cfg.contextSize = 2000;
  if (cfg.maxTokens < 256) cfg.maxTokens = 256;
  if (!cfg.mcp || typeof cfg.mcp !== 'object') cfg.mcp = { servers: {} };
  if (!cfg.mcp.servers || typeof cfg.mcp.servers !== 'object') cfg.mcp.servers = {};
  return cfg;
}

/** Create the config file with defaults if it does not exist. */
export function ensureConfig(configPath) {
  const exists = fs.existsSync(configPath);
  if (!exists) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
  }
  return { created: !exists };
}

/**
 * Load config from `configPath` (default: ~/.coding-harness/config.json),
 * apply env + CLI overrides, and validate.
 */
export function loadConfig(configPath = DEFAULT_CONFIG_PATH, overrides = {}) {
  const { created } = ensureConfig(configPath);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`failed to parse ${configPath}: ${e.message}`);
  }
  const cfg = validate(deepMerge(DEFAULT_CONFIG, raw));
  applyEnvOverrides(cfg);
  if (overrides.streaming !== undefined) cfg.streaming = Boolean(overrides.streaming);
  if (overrides.model) cfg.openai.model = overrides.model;
  validate(cfg);
  return { config: cfg, path: configPath, created };
}

/** Masked view of the config for display (/config command). */
export function maskConfig(cfg) {
  const key = String(cfg.openai.apiKey ?? '');
  const masked = key.length > 8 ? key.slice(0, 4) + '…' + key.slice(-2) : key ? '(set)' : '(empty)';
  const oneLine = (v, n = 100) => {
    const t = String(v ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  };
  return {
    openai: { baseURL: cfg.openai.baseURL, model: cfg.openai.model, apiKey: masked },
    contextSize: cfg.contextSize,
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
    streaming: cfg.streaming,
    workspace: cfg.workspace,
    shell: cfg.shell,
    lineEndings: cfg.lineEndings,
    instructions: cfg.instructions ? oneLine(cfg.instructions) : null,
    autoCompact: cfg.autoCompact,
    commandTimeout: cfg.commandTimeout,
    mcp: {
      servers: Object.fromEntries(
        Object.entries(cfg.mcp.servers).map(([name, srv]) => [
          name,
          { command: srv.command, args: srv.args || [], env: Object.keys(srv.env || {}) },
        ])
      ),
    },
  };
}
