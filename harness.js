#!/usr/bin/env node
/* coding-harness — a simple single-session coding harness for OpenAI-compatible models. */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { loadConfig, maskConfig, DEFAULT_CONFIG_PATH } from './lib/config.js';
import { createTools, shellInfo } from './lib/tools.js';
import { BUILD_MODE, PLAN_MODE } from './lib/plan.js';
import { connectMcpServers } from './lib/mcp.js';
import { createAgent } from './lib/agent.js';
import { createInputReader } from './lib/input.js';
import { matchPromptStyle, PROMPT_STYLES } from './lib/prompt.js';
import { GATE_MODES } from './lib/gate.js';
import { DELEGATION_MODES, normalizeDelegation } from './lib/delegate.js';
import { buildSession, listSessions, loadSession, resolveLoadPath, resolveSessionPath, saveSession, sessionDir, sessionTitle } from './lib/session.js';
import * as ui from './lib/ui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

const HELP = `
  Commands
    /help              show this help
    /config            show effective configuration (key masked)
    /tools             list available tools
    /set dir <path>    change the working directory (file tools + commands run there)
    /set prompt <s>    system prompt style: full (default) or compact (~790 vs ~2.2k tokens)
    /set gate <mode>   run_command gate: enforce (default), warn, off — redirects grep/cat/sed -i
    /set delegation    subagent delegation: off (default), optional, enforced
    /cwd               show the current working directory
    /usage             token usage, speed and context fill for this session
    /compact           summarize the conversation to free context (also automatic)
    /reset             clear the conversation (same session, fresh context)
    /clear             clear the terminal screen
    /exit  /quit       exit

  Save and load the chat
    /save [name|file]  write this conversation to disk (default: ~/.coding-harness/chats)
    /load <name|file>  replace this conversation with a saved one
    /chats             list saved chats
    --resume [name]    load one at startup (no name = the most recent)

  Plan first, then build
    /plan <task>       plan mode: read-only research, ends with a plan to review
    /plan              turn plan mode on (or /plan show to re-print the plan)
    /approve [note]    accept the plan, leave plan mode and start implementing
    /build [message]   leave plan mode without a plan (changes allowed again)

  Multiline input
    one line ending in \\     keeps composing (the backslash is dropped)
    Shift+Enter / Alt+Enter  same, in terminals that report them as ESC+CR
    pasting several lines    becomes one draft
    plain Enter              sends the whole draft (Ctrl+C discards it)

  Config file (all of the above persist there, plus contextSize, maxSteps, searchIgnore,
  subagentMaxSteps, instructions, mcp.servers, …) — /config shows the effective values.
  A .llmignore file in the workspace hides paths from read_file and search_files entirely.

  Anything else is sent to the model as a chat message.
  CLI flags: --config <path>  --dir <path>  --once "<prompt>"  --plan  --resume [name]
             --stream | --no-stream  --model <name>  --prompt <full|compact>  --init
`;

