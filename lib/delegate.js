/* Delegation: run part of a task in a context that is thrown away afterwards.
 *
 * The problem it solves is not capability, it is signal. A long task spends
 * most of its tokens on things that mattered for five seconds: directory
 * listings, the three greps before the right one, a 400-line test log, the
 * edit that did not apply. All of it stays in the conversation and is re-sent
 * on every subsequent request, and model accuracy falls as the window fills,
 * even when every token in it is technically relevant.
 *
 * So the noisy half runs somewhere else. `delegate` starts a second agent with
 * an empty history, its own short system prompt and a pruned tool list. It
 * works, it writes one report, and its context is dropped. The caller never
 * sees the file reads, the commands or the dead ends — only the report.
 *
 * Two kinds, because they need different tools and different output:
 *   researcher  read-only; answers a question about the codebase
 *   coder       implements one atomic step and verifies it
 *
 * Subagents cannot delegate (a flat hierarchy is the only kind worth
 * debugging) and cannot present a plan. They get the built-in tools only —
 * MCP servers stay with the agent the user configured them for.
 *
 * The whole thing is off unless config.delegation says otherwise, so a default
 * session is exactly the single-agent harness it was before.
 */

import { chatCompletion, estimateTokens } from './llm.js';
import * as ui from './ui.js';

/** config.delegation values. */
export const DELEGATION_MODES = ['off', 'optional', 'enforced'];

const DELEGATION_ALIASES = {
  off: 'off',
  false: 'off',
  no: 'off',
  none: 'off',
  optional: 'optional',
  on: 'optional',
  true: 'optional',
  auto: 'optional',
  enforced: 'enforced',
  strict: 'enforced',
  required: 'enforced',
  always: 'enforced',
};

/** Canonical delegation mode; anything unknown is "off". */
export function normalizeDelegation(value) {
  return DELEGATION_ALIASES[String(value ?? '').trim().toLowerCase()] || 'off';
}

/** Tools a subagent never gets, whatever its type. */
export const SUBAGENT_EXCLUDED = ['delegate', 'present_plan'];

/** Fallback step budget for one subagent run. */
export const DEFAULT_SUBAGENT_MAX_STEPS = 25;

/** Tools the main agent loses in enforced mode — every change goes through a coder. */
export const ENFORCED_MAIN_EXCLUDED = ['write_file', 'edit_file'];

/* ------------------------------------------------------------------ */
/* Subagent prompts                                                    */
/* ------------------------------------------------------------------ */

/* Short on purpose. A subagent has one task, no history and no user to talk
 * to, so most of the main prompt is dead weight for it — and the report
 * format is the part that actually has to be right, because it is the only
 * thing that survives. */

const RESEARCHER = `You are a research subagent. The agent running the task gave you one question about this codebase. Answer it — that is the whole job.

# How to work
- Locate with search_files, then read that window with read_file. Issue independent searches and reads in one reply.
- Follow the code that actually runs: the implementation, its callers, the tests, the build and config files. Conventions matter as much as behaviour.
- Never report a path, symbol, signature or line number you did not read. No guesses, no plausible-sounding APIs.
- You cannot change anything: write_file and edit_file are not available, and run_command only accepts commands that change nothing.
- Do not design the change or propose a plan — the caller does that, and it has context you do not.

# Your report
Finish with one message and no tool calls. It is the only thing the caller sees, so it has to stand on its own:
- **Answer** — the direct answer, first, in a few lines.
- **Files** — \`path/to/file.js:42\` for each place that matters, one line each on what is there.
- **How it works** — the flow, conventions and constraints the caller needs to make a decision.
- **Watch out** — surprises, inconsistencies, anything contradicting the premise of the question.
- **Unknowns** — what you could not establish, and where you would look next.
Dense and specific. Skip a heading with nothing under it. No preamble.`;

const CODER = `You are a coding subagent. The agent running the task gave you one atomic step. Implement exactly that step and report back.

# How to work
- Read a file before you change it. Copy old_text verbatim from read_file; prefer several small edits to one rewrite.
- Match the surrounding code — its conventions beat your preferences. No TODOs, no placeholders, no drive-by refactors.
- Stay inside the step. If you find an unrelated bug or a second thing that needs doing, leave it alone and name it in your report.
- Verify what you changed: run the narrowest relevant check, read the output, and fix regressions you caused.
- If the step is wrong, impossible, or depends on a decision you were not given: stop and report it. Do not redesign it, and do not substitute a different change.

# Your report
Finish with one message and no tool calls. The caller sees nothing else — not the files you read, not the commands you ran, not the attempts that failed:
- **Done** — what you changed, grouped by file, one line each.
- **Verified** — the exact command you ran and what it said: passed, or the real error.
- **Deviated** — anything you did differently from the step, and why.
- **Blocked** — what stopped you, the exact error, and the options as you see them.
Skip a heading with nothing under it. No preamble, no summary of the step you were given.`;

