/* Agent: single-session loop with tool calls and context trimming. */

import fs from 'node:fs';
import path from 'node:path';

import { chatCompletion, estimateTokens } from './llm.js';
import { shellInfo, expandHome } from './tools.js';
import * as ui from './ui.js';

const MAX_STEPS = 25;
const TOOL_RESULT_CAP = 20000; // chars of each tool result sent back to the model

/** Compact once the history reaches this share of the usable context budget. */
const COMPACT_RATIO = 0.8;
/** How many trailing messages to keep verbatim when compacting. */
const COMPACT_KEEP = 4;
/** Upper bound for the summary request itself. */
const SUMMARY_MAX_TOKENS = 1500;

/** Marker that identifies a compaction request (also used by the test mock server). */
export const COMPACT_TAG = '[coding-harness compaction request]';

const COMPACT_PROMPT = `${COMPACT_TAG}
Summarize this session so work can continue without the earlier messages.
Include:
- The user's current request (verbatim if it is short).
- Every file inspected or changed, and what changed.
- Commands run and their results, especially failures.
- Decisions, constraints, and anything still pending.
Be concise and factual, short bullet points, no preamble. Do not call tools.`;

const COMPACT_SUMMARY_PREFIX =
  'Earlier in this session (compacted summary — the raw messages were dropped to free context):';

/**
 * config.instructions is either literal text or the path to a text file — a
 * single-line value naming an existing file is read from disk (the file tools'
 * rules apply: `~` is expanded, relative paths resolve against the workspace).
 * It is resolved on every system-prompt rebuild, so editing the file or running
 * /set dir takes effect without restarting.
 */
export function resolveInstructions(instructions, cwd) {
  const text = String(instructions ?? '').trim();
  if (!text) return '';
  if (!text.includes('\n')) {
    try {
      const file = path.resolve(cwd, expandHome(text));
      if (fs.statSync(file).isFile()) return fs.readFileSync(file, 'utf8').trim();
    } catch {
      /* not a readable file — treat the value as literal text */
    }
  }
  return text;
}

