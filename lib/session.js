/* Saving and loading a chat.
 *
 * A session is one conversation. When the process exits it is gone, which is
 * fine for a quick question and annoying for anything that took an hour:
 * the model's understanding of the codebase — the files it read, the test
 * output it saw, the dead ends it already ruled out — is exactly the context
 * this harness spends the rest of its effort protecting, and closing the
 * terminal throws all of it away.
 *
 * So /save writes the conversation to a JSON file and /load reads it back.
 *
 * The one real design question is what to do with the system prompt. It is
 * message 0 of every history, and it describes a *moment*: this working
 * directory, this git branch, today's date, this mode, this delegation
 * setting. Replaying a stored one would quietly tell the model it is somewhere
 * it is not. So the file keeps it (it is a faithful record, and useful when
 * reading an export by hand) but /load discards it and rebuilds the prompt for
 * the environment the harness is actually in. Everything the conversation
 * learned is restored; nothing it assumed about the world is.
 *
 * The format is plain JSON with a version field. v1 — written by earlier
 * versions as `/export` — had only `messages`, and still loads.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expandHome } from './tools.js';
import { BUILD_MODE, PLAN_MODE } from './plan.js';

/** Identifies our files, so /load refuses a JSON file that is not a chat. */
export const SESSION_FORMAT = 'coding-harness-chat';

/** v1: messages only (legacy /export). v2: plan, mode and counters too. */
export const SESSION_VERSION = 2;

/** Where a bare name like `/save refactor` is stored. */
export function sessionDir() {
  return path.join(os.homedir(), '.coding-harness', 'chats');
}

/** Roles a chat history may contain — anything else means the file is not ours. */
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * Turn a title into something safe for a filename: lowercase, words joined by
 * dashes, no path separators or characters Windows objects to.
 */
export function slugify(text, max = 40) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return slug || 'chat';
}

/** `2026-10-01T14:32:…` -> `2026-10-01-1432`, in local time. */
function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

/**
 * Decide where `/save <arg>` writes.
 *
 * An argument that looks like a path (absolute, `~/…`, or containing a
 * separator or a `.json` suffix) is taken literally and resolved against the
 * workspace. A bare word is a name in the chats directory. Nothing at all gets
 * a name from the conversation's first line plus a timestamp, so repeated
 * saves do not silently overwrite each other.
 */
