#!/usr/bin/env node
/* coding-harness — a simple single-session coding harness for OpenAI-compatible models. */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { loadConfig, maskConfig, DEFAULT_CONFIG_PATH } from './lib/config.js';
import { createTools, shellInfo } from './lib/tools.js';
import { connectMcpServers } from './lib/mcp.js';
import { createAgent } from './lib/agent.js';
import * as ui from './lib/ui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

const HELP = `
  Commands
    /help              show this help
    /config            show effective configuration (key masked)
    /tools             list available tools
    /set dir <path>    change the working directory (file tools + commands run there)
    /cwd               show the current working directory
    /usage             token usage, speed and context fill for this session
    /compact           summarize the conversation to free context (also automatic)
    /reset             clear the conversation (same session, fresh context)
    /clear             clear the terminal screen
    /exit  /quit       exit

  Anything else is sent to the model as a chat message.
  CLI flags: --config <path>  --dir <path>  --once "<prompt>"  --stream | --no-stream  --model <name>  --init
`;

function parseArgs(argv) {
  const opts = { config: null, dir: null, once: null, streaming: undefined, model: null, init: false, help: false };
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
  let config, created;
  try {
    ({ config, created } = loadConfig(configPath, {
      streaming: opts.streaming,
      model: opts.model,
    }));
  } catch (e) {
    ui.printError(e.message);
    process.exit(1);
  }

  if (opts.init) {
    ui.out(`config ${created ? 'created' : 'already exists'} at ${configPath}`);
    if (created) ui.out('edit openai.baseURL / openai.apiKey / openai.model, then run: node harness.js');
    return;
  }

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

  ui.banner({
    version: pkg.version,
    configPath,
    configCreated: created,
    model: config.openai.model,
    baseURL: config.openai.baseURL,
    streaming: config.streaming,
    contextSize: config.contextSize,
    temperature: config.temperature,
    workspace: builtins.cwd,
    tools: builtins.listTools().map((t) => t.name),
    mcp: mcp.size ? mcp.describe() : null,
  });

  if (!config.openai.apiKey || config.openai.apiKey === 'sk-REPLACE_ME') {
    ui.printSystem('no API key set — fine for local servers that do not need one; otherwise edit the config or set OPENAI_API_KEY');
  }

  const agent = createAgent({ config, builtins, mcp: mcp.size ? mcp : null });

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
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: isTty ? `${ui.s.bold(ui.s.cyan('❯'))} ` : '',
    historySize: 200,
    terminal: isTty,
  });

  let busy = false;

  const handleLine = async (line) => {
    const text = line.trim();
    if (!text) return;

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
          break;
        case '/tools': {
          const width = Math.max(20, ui.termWidth() - 20);
          const line = (colorFn, name, desc) => {
            const d = desc.split('\n')[0];
            ui.out(`  ${colorFn(name.slice(0, 16).padEnd(16))} ${ui.s.dim(d.length > width ? d.slice(0, width - 1) + '…' : d)}`);
          };
          for (const t of builtins.listTools()) line(ui.s.green, t.name, t.description);
          for (const t of mcp.listTools()) line(ui.s.yellow, t.name, t.description);
          break;
        }
        case '/set': {
          const rest = text.slice(cmd.length).trim();
          const m = /^(\S+)\s*([\s\S]*)$/.exec(rest);
          const key = (m?.[1] || '').toLowerCase();
          let value = (m?.[2] || '').trim();
          if (key !== 'dir') {
            ui.printError('usage: /set dir <path>   (e.g. /set dir ../other-project)');
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
        case '/usage': {
          const st = agent.stats();
          ui.printStats({
            calls: st.calls,
            promptTokens: st.promptTokens,
            completionTokens: st.completionTokens,
            avgTokPerSec: st.avgTokPerSec,
            compactions: st.compactions,
            used: st.used,
            contextSize: st.contextSize,
            estimated: st.estimated,
          });
          break;
        }
        case '/compact': {
          busy = true;
          try {
            await agent.compact({ manual: true });
          } finally {
            busy = false;
          }
          break;
        }
        case '/reset':
          agent.reset();
          ui.printSystem('conversation cleared');
          break;
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
    busy = true;
    try {
      await agent.turn(text);
    } finally {
      busy = false;
    }
  };

  rl.on('SIGINT', () => {
    if (busy) {
      ui.printSystem('working… let the turn finish (the session is single-threaded)');
      return;
    }
    if (rl.line) {
      rl.write(null, { ctrl: true, name: 'u' }); // clear current input
      rl.prompt();
      return;
    }
    ui.out('');
    shutdown();
    rl.close();
    process.exit(0);
  });

  rl.prompt();
  for await (const line of rl) {
    await handleLine(line);
    rl.prompt();
  }
  // stdin closed (Ctrl+D / piped input exhausted)
  shutdown();
  ui.out('');
}

main().catch((e) => {
  ui.printError(e.stack || e.message);
  process.exit(1);
});