export function createAgent({ config, builtins, mcp }) {
  const history = [];

  let warnedAboutContext = false; // only nudge once per context spike

  const stats = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    generatedMs: 0,
    generatedTokens: 0,
    compactions: 0,
    estimated: false, // true when any call had no usage data and was estimated
  };

  const allTools = () => [...builtins.listTools(), ...(mcp ? mcp.listTools() : [])];

  const contextBudget = () => Math.max(2000, config.contextSize - config.maxTokens);

  function systemPrompt() {
    const lines = [
      'You are coding-harness, a coding agent running in the user\'s terminal. You help with software tasks using the tools below.',
      '',
      `Workspace (cwd): ${builtins.cwd}`,
      `Platform: ${shellInfo(config)}`,
      `Today: ${new Date().toISOString().slice(0, 10)}`,
      '',
      'Tool policy:',
      '- Inspect with read_file / list_dir / search_files, make changes with write_file / edit_file, and use run_command for builds, tests, git and everything else.',
      '- edit_file replaces exact old_text copied from read_file output. Line endings are normalized for you (a CRLF file matches LF old_text and is written back as CRLF), so only spacing and wording must match.',
      '- run_command goes through the platform shell above: write commands valid on that OS (no bash-isms under Windows cmd.exe, etc.) and use its cwd/timeout options instead of cd-ing and sleeping.',
      '- Commands run with the user\'s own permissions: say what a destructive step (deleting files, force-pushing, dropping data) will do before running it, and never print API keys or other secrets.',
      '',
      'Work method:',
      '- Understand before changing: infer the project type (language, framework, libraries) from its files, locate the code a change touches with search_files, and read it with read_file. Never guess at how something is wired.',
      '- Batch independent work: several tool calls in one reply are executed in order, so read the files a change touches together, and chain shell steps with && rather than spending a run_command on each.',
      '- Prefer a few meaningful reads over many tiny ones: small files in full, large files by window (offset/limit) once you know where the interesting lines are.',
      '- Change code with edit_file and old_text copied verbatim from read_file; use write_file for new files or full rewrites only, and never rewrite a file you have not read.',
      '- Match the code you are editing — same language level, indentation, naming, dependency style — and prefer a well-known library (installed with the project\'s package manager) over hand-rolling one.',
      '- Tool output can be windowed or truncated ("lines 12-40 of 900", "[truncated …]"): read the real content before editing it or drawing conclusions, and never edit around a marker.',
      '- Do not repeat yourself: never re-read a file you just wrote, never re-run a command that already succeeded, and if the same fix fails twice, stop and report the blocker, the exact error and the options you see instead of trying a third variation.',
      '- Verify before claiming success: run the build / tests / linters after changing code, read the output and fix failures in the same turn. If you could not verify something, say so.',
      '- Keep the user oriented: one line on what you are about to do, then do it; when finished, say what changed and how it was verified.',
      '',
      'Reply in concise Markdown (bullets, `inline code`, fenced code) — it is rendered in the terminal. When the task is done, say so briefly.',
    ];

    const extra = resolveInstructions(config.instructions, builtins.cwd);
    if (extra) {
      lines.push(
        '',
        'User instructions (config "instructions" — they take precedence over the defaults above when they conflict):',
        extra
      );
    }
    return lines.join('\n');
  }

  function reset() {
    history.length = 0;
    history.push({ role: 'system', content: systemPrompt() });
  }
  reset();

  /**
   * Rebuild the system message in place — used when the workspace changes mid-session.
   * An optional `note` is appended as a system message so an in-flight conversation
   * also sees the change (the model may not re-read the system prompt closely).
   */
  function refreshSystem(note) {
    if (history.length && history[0].role === 'system') history[0].content = systemPrompt();
    else reset();
    if (note && history.length > 1) history.push({ role: 'system', content: note });
  }

  /**
   * Trailing messages that can be replayed on their own after a compaction:
   * never an orphaned tool result, and never an assistant message whose tool
   * results would be left behind.
   */
  function safeTail(limit = COMPACT_KEEP) {
    const tail = [];
    for (let i = history.length - 1; i >= 1 && tail.length < limit; i--) {
      const m = history[i];
      if (m.role === 'tool') break;
      if (m.role === 'assistant' && m.tool_calls?.length) break;
      tail.unshift(m);
      if (m.role === 'user') break;
    }
    return tail;
  }

  /**
   * Summarize the conversation into a single message and drop the raw history.
   * Runs automatically before the context fills up (so a turn just continues),
   * or on demand via the /compact command.
   */
  async function compact({ manual = false, reason = '' } = {}) {
    if (history.length <= 2) {
      if (manual) ui.printSystem('nothing to compact yet — the conversation is still empty');
      return null;
    }
    const before = estimateTokens(history);
    const tail = safeTail();
    const spinner = ui.spinner(manual ? 'compacting conversation…' : 'compacting conversation to free context…');

    let summary = '';
    try {
      const res = await chatCompletion({
        config,
        messages: [...history, { role: 'user', content: COMPACT_PROMPT }],
        tools: [],
        maxTokens: Math.max(256, Math.min(SUMMARY_MAX_TOKENS, Math.round(config.contextSize * 0.05))),
      });
      summary = (res.message?.content || '').trim();
      accountUsage(res, [...history, { role: 'user', content: COMPACT_PROMPT }], res.message);
    } catch (e) {
      spinner.stop();
      ui.printError(`compaction failed: ${e.message}`);
      ui.printSystem('falling back to dropping the oldest turns');
      trimHistory();
      return null;
    }
    spinner.stop();

    if (!summary) {
      if (manual) ui.printSystem('compaction produced an empty summary — history kept as is');
      return null;
    }

    const systemMsg = history[0];
    const rebuilt = [systemMsg, { role: 'user', content: `${COMPACT_SUMMARY_PREFIX}\n${summary}` }];
    let after = estimateTokens(rebuilt) + estimateTokens(tail);
    if (after > contextBudget()) {
      // pathological: even the summary does not fit — keep the summary alone
      after = estimateTokens(rebuilt);
    } else {
      rebuilt.push(...tail);
    }
    history.length = 0;
    history.push(...rebuilt);
    stats.compactions++;

    ui.printSystem(
      `compacted conversation${reason ? ` (${reason})` : ''}: ${ui.fmtTokens(before)} → ${ui.fmtTokens(after)} tokens`
    );
    return { before, after };
  }

  /** Compact automatically when the history approaches the context budget. */
  async function maybeCompact() {
    const used = estimateTokens(history);
    const budget = contextBudget();
    const pct = Math.round((used / Math.max(1, config.contextSize)) * 100);
    if (used < budget * COMPACT_RATIO || history.length <= 2) {
      warnedAboutContext = false;
      return;
    }
    if (config.autoCompact === false) {
      if (!warnedAboutContext) {
        warnedAboutContext = true;
        ui.printSystem(`context ${pct}% full — run /compact to summarize, otherwise the oldest turns get dropped`);
      }
      return;
    }
    await compact({ reason: `context ${pct}% full` });
  }

  /** Record token usage for one call (uses server numbers, falls back to estimates). */
  function accountUsage(result, messages, message) {
    const u = result.usage;
    const reported = u && (u.prompt_tokens != null || u.completion_tokens != null || u.total_tokens != null);
    const prompt = reported ? Number(u.prompt_tokens ?? 0) : estimateTokens(messages);
    const completion = reported
      ? Number(u.completion_tokens ?? u.total_tokens ?? 0)
      : estimateTokens([message].filter(Boolean));
    if (!reported) stats.estimated = true;

    stats.calls++;
    stats.promptTokens += prompt;
    stats.completionTokens += completion;
    stats.generatedTokens += completion;
    stats.generatedMs += Math.max(1, result.ttftMs != null ? Math.max(1, result.elapsedMs - result.ttftMs) : result.elapsedMs);
    return { prompt, completion, reported, stats };
  }

  /** Drop oldest user-turn units until the estimated size fits the context budget. */
  function trimHistory() {
    const budget = Math.max(2000, config.contextSize - config.maxTokens);
    const units = [];
    let cur = null;
    for (const m of history.slice(1)) {
      if (m.role === 'user' || !cur) {
        cur = [];
        units.push(cur);
      }
      cur.push(m);
    }
    let total = estimateTokens(history);
    while (total > budget && units.length > 1) {
      total -= estimateTokens(units.shift());
    }
    const rebuilt = [history[0], ...units.flat()];
    history.length = 0;
    history.push(...rebuilt);
  }

  async function executeOne(tc) {
    const name = tc.function?.name || tc.name || '';
    const rawArgs = tc.function?.arguments ?? '';
    let args = {};
    if (rawArgs) {
      try {
        args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
      } catch (e) {
        return `Error: tool arguments were not valid JSON: ${e.message}`;
      }
    }
    let result;
    try {
      if (mcp && mcp.has(name)) result = await mcp.call(name, args);
      else result = await builtins.execute(name, args);
    } catch (e) {
      result = `Error: ${e.message}`;
    }
    result = String(result ?? '(no output)');
    if (result.length > TOOL_RESULT_CAP) {
      result = result.slice(0, TOOL_RESULT_CAP) + `\n… [truncated, ${result.length - TOOL_RESULT_CAP} more chars]`;
    }
    return result;
  }

  /** Run one user turn to completion (may involve several tool round-trips). */
  async function turn(userText) {
    history.push({ role: 'user', content: userText });
    // compact first: better to summarize the old turns than to drop them
    await maybeCompact();
    trimHistory();

    for (let step = 0; step < MAX_STEPS; step++) {
      // free room before we run out of context, then keep going
      await maybeCompact();

      const maxOut = Math.max(
        256,
        Math.min(config.maxTokens, config.contextSize - estimateTokens(history))
      );

      const renderer = ui.assistantHeader();
      // shown from the moment the request goes out until the first token
      // (streaming) or the reply arrives (non-streaming)
      const waiting = ui.spinner('thinking…');
      let result;
      try {
        result = await chatCompletion({
          config,
          messages: history,
          tools: allTools(),
          maxTokens: maxOut,
          onDelta: config.streaming
            ? (t) => {
                waiting.stop();
                renderer.push(t);
              }
            : null,
        });
      } catch (e) {
        waiting.stop();
        renderer.end();
        ui.printError(e.message);
        ui.printSystem('History is intact — say "continue" or retry after fixing the issue.');
        return;
      }
      waiting.stop();
      const msg = result.message;
      if (!config.streaming && msg.content) renderer.push(msg.content);
      renderer.end();

      const usage = accountUsage(result, history, msg);
      const genMs = Math.max(1, result.ttftMs != null ? Math.max(1, result.elapsedMs - result.ttftMs) : result.elapsedMs);
      ui.printUsage({
        prompt: usage.prompt,
        completion: usage.completion,
        tokPerSec: usage.completion / (genMs / 1000),
        elapsedMs: result.elapsedMs,
        session: stats.promptTokens + stats.completionTokens,
        contextPct: (estimateTokens(history) / Math.max(1, config.contextSize)) * 100,
        estimated: !usage.reported,
      });

      history.push(msg);

      const toolCalls = msg.tool_calls || [];
      if (!toolCalls.length) return;

      for (const tc of toolCalls) {
        const name = tc.function?.name || '(unknown)';
        ui.printToolCall(name, tc.function?.arguments || '{}');
        const sp = ui.spinner(`running ${name}…`);
        const result = await executeOne(tc);
        sp.stop();
        ui.printToolResult(result);
        history.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      trimHistory();
    }

    ui.printSystem(`Reached the step limit (${MAX_STEPS}). Say "continue" to keep going.`);
  }

  return {
    turn,
    reset,
    refreshSystem,
    compact,
    history,
    tools: allTools,
    /** Live session counters for the /usage command. */
    stats: () => ({
      ...stats,
      used: estimateTokens(history),
      contextSize: config.contextSize,
      avgTokPerSec: stats.generatedMs > 0 ? stats.generatedTokens / (stats.generatedMs / 1000) : null,
    }),
  };
}
