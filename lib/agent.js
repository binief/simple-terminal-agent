/* Agent: single-session loop with tool calls and context trimming. */

import { chatCompletion, estimateTokens } from './llm.js';
import { shellInfo } from './tools.js';
import * as ui from './ui.js';

const MAX_STEPS = 25;
const TOOL_RESULT_CAP = 20000; // chars of each tool result sent back to the model

export function createAgent({ config, builtins, mcp }) {
  const history = [];

  const allTools = () => [...builtins.listTools(), ...(mcp ? mcp.listTools() : [])];

  function systemPrompt() {
    return [
      'You are coding-harness, a coding agent running in the user\'s terminal. You help with software tasks using the tools below.',
      '',
      `Workspace (cwd): ${builtins.cwd}`,
      `Platform: ${shellInfo(config)}`,
      `Today: ${new Date().toISOString().slice(0, 10)}`,
      '',
      'Tool policy:',
      '- Inspect with read_file / list_dir / search_files before changing anything.',
      '- Make changes with write_file / edit_file. edit_file needs old_text copied exactly from read_file output (whitespace included).',
      '- Use run_command for builds, tests, git and anything else. It runs through the platform shell above, so write commands valid on that OS (no bash-isms under Windows cmd.exe, etc.).',
      '- Prefer small, verifiable steps and verify after edits when useful.',
      '- Tool results can be truncated; ask for narrower reads if that happens.',
      '',
      'Reply in concise Markdown. When the task is done, say so briefly.',
    ].join('\n');
  }

  function reset() {
    history.length = 0;
    history.push({ role: 'system', content: systemPrompt() });
  }
  reset();

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
    trimHistory();

    for (let step = 0; step < MAX_STEPS; step++) {
      const maxOut = Math.max(
        256,
        Math.min(config.maxTokens, config.contextSize - estimateTokens(history))
      );

      const renderer = ui.assistantHeader();
      const waiting = config.streaming ? null : ui.spinner('thinking…');
      let msg;
      try {
        msg = await chatCompletion({
          config,
          messages: history,
          tools: allTools(),
          maxTokens: maxOut,
          onDelta: config.streaming ? (t) => renderer.push(t) : null,
        });
      } catch (e) {
        waiting?.stop();
        renderer.end();
        ui.printError(e.message);
        ui.printSystem('History is intact — say "continue" or retry after fixing the issue.');
        return;
      }
      waiting?.stop();
      if (!config.streaming && msg.content) renderer.push(msg.content);
      renderer.end();

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
    history,
    tools: allTools,
  };
}