/** The two subagent types, keyed by the value the model passes as `agent`. */
export const SUBAGENTS = {
  researcher: {
    name: 'researcher',
    readOnly: true,
    summary: 'read-only; answers a question about the codebase',
    prompt: RESEARCHER,
  },
  coder: {
    name: 'coder',
    readOnly: false,
    summary: 'implements one atomic step and verifies it',
    prompt: CODER,
  },
};

/** System message for a subagent: its role, then the live environment. */
export function subagentPrompt(type, { cwd, platform, date = new Date().toISOString().slice(0, 10), instructions = '' } = {}) {
  const spec = SUBAGENTS[type];
  if (!spec) throw new Error(`unknown subagent type "${type}"`);
  const env = [
    '# Environment',
    `- Workspace (cwd): ${cwd}`,
    `- Platform: ${platform}`,
    `- Today: ${date}`,
    `- You are a subagent: no user is reading this, and this context is discarded when you finish.`,
  ].join('\n');
  const extra = String(instructions ?? '').trim();
  return [spec.prompt, env, extra ? `# Project instructions\n${extra}` : ''].filter(Boolean).join('\n\n');
}

/** The brief the subagent is started with, assembled from the caller's arguments. */
export function subagentBrief({ goal, files = [], context = '' }) {
  const parts = [`# Task\n${String(goal ?? '').trim()}`];
  const list = (Array.isArray(files) ? files : [files]).map((f) => String(f ?? '').trim()).filter(Boolean);
  if (list.length) {
    parts.push(`# Start from these files\n${list.map((f) => `- ${f}`).join('\n')}\nVerify them yourself — the caller may be wrong about where things are.`);
  }
  const known = String(context ?? '').trim();
  if (known) parts.push(`# What the caller already established\n${known}`);
  parts.push('Work through it, then reply with your report in the format above.');
  return parts.join('\n\n');
}

/**
 * System-prompt block for the agent that can delegate. Appended after the
 * environment, so turning delegation on changes the tail of the prompt and
 * not the cached prefix.
 */