function parseArgs(argv) {
  const opts = { config: null, dir: null, once: null, streaming: undefined, model: null, promptStyle: null, init: false, help: false, plan: false, resume: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--config':
      case '-c':
        opts.config = argv[++i];
        break;
      case '--dir':
      case '-d':
        opts.dir = argv[++i];
        break;
      case '--once':
      case '-1':
        opts.once = argv[++i] ?? '';
        break;
      case '--stream':
        opts.streaming = true;
        break;
      case '--no-stream':
        opts.streaming = false;
        break;
      case '--model':
        opts.model = argv[++i];
        break;
      case '--prompt':
        opts.promptStyle = argv[++i];
        break;
      case '--resume':
      case '--continue': {
        // the name is optional: `--resume` alone means "the most recent chat"
        const next = argv[i + 1];
        opts.resume = next && !next.startsWith('-') ? argv[++i] : '';
        break;
      }
      case '--plan':
      case '-p':
        opts.plan = true;
        break;
      case '--init':
        opts.init = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        if (a.startsWith('-')) {
          console.error(`unknown flag: ${a} (see --help)`);
          process.exit(1);
        }
        // bare text is treated like --once
        if (opts.once === null) opts.once = a;
        break;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`coding-harness v${pkg.version}${HELP}`);
    return;
  }

  const configPath = opts.config ? path.resolve(opts.config) : DEFAULT_CONFIG_PATH;
  let config, created, added;
  try {
    if (opts.promptStyle && !matchPromptStyle(opts.promptStyle)) {
      throw new Error(`--prompt: unknown style "${opts.promptStyle}" — use ${PROMPT_STYLES.join(' or ')}`);
    }
    ({ config, created, added } = loadConfig(configPath, {
      streaming: opts.streaming,
      model: opts.model,
      promptStyle: opts.promptStyle ? matchPromptStyle(opts.promptStyle) : null,
    }));
  } catch (e) {
    ui.printError(e.message);
    process.exit(1);
  }

  if (opts.init) {
    ui.out(`config ${created ? 'created' : 'already exists'} at ${configPath}`);
    if (created) ui.out('edit openai.baseURL / openai.apiKey / openai.model, then run: node harness.js');
    // an existing file is brought up to date rather than left behind
    if (added?.length) ui.out(`added missing key(s) at their defaults: ${added.join(', ')}`);
    return;
  }

  // --plan starts the session in read-only plan mode (same as typing /plan first)
  if (opts.plan) config.planMode = true;

  const builtins = createTools(config);

  // --dir <path>: start in a different working directory (same as "/set dir <path>")
  if (opts.dir) {
    try {
      builtins.setCwd(opts.dir);
    } catch (e) {
      ui.printError(e.message);
      process.exit(1);
    }
  }

  const mcp = await connectMcpServers(config.mcp, {
    onLog: (kind, msg) => (kind === 'error' ? ui.printError(msg) : ui.printSystem(msg)),
  });

  // the agent registers its own tools (delegate) during construction, so it is
  // built before the banner lists what the model will actually be offered
  const agent = createAgent({ config, builtins, mcp: mcp.size ? mcp : null });

  // --resume runs before the banner so the mode and tool rows describe the
  // restored session rather than the empty one it replaced.
  let resumed = null;
  if (opts.resume !== undefined) {
    try {
      const target = opts.resume ? resolveLoadPath(opts.resume, { cwd: builtins.cwd }) : { file: listSessions()[0]?.file };
      if (!target.file) throw new Error(`no saved chats in ${sessionDir()} — /save writes one`);
      const session = loadSession(target);
      const file = target.file;
      builtins.plan.restore({ mode: session.mode, proposed: session.plan.proposed, approved: session.plan.approved });
      if (session.delegation) agent.setDelegation(session.delegation);
      agent.restore({ conversation: session.conversation, stats: session.stats });
      resumed = { file, session };
    } catch (e) {
      ui.printError(`--resume: ${e.message}`);
      process.exit(1);
    }
  }

  ui.banner({
    version: pkg.version,
    promptStyle: config.promptStyle,
    configPath,
    configCreated: created,
    model: config.openai.model,
    baseURL: config.openai.baseURL,
    streaming: config.streaming,
    contextSize: config.contextSize,
    temperature: config.temperature,
    workspace: builtins.cwd,
    // what the model is actually offered, not everything that exists
    tools: agent.tools().filter((t) => !mcp.has(t.name)).map((t) => t.name),
    mcp: mcp.size ? mcp.describe() : null,
    planning: builtins.plan.planning,
    delegation: agent.delegation,
    configAdded: added,
  });

  if (resumed) {
    ui.printSystem(
      `resumed ${path.basename(resumed.file, '.json')}${resumed.session.title ? ` — "${resumed.session.title}"` : ''} ` +
        `(${resumed.session.conversation.length} message(s))`
    );
  }

  if (!config.openai.apiKey || config.openai.apiKey === 'sk-REPLACE_ME') {
    ui.printSystem('no API key set — fine for local servers that do not need one; otherwise edit the config or set OPENAI_API_KEY');
  }

  const shutdown = () => {
    mcp.closeAll();
  };
  process.on('exit', shutdown);
  process.on('SIGTERM', () => process.exit(0));

  // ---- one-shot mode (also handy for scripting) ----
  if (opts.once !== null) {
    ui.printUser(opts.once);
    await agent.turn(opts.once);
    shutdown();
    return;
  }

  // ---- interactive single session ----
  const isTty = Boolean(process.stdin.isTTY);
  // the prompt shows the mode, so it is re-evaluated before every draw
  const promptText = () =>
    agent.planning ? `${ui.s.bold(ui.s.magenta('plan ❯'))} ` : `${ui.s.bold(ui.s.cyan('❯'))} `;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: isTty ? promptText() : '',
    historySize: 200,
    terminal: isTty,
  });

  const queued = []; // finished messages waiting for their turn
  let drainDone = Promise.resolve();

  // Enter sends; a trailing "\", Shift+Enter (ESC+CR) or a multi-line paste keep
  // composing one message. See lib/input.js.
  const reader = createInputReader({
    rl,
    stdin: process.stdin,
    isTty,
    prompt: promptText,
    continuationPrompt: `${ui.s.dim('│')} `,
    onMessage(text) {
      queued.push(text);
      drain();
    },
    notify: (line) => ui.out(ui.s.dim(line)),
  });

  /** Run queued messages one after another — the session is single-threaded. */
  function drain() {
    if (reader.busy) return drainDone;
    reader.setBusy(true);
    drainDone = (async () => {
      try {
        while (queued.length) {
          try {
            await handleText(queued.shift());
          } catch (e) {
            ui.printError(e?.stack || e?.message || String(e));
          }
        }
      } finally {
        reader.setBusy(false); // back to the prompt (or the "│" draft prompt)
      }
    })();
    return drainDone;
  }

  async function handleText(rawText) {
    const text = String(rawText ?? '');
    if (!text.trim()) return;

    if (text.startsWith('/')) {
      const cmd = text.split(/\s+/)[0].toLowerCase();
      switch (cmd) {
        case '/help':
          ui.out(HELP);
          break;
        case '/config':
          ui.out(ui.s.dim(JSON.stringify(maskConfig(config), null, 2)));
          ui.out(ui.s.dim(`config file: ${configPath}`));
          ui.out(ui.s.dim(`shell: ${shellInfo(config)}`));
          ui.out(ui.s.dim(`mode: ${agent.mode}${agent.plan.approved ? ` (implementing "${agent.plan.approved.title}")` : ''}`));
          break;
        case '/tools': {
          const width = Math.max(20, ui.termWidth() - 20);
          const line = (colorFn, name, desc) => {
            const d = desc.split('\n')[0];
            ui.out(`  ${colorFn(name.slice(0, 16).padEnd(16))} ${ui.s.dim(d.length > width ? d.slice(0, width - 1) + '…' : d)}`);
          };
          // the list mirrors what the model is actually offered, so plan mode
          // and enforced delegation show fewer tools
          const offered = new Set(agent.tools().map((t) => t.name));
          for (const t of builtins.listTools()) if (offered.has(t.name)) line(ui.s.green, t.name, t.description);
          for (const t of mcp.listTools()) if (offered.has(t.name)) line(ui.s.yellow, t.name, t.description);
          if (agent.planning) {
            ui.printSystem('plan mode: only read-only tools are offered (/approve or /plan off for the rest)');
          }
          if (agent.delegation === 'enforced') {
            ui.printSystem('delegation is enforced: write_file and edit_file belong to the coder subagent, not to this agent');
          }
          break;
        }
        case '/set': {
          const rest = text.slice(cmd.length).trim();
          const m = /^(\S+)\s*([\s\S]*)$/.exec(rest);
          const key = (m?.[1] || '').toLowerCase();
          let value = (m?.[2] || '').trim();
          if (key === 'prompt' || key === 'promptstyle') {
            if (!value) {
              ui.printSystem(`system prompt style: ${config.promptStyle} (/set prompt ${config.promptStyle === 'full' ? 'compact' : 'full'} to switch)`);
              break;
            }
            const style = matchPromptStyle(value);
            if (!style) {
              ui.printError(`unknown prompt style "${value}" — use ${PROMPT_STYLES.join(' or ')}`);
              break;
            }
            config.promptStyle = style;
            agent.refreshSystem();
            ui.printSystem(`system prompt style: ${style}`);
            break;
          }
          if (key === 'gate' || key === 'commandgate') {
            if (!value) {
              ui.printSystem(`command gate: ${config.commandGate} (one of ${GATE_MODES.join(', ')})`);
              break;
            }
            const mode = value.toLowerCase();
            if (!GATE_MODES.includes(mode)) {
              ui.printError(`unknown gate mode "${value}" — use ${GATE_MODES.join(', ')}`);
              break;
            }
            // run_command reads config.commandGate on every call, so this needs no rebuild
            config.commandGate = mode;
            ui.printSystem(
              `command gate: ${mode}${mode === 'off' ? ' — grep/cat/sed -i now run as typed' : mode === 'warn' ? ' — allowed, with a note' : ' — grep/cat/sed -i are redirected to the built-in tools'}`
            );
            break;
          }
          if (key === 'delegation' || key === 'delegate') {
            if (!value) {
              ui.printSystem(`delegation: ${agent.delegation} (one of ${DELEGATION_MODES.join(', ')})`);
              break;
            }
            const mode = normalizeDelegation(value);
            // normalizeDelegation falls back to "off", so reject a typo rather than silently disabling
            if (!DELEGATION_MODES.includes(value.toLowerCase()) && mode === 'off' && value.toLowerCase() !== 'off') {
              ui.printError(`unknown delegation mode "${value}" — use ${DELEGATION_MODES.join(', ')}`);
              break;
            }
            const now = agent.setDelegation(mode);
            ui.printSystem(
              `delegation: ${now}${now === 'enforced' ? ' — write_file and edit_file now belong to the coder subagent' : now === 'optional' ? ' — the delegate tool is available' : ' — the delegate tool is hidden again'}`
            );
            break;
          }
          if (key !== 'dir') {
            ui.printError('usage: /set dir <path> | /set prompt <full|compact> | /set gate <enforce|warn|off> | /set delegation <off|optional|enforced>');
            break;
          }
          if (!value) {
            ui.printSystem(`working directory: ${builtins.cwd}`);
            break;
          }
          // allow quoted paths (spaces, or copy-pasted from Windows Explorer)
          if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
          try {
            const abs = builtins.setCwd(value);
            config.workspace = abs;
            agent.refreshSystem(
              `[system] The working directory changed to ${abs}. Relative paths passed to file tools and run_command now resolve there.`
            );
            ui.printSystem(`working directory set to ${abs}`);
          } catch (e) {
            ui.printError(e.message);
          }
          break;
        }
        case '/cwd':
        case '/pwd':
          ui.printSystem(`working directory: ${builtins.cwd}`);
          break;
        case '/plan': {
          const rest = text.slice(cmd.length).trim();
          if (/^(off|stop|exit|end|no)$/i.test(rest)) {
            agent.setMode(BUILD_MODE);
            ui.printSystem('plan mode off — changes are allowed again');
            break;
          }
          if (/^show$/i.test(rest)) {
            const current = agent.plan.proposed || agent.plan.approved;
            if (!current) ui.printSystem('no plan yet — describe the task with /plan <task>');
            else {
              ui.printPlan(current);
              ui.printSystem(agent.plan.approved ? 'this plan was approved — it is being implemented' : 'plan pending — /approve to implement it');
            }
            break;
          }
          const wasPlanning = agent.planning;
          agent.setMode(PLAN_MODE);
          if (!wasPlanning) {
            ui.printSystem(
              'plan mode on — read-only research (no edits, no commands that change anything). ' +
                'The model finishes with a plan; /approve accepts it, /plan off leaves.'
            );
          }
          if (rest) {
            ui.printUser(rest);
            await agent.turn(rest);
          } else if (wasPlanning) {
            ui.printSystem('already in plan mode — describe the task, or /plan off to leave');
          }
          break;
        }
        case '/approve':
        case '/accept': {
          const note = text.slice(cmd.length).trim();
          const accepted = agent.approvePlan(note);
          if (!accepted) {
            ui.printSystem(
              agent.planning
                ? 'no plan to approve yet — let the model finish researching, or describe the task with /plan <task>'
                : 'no plan to approve — /plan <task> researches one first'
            );
            break;
          }
          ui.printSystem(
            accepted.plan
              ? `plan approved: ${accepted.plan.title} — implementing (${accepted.plan.steps.length} step(s))`
              : 'approved — implementing the approach from the conversation'
          );
          ui.printUser(note || `/approve — implement the plan${accepted.plan ? `: ${accepted.plan.title}` : ''}`);
          await agent.turn(accepted.message);
          break;
        }
        case '/build':
        case '/normal': {
          const rest = text.slice(cmd.length).trim();
          if (agent.planning) {
            agent.setMode(BUILD_MODE);
            ui.printSystem('plan mode off — changes are allowed again');
          } else {
            ui.printSystem('already in build mode');
          }
          if (rest) {
            ui.printUser(rest);
            await agent.turn(rest);
          }
          break;
        }
        case '/usage': {
          const st = agent.stats();
          ui.printStats({
            calls: st.calls,
            promptTokens: st.promptTokens,
            completionTokens: st.completionTokens,
            avgTokPerSec: st.avgTokPerSec,
            compactions: st.compactions,
            subagentCalls: st.subagentCalls,
            used: st.used,
            contextSize: st.contextSize,
            estimated: st.estimated,
          });
          break;
        }
        case '/compact':
          await agent.compact({ manual: true });
          break;
        case '/reset':
          agent.reset(); // drops the plan too: a fresh context implies a fresh plan
          ui.printSystem(`conversation cleared${agent.planning ? ' (still in plan mode)' : ''}`);
          break;
        case '/save':
        case '/export': {
          const arg = text.slice(cmd.length).trim();
          // an empty chat file is clutter, not a save point
          if (agent.history.length <= 1) {
            ui.printError('nothing to save yet — say something first');
            break;
          }
          try {
            const target = resolveSessionPath(arg, { cwd: builtins.cwd, title: sessionTitle(agent.history) });
            saveSession(
              target,
              buildSession({
                messages: agent.history,
                plan: agent.plan,
                delegation: agent.delegation,
                promptStyle: config.promptStyle,
                model: config.openai.model,
                workspace: builtins.cwd,
                stats: agent.stats(),
                harnessVersion: pkg.version,
              })
            );
            const turns = agent.history.filter((m) => m.role === 'user').length;
            ui.printSystem(`chat saved to ${target} (${turns} turn(s), ${agent.history.length - 1} message(s))`);
          } catch (e) {
            ui.printError(`could not save the chat: ${e.message}`);
          }
          break;
        }
        case '/load':
        case '/import': {
          const arg = text.slice(cmd.length).trim();
          if (!arg) {
            ui.printError('usage: /load <name|file>   (/chats lists what you have saved)');
            break;
          }
          try {
            const session = loadSession(resolveLoadPath(arg, { cwd: builtins.cwd }));
            // the plan goes back first: the rebuilt system prompt depends on it
            builtins.plan.restore({ mode: session.mode, proposed: session.plan.proposed, approved: session.plan.approved });
            if (session.delegation) agent.setDelegation(session.delegation);
            const restored = agent.restore({ conversation: session.conversation, stats: session.stats });
            ui.printSystem(
              `chat loaded${session.title ? `: "${session.title}"` : ''} — ${restored} message(s)` +
                `${session.savedAt ? `, saved ${new Date(session.savedAt).toLocaleString()}` : ''}`
            );
            if (agent.planning) ui.printSystem('restored in plan mode');
            if (agent.plan.approved) ui.printSystem(`approved plan restored: ${agent.plan.approved.title}`);
            // the prompt is rebuilt for *here*, so a chat from elsewhere is worth flagging
            if (session.workspace && path.resolve(session.workspace) !== path.resolve(builtins.cwd)) {
              ui.printSystem(`note: saved in ${session.workspace} — the conversation may refer to files that are not here`);
            }
            if (session.model && session.model !== config.openai.model) {
              ui.printSystem(`note: saved with model ${session.model}, now using ${config.openai.model}`);
            }
          } catch (e) {
            ui.printError(`could not load the chat: ${e.message}`);
          }
          break;
        }
        case '/chats': {
          const saved = listSessions();
          if (!saved.length) {
            ui.printSystem(`no saved chats yet in ${sessionDir()} — /save [name] writes one`);
            break;
          }
          const width = Math.max(12, Math.min(28, ...saved.map((s) => s.name.length)) || 12);
          for (const s of saved) {
            const when = s.savedAt ? new Date(s.savedAt).toISOString().slice(0, 16).replace('T', ' ') : '';
            ui.out(
              `  ${ui.s.green(s.name.padEnd(Math.max(width, s.name.length)))}  ${ui.s.dim(`${when} · ${s.turns} turn(s)`)}  ${s.title}`
            );
          }
          ui.printSystem(`${saved.length} saved chat(s) in ${sessionDir()} — /load <name>`);
          break;
        }
        case '/clear':
          process.stdout.write('\x1b[2J\x1b[H');
          break;
        case '/exit':
        case '/quit':
          shutdown();
          rl.close();
          process.exit(0);
          break;
        default:
          ui.printError(`unknown command "${cmd}" — try /help`);
      }
      return;
    }

    ui.printUser(text);
    await agent.turn(text);
  }

  rl.on('SIGINT', () => {
    if (reader.busy) {
      agent.cancel();
      ui.printSystem('interrupt requested — stopping the current execution…');
      return;
    }
    if (reader.pending || rl.line) {
      const hadDraft = reader.pending > 0;
      rl.line = ''; // drop the half-typed line …
      rl.cursor = 0;
      if (isTty) process.stdout.write('\r\x1b[K'); // … and wipe it off the screen
      if (hadDraft) ui.printSystem('multiline draft discarded');
      reader.discard(); // resets the draft and re-draws the prompt
      return;
    }
    ui.out('');
    shutdown();
    rl.close();
    process.exit(0);
  });

  const closed = new Promise((resolve) => {
    rl.once('close', () => {
      reader.flushDraft(); // a draft left over by piped input / Ctrl+D is still sent
      resolve();
    });
  });

  reader.setBusy(false); // draws the first prompt
  await closed; // /exit, Ctrl+D or the end of piped input
  await drainDone; // let queued turns finish (piped input arrives in one burst)
  shutdown();
  ui.out('');
}

main().catch((e) => {
  ui.printError(e.stack || e.message);
  process.exit(1);
});