export function resolveSessionPath(arg, { cwd = process.cwd(), dir = sessionDir(), title = '' } = {}) {
  const raw = String(arg ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
  if (!raw) return path.join(dir, `${slugify(title)}-${stamp()}.json`);
  const expanded = expandHome(raw);
  const looksLikePath = path.isAbsolute(expanded) || /[\\/]/.test(expanded) || /\.json$/i.test(expanded);
  if (looksLikePath) {
    const abs = path.resolve(cwd, expanded);
    return /\.json$/i.test(abs) ? abs : `${abs}.json`;
  }
  return path.join(dir, `${slugify(expanded)}.json`);
}

/**
 * Where `/load <arg>` reads from. Same rules, except a bare name is also tried
 * as-is in the workspace, so `/load notes.json` works from either place and
 * `/load` on a name saved earlier does not need the full path.
 *
 * Returns `{ file, found, searched }`. When nothing matched, `file` is the most
 * obvious candidate and `searched` is every path tried — the error is then able
 * to say where it looked, which is the difference between a useful message and
 * "no such file" for a name the user is sure they saved.
 */
export function resolveLoadPath(arg, { cwd = process.cwd(), dir = sessionDir() } = {}) {
  const raw = String(arg ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
  if (!raw) return { file: null, found: false, searched: [] };
  const expanded = expandHome(raw);
  const candidates = [];
  if (path.isAbsolute(expanded)) {
    candidates.push(expanded, `${expanded}.json`);
  } else {
    candidates.push(path.resolve(cwd, expanded), `${path.resolve(cwd, expanded)}.json`);
    candidates.push(path.join(dir, expanded), path.join(dir, `${expanded}.json`));
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return { file: c, found: true, searched: candidates };
    } catch {
      /* keep looking */
    }
  }
  return { file: candidates[0], found: false, searched: candidates };
}

/** The first thing the user asked, used as a title in listings and filenames. */
export function sessionTitle(messages, max = 60) {
  const first = (messages || []).find((m) => m.role === 'user' && String(m.content ?? '').trim());
  const text = String(first?.content ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Everything worth writing down about the session, ready to be serialized. */
export function buildSession({ messages, plan, delegation, promptStyle, model, workspace, stats, harnessVersion }) {
  const list = Array.isArray(messages) ? messages : [];
  return {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    savedAt: new Date().toISOString(),
    harnessVersion: harnessVersion ?? null,
    title: sessionTitle(list),
    // context, not instructions: /load reports a mismatch rather than acting on it
    workspace: workspace ?? null,
    model: model ?? null,
    promptStyle: promptStyle ?? null,
    delegation: delegation ?? null,
    mode: plan?.mode ?? BUILD_MODE,
    plan: { proposed: plan?.proposed ?? null, approved: plan?.approved ?? null },
    stats: stats ?? null,
    messages: list,
  };
}

/** Serialize + write, creating the directory. Returns the path written. */
export function saveSession(file, session) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file); // never leave a half-written chat behind
  return file;
}

/**
 * Read and validate a chat file. Throws with a reason the user can act on.
 * Returns the session normalized to the current shape, whatever version wrote it.
 *
 * `target` is a path, or the `{ file, searched }` resolveLoadPath() returned.
 */
export function loadSession(target) {
  const file = typeof target === 'string' ? target : target?.file;
  const searched = (typeof target === 'object' && target?.searched) || [];
  if (!file) throw new Error('no chat file given');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`${path.basename(file)} is not readable JSON (${e.message})`);
    const looked = searched.length > 1 ? `\n    looked in: ${searched.join('\n               ')}` : '';
    throw new Error(`no such chat: ${file}${looked}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${path.basename(file)} is not a chat export`);
  if (data.format !== SESSION_FORMAT) throw new Error(`${path.basename(file)} is not a chat export (format: ${data.format ?? 'missing'})`);
  if (!Array.isArray(data.messages) || !data.messages.length) throw new Error(`${path.basename(file)} has no messages`);
  for (const [i, m] of data.messages.entries()) {
    if (!m || typeof m !== 'object' || !ROLES.has(m.role)) {
      throw new Error(`${path.basename(file)}: message ${i} has an unknown role (${m?.role ?? 'missing'})`);
    }
  }
  const mode = data.mode === PLAN_MODE ? PLAN_MODE : BUILD_MODE;
  return {
    format: data.format,
    version: Number(data.version) || 1,
    savedAt: data.savedAt ?? null,
    harnessVersion: data.harnessVersion ?? null,
    title: data.title || sessionTitle(data.messages),
    workspace: data.workspace ?? null,
    model: data.model ?? null,
    promptStyle: data.promptStyle ?? null,
    delegation: data.delegation ?? null,
    mode,
    plan: { proposed: data.plan?.proposed ?? null, approved: data.plan?.approved ?? null },
    stats: data.stats ?? null,
    messages: data.messages,
    /** The turns, without the stored system prompt — what /load actually restores. */
    conversation: data.messages.filter((m) => m.role !== 'system'),
  };
}

/**
 * Saved chats, newest first, for `/chats`. Unreadable or foreign JSON files in
 * the directory are skipped rather than reported: it is a listing, not a check.
 */
export function listSessions(dir = sessionDir()) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data?.format !== SESSION_FORMAT || !Array.isArray(data.messages)) continue;
      out.push({
        name: name.replace(/\.json$/i, ''),
        file,
        title: data.title || sessionTitle(data.messages),
        savedAt: data.savedAt ?? null,
        turns: data.messages.filter((m) => m.role === 'user').length,
        messages: data.messages.length,
        bytes: fs.statSync(file).size,
      });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => String(b.savedAt ?? '').localeCompare(String(a.savedAt ?? '')));
}