export function delegationBlock(mode) {
  if (mode === 'enforced') {
    return [
      '# Delegation (enforced)',
      'You plan and verify; subagents do the work. write_file and edit_file are not available to you — every change to the project goes through a coder subagent, and there is no way around that.',
      '- Decompose the task into atomic steps first, each one file or one coherent change, each verifiable on its own.',
      '- One delegate call per step. Never hand a subagent several steps or a whole plan.',
      '- Write each brief so it stands alone: the goal, the files involved, the conventions to follow, and what done means. The subagent cannot see this conversation.',
      '- Read the report, check the result yourself (read_file, run_command, the tests), then move to the next step. A report is a claim, not proof.',
      '- Use a researcher instead of exploring broadly yourself: its greps and file reads stay out of this context, which is the point.',
      '- You keep read_file, list_dir, search_files and run_command — use them to verify and to answer small questions, not to do the work.',
    ].join('\n');
  }
  return [
    '# Delegation',
    'You can run part of a task in a subagent with its own, discarded context (the delegate tool). You see only its report.',
    '- Delegate the work whose output you do not need to keep: broad exploration of unfamiliar code, and self-contained implementation steps with their test runs.',
    '- Do the small and cheap things yourself. A single read, a one-line edit or a quick check is not worth a subagent.',
    '- One step per call, and write the brief for someone who has never seen this repository — it cannot see this conversation.',
    '- Check what comes back before building on it: a report is a claim, not proof.',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* The tool                                                            */
/* ------------------------------------------------------------------ */

const DESCRIPTION = [
  'Run part of this task in a separate agent that has its own empty context.',
  'It sees only the brief you write here — not this conversation — and you see only its final report:',
  'the files it read, the commands it ran and the attempts that failed never enter your context.',
  '',
  'Use it for the parts of a task whose output you do not need to keep:',
  '- researcher — a read-only question about the codebase ("where is auth handled, and what calls it?").',
  '- coder — ONE atomic step, implemented and verified ("in lib/x.js replace the retry loop with …, then run npm test").',
  '',
  'Write the brief for someone who has never seen this repository: the goal, the files you already know are involved,',
  'the constraints and conventions that apply, and what "done" means. Everything you leave out, it has to rediscover.',
  'One step per call — never pass a whole plan. Do the small, cheap things yourself.',
].join('\n');

/**
 * Build the `delegate` tool. It needs the model client, so it is created by
 * the agent and registered into the built-in registry afterwards.
 *
 * @param {object}   o
 * @param {object}   o.config    Session config.
 * @param {object}   o.builtins  Tool registry (shared with the main agent).
 * @param {object}   o.plan      Shared plan-mode state.
 * @param {Function} o.env       () => { platform, instructions } — read per run so
 *                               /set dir and edited instruction files apply.
 * @param {Function} [o.onUsage] Called with (result, messages, message) per model call.
 */
export function createDelegateTool({ config, builtins, plan, env, onUsage }) {
  const maxSteps = Math.max(1, Math.floor(Number(config.subagentMaxSteps) || DEFAULT_SUBAGENT_MAX_STEPS));

  async function runSubagent(type, args, { signal } = {}) {
    const spec = SUBAGENTS[type];
    const restrictions = { readOnly: spec.readOnly, exclude: SUBAGENT_EXCLUDED };
    const tools = builtins.listTools(restrictions);

    const { platform = '', instructions = '' } = env?.() || {};
    const messages = [
      { role: 'system', content: subagentPrompt(type, { cwd: builtins.cwd, platform, instructions }) },
      { role: 'user', content: subagentBrief(args) },
    ];

    ui.printSubagentStart(type, args.goal);
    let steps = 0;
    let report = '';
    let note = '';

    for (; steps < maxSteps; steps++) {
      if (signal?.aborted) {
        note = 'the user interrupted the session';
        break;
      }
      const remaining = maxSteps - steps;
      if (remaining === 2 && steps > 0) {
        messages.push({
          role: 'user',
          content: `[system] ${remaining} steps left — stop working and write your report now, including anything still unfinished.`,
        });
      }

      const spin = ui.spinner(`  ${type} subagent — step ${steps + 1}…`);
      let result;
      try {
        // Never streamed: the subagent's thinking is exactly the noise this
        // tool exists to keep out of the transcript.
        result = await chatCompletion({
          config: { ...config, streaming: false },
          messages,
          tools,
          maxTokens: config.maxTokens,
          signal,
        });
      } catch (e) {
        spin.stop();
        if (signal?.aborted) return { report: '', steps, note: 'interrupted by the user' };
        return { report: '', steps, note: `the subagent could not reach the model: ${e.message}` };
      }
      spin.stop();

      onUsage?.(result, messages, result.message);
      const msg = result.message;
      messages.push(msg);

      const calls = msg.tool_calls || [];
      if (!calls.length) {
        report = String(msg.content ?? '').trim();
        if (report) break;
        // An empty reply with no tool calls: ask once, then give up.
        messages.push({ role: 'user', content: '[system] You returned nothing. Write your report now.' });
        continue;
      }

      for (const tc of calls) {
        const name = tc.function?.name || '(unknown)';
        let parsed = {};
        let bad = null;
        try {
          const raw = tc.function?.arguments ?? '';
          parsed = raw ? JSON.parse(raw) : {};
        } catch (e) {
          bad = `tool arguments were not valid JSON: ${e.message}`;
        }
        ui.printToolCall(name, tc.function?.arguments || '{}', { indent: 2 });
        const out = bad
          ? `Error: ${bad}`
          : await builtins.execute(name, parsed, { ...restrictions, signal });
        ui.printToolResult(out, { indent: 2, maxLines: 6 });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: out });
      }
    }

    if (!report && !note) {
      note = `the subagent used all ${maxSteps} of its steps without writing a report`;
      const last = [...messages].reverse().find((m) => m.role === 'assistant' && String(m.content ?? '').trim());
      if (last) report = String(last.content).trim();
    }
    return { report, steps: steps + 1, note, tokens: estimateTokens(messages) };
  }

  return {
    name: 'delegate',
    // Offered in plan mode too: a read-only researcher is exactly what plan
    // mode is for. run() refuses the coder while planning.
    readOnly: true,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          enum: Object.keys(SUBAGENTS),
          description: Object.values(SUBAGENTS).map((s) => `${s.name}: ${s.summary}`).join('. '),
        },
        goal: {
          type: 'string',
          description:
            'The complete brief. State the outcome, the constraints and what done looks like. ' +
            'The subagent has no other context — assume it knows nothing about this conversation or this repository.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths you already know are involved, so it does not have to search for them.',
        },
        context: {
          type: 'string',
          description:
            'What you established earlier that it would otherwise rediscover: decisions, conventions, ' +
            'results of previous steps, approaches already ruled out.',
        },
      },
      required: ['agent', 'goal'],
    },
    async run(args, ctx = {}) {
      const type = String(args?.agent ?? '').trim().toLowerCase();
      const spec = SUBAGENTS[type];
      if (!spec) {
        throw new Error(`unknown subagent "${args?.agent}" — use one of: ${Object.keys(SUBAGENTS).join(', ')}`);
      }
      const goal = String(args?.goal ?? '').trim();
      if (!goal) throw new Error('delegate needs a "goal": the full brief for the subagent');
      if (plan?.planning && !spec.readOnly) {
        throw new Error(
          'plan mode is read-only — a coder subagent cannot run. Delegate to the researcher instead, ' +
            'then call present_plan; the user approves it with /approve and the work starts after that.'
        );
      }

      const started = Date.now();
      const { report, steps, note, tokens } = await runSubagent(type, { ...args, goal }, ctx);
      ui.printSubagentEnd({ type, steps, tokens, ms: Date.now() - started, ok: Boolean(report) && !note });

      const head = `[${type} subagent finished: ${steps} step(s), ${ui.fmtTokens(tokens || 0)} tokens of its own context, discarded]`;
      if (!report) {
        return `${head}\nThe subagent returned no report${note ? ` — ${note}` : ''}. Its context is gone; re-delegate with a narrower brief, or do this step yourself.`;
      }
      const warning = note ? `\n[warning: ${note} — treat the report as incomplete]` : '';
      return `${head}${warning}\n${report}`;
    },
  };
}
