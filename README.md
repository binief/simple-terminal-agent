# coding-harness

A minimal, concretely working **coding harness** in Node.js — a single-session terminal chat agent for any OpenAI-compatible API, with built-in coding tools, OS-aware command execution, a read-only [plan mode](#plan-mode) for agreeing on the work before it starts, optional MCP servers, and a styled chat view.

**Zero npm dependencies.** Node.js >= 18 only.

## Quick start

```bash
cd coding-harness
node harness.js --init      # writes ~/.coding-harness/config.json
$EDITOR ~/.coding-harness/config.json
node harness.js             # start chatting
```

## Configuration

Everything lives in one JSON file in the user's home directory: `~/.coding-harness/config.json`
(override the path with `--config <path>`).

```json
{
  "openai": {
    "baseURL": "https://api.openai.com/v1",
    "apiKey": "sk-REPLACE_ME",
    "model": "gpt-4o-mini"
  },
  "contextSize": 64000,
  "maxTokens": 4096,
  "maxSteps": 50,
  "temperature": 0.2,
  "streaming": true,
  "workspace": null,
  "shell": null,
  "lineEndings": "auto",
  "searchIgnore": [],
  "promptStyle": "full",
  "instructions": null,
  "autoCompact": true,
  "commandTimeout": 60,
  "planMode": false,
  "planAllowCommands": [],
  "planAllowTools": [],
  "mcp": {
    "servers": {}
  }
}
```

| Key | Meaning |
| --- | --- |
| `openai.baseURL` | OpenAI-compatible API root (include `/v1` where the provider needs it). Works with OpenAI, Ollama, LM Studio, vLLM, LiteLLM, … |
| `openai.apiKey` | Bearer token (optional for local servers). |
| `openai.model` | Model name. |
| `contextSize` | Total context budget (tokens). Older turns are dropped once history grows past it. |
| `maxTokens` | Max tokens the model may generate per reply. |
| `maxSteps` | Max model replies (tool round-trips) per user turn before the harness stops and asks you to say "continue". Default 50. |
| `temperature` | Sampling temperature. |
| `streaming` | `true` = stream tokens as they arrive; `false` = show the reply when complete. Also `--stream` / `--no-stream`. |
| `workspace` | Root for file tools and commands. `null` = the directory you launch from. |
| `shell` | Override the command shell. `null` = OS-aware default (`cmd.exe /d /s /c` on Windows, bash/sh `-c` elsewhere). A string like `"powershell"` or `"zsh"` is understood; or `{ "command": "...", "args": [...] }` for full control. |
| `searchIgnore` | Extra globs `search_files` should skip (relative to the workspace): `["vendor-cache/", "*.snap"]`. `!pattern` re-includes something the built-ins or `.gitignore` exclude. Default `[]`. |
| `lineEndings` | Newline style for files the tools write: `auto` (default — keep the file's own style, else the OS default), `lf`, `crlf`, `cr`, `native`. |
| `promptStyle` | System prompt variant: `full` (default, ≈2.2k tokens) or `compact` (≈790 tokens — same rules, no explanations; for small context windows and small local models). Also `--prompt <style>`, `/set prompt <style>`, `HARNESS_PROMPT_STYLE`. |
| `instructions` | Extra rules appended to the system prompt: literal text, or the path to a text file (`~` expanded, relative paths resolve against the workspace). Re-read on every system-prompt rebuild, so edits apply mid-session. Env override: `HARNESS_INSTRUCTIONS`. |
| `autoCompact` | `true` (default) = summarize the conversation automatically before the context fills up. `false` = only warn; use `/compact` yourself. |
| `commandTimeout` | Default timeout (seconds) for `run_command`. |
| `planMode` | `true` = start every session in plan mode (read-only research, see below). Default `false`. Also `--plan`. |
| `planAllowCommands` | Extra commands `run_command` may run in plan mode: `["make"]` allows the command, `["npm test"]` allows exactly that prefix. Default `[]`. |
| `planAllowTools` | MCP tools that stay available in plan mode (they are hidden by default because an MCP server can write anywhere): `["mcp_docs_search"]`. Default `[]`. |
| `mcp.servers` | Named MCP servers (see below). |

Env var overrides: `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`,
`HARNESS_STREAMING`, `HARNESS_CONTEXT_SIZE`, `HARNESS_TEMPERATURE`, `HARNESS_MAX_STEPS`,
`HARNESS_PLAN_MODE`, `HARNESS_PROMPT_STYLE`.

## Built-in coding tools

| Tool | What it does |
| --- | --- |
| `read_file` | Read a window of a text file (default 200 lines, ≤500 lines / 40k chars per call) |
| `write_file` | Create/overwrite a file (makes parent dirs) |
| `edit_file` | Exact-text replacement, line-ending aware (see below) |
| `list_dir` | List a directory (dirs first) |
| `search_files` | Recursive regex content search (skips dependencies, build output, caches, `.gitignore` matches and binary files — see below) |
| `run_command` | Run a shell command in the workspace, returns stdout/stderr/exit code |
| `present_plan` | Plan mode only: hand a titled, numbered plan to the user for approval (see [Plan mode](#plan-mode)) |

**Line endings are OS-aware.** Files are read and normalised to `\n`, so a CRLF (Windows) file matches
the `old_text` you copied out of `read_file`, and it is written back with its own CRLF endings intact.
`write_file` keeps the existing file's style (new files get the OS default), and
`config.lineEndings` can force `lf` / `crlf` / `cr` / `native` when you want something specific.
If a match still fails, `edit_file` retries line-by-line ignoring trailing whitespace before erroring.

Commands run through an **OS-aware shell**: `cmd.exe /d /s /c` on Windows, `/bin/bash` (or `zsh`/`sh`) `-c` on Unix. The system prompt tells the model which OS/shell it is writing for.

> The harness runs with your user's permissions — review commands the model wants to run if that matters to you.

### What `search_files` skips

A recursive grep in a real project spends most of its time in files nobody means. `search_files` prunes
them by default:

- **Directories** — dependencies (`node_modules`, `bower_components`, `.yarn`), build output (`dist`,
  `build`, `out`, `target`, `coverage`), framework/dev-server caches (`.next`, `.nuxt`, `.angular`,
  `.cache`, `.turbo`, `.parcel-cache`, …), Python and other toolchains (`__pycache__`, `.venv`, `.tox`,
  `.dart_tool`, `Pods`, `.terraform`, …) and every version-control directory such as `.git` — at any depth.
- **Files** — images, media, archives, executables, fonts, databases and other binaries are never read,
  and generated noise (`.min.js`, `.min.css`, `*.map`, `*.log`) is skipped.
- **Your `.gitignore`** — the project's own rules apply while walking, nested files included, with the
  usual git semantics (`!` negation, `/` anchoring, `**` globs, `dir/` for directories only) plus
  `.git/info/exclude`. Searching *inside* a skipped directory explicitly (`path: ".angular/cache"`)
  still works.

The model can search ignored paths anyway when it has a reason (grepping a dependency, a build log) by
passing `include_ignored: true` to the tool — version-control directories stay excluded either way,
grepping `.git` objects is never useful. Project-specific rules go in the config — globs are
relative to the workspace, `!` re-includes:

```json
{ "searchIgnore": ["vendor-cache/", "*.snap", "!src/generated"] }
```

## Work method (the system prompt)

The system message is built by `lib/prompt.js` (`buildSystemPrompt()`) and is the agent's working
contract. It opens with the live environment — workspace, platform/shell, date, mode and, when the
workspace is a git repository, the branch and whether the tree is clean — and then sets out the
sections below. It costs ≈2.3k tokens.

| Section | What it fixes |
| --- | --- |
| **Autonomy** | Resolve the task end to end; stop only for one genuinely blocking question, an unsafe request, or a blocker. Answer "how do I…" questions instead of silently changing files. |
| **Communication** | Terminal-sized Markdown, one short line before a batch of tool calls, `file.js:42` references, a final summary of outcome → changes → verification → assumptions. No emoji, no preamble, no tool names. |
| **Tools** | What each tool is for; batch independent reads in one reply; locate with `search_files`, then read the window; results are capped and windowed, so never act on a `[truncated …]` marker; never re-read a file just written. |
| **edit_file / write_file** | Read before changing, copy `old_text` verbatim (context over `replace_all`), line endings are handled for you, `write_file` only for new files or a deliberate rewrite, small edits over big ones. |
| **run_command** | Syntax valid for *this* shell, non-interactive and non-paginated only, use `cwd`/`timeout` instead of `cd`/`sleep`, and never read or edit files through the shell. |
| **Working method** | The six phases: understand → minimal plan → resolve uncertainty → execute → verify → report. Never jump from the prompt straight to an edit. |
| **Code quality** | Match the surrounding code, check the manifest before using a library, fix root causes, comment like the file does, no drive-by refactors, no placeholder implementations. |
| **Definition of done** | The diff is what you intended, something that exercises the change was actually run, no unverified success claims, and a blocker is reported after the second failed attempt — not a third variation. |
| **Safety** | Announce destructive steps, never `git commit`/`push`/branch unless asked, never print secrets, stay in the workspace, defensive security only. |
| **Harness mechanics** | The model is told about the step budget, compaction and token-limit continuation, so it cooperates with them instead of being surprised. |

The prompt was distilled from the published system prompts of Claude Code, Codex CLI, Cursor CLI,
Warp, Augment, Gemini CLI and Antigravity — see `docs/system-prompt-proposal.md` for the analysis,
what was adopted and what was deliberately left out.

Order matters: [plan mode](#plan-mode) rules (or the approved plan) are appended after the defaults,
and your own `instructions` come last so they win on conflict.

The numbers the prompt quotes to the model — the `read_file` window caps and the tool-result cap — are
interpolated from `TOOL_LIMITS` in `lib/tools.js`, the same constants the tools enforce, so raising a
limit updates the prompt and the tool descriptions together. A test changes the constant in a copy of
`lib/` and fails if the prompt does not follow.

### Full or compact

The prompt ships in two styles built from the same source, so they cannot drift apart:

| Style | Cost | What you get |
| --- | --- | --- |
| `full` (default) | ≈2.2k tokens | Every section above, with the reasoning behind each rule and the harness-mechanics notes. |
| `compact` | ≈790 tokens | Every rule that changes behaviour, with the explanations, the tool matrix and the harness-mechanics section removed. Meant for small context windows and small local models. |

```bash
node harness.js --prompt compact      # for this session
```

```json
{ "promptStyle": "compact" }
```

`/set prompt compact` (or `full`) switches mid-session — the system message is rebuilt immediately and
the rest of the conversation is kept. `/set prompt` on its own prints the current style, `/config` shows
it, and the banner flags it whenever it is not `full`. `HARNESS_PROMPT_STYLE` overrides the config.

### Custom instructions

`instructions` adds your own rules on top of the built-in ones:

```json
{ "instructions": "Use pnpm, never npm. Tests are run with node --test." }
```

or point it at a file — handy for rules you want to keep in the repo or share across a team:

```json
{ "instructions": "~/harness-rules.md" }
```

A single-line value that names an existing file is read from disk (`~` expanded, relative to the
workspace); anything else is used as literal text. The file is re-read whenever the system prompt is
rebuilt — after `/set dir` for example — so you can edit your rules mid-session. `HARNESS_INSTRUCTIONS`
overrides the config value, and `/config` shows what is active.

## Plan mode

Think before you type. `/plan <task>` puts the session in **plan mode**: the model may read the
project but cannot touch it, and the turn ends with a plan you approve — or don't.

```
❯ /plan add a --version flag
  ● plan mode on — read-only research (no edits, no commands that change anything).
    The model finishes with a plan; /approve accepts it, /plan off leaves.

  ── ⚙ search_files {"pattern":"process.argv"} ──
  ── ⚙ read_file {"path":"harness.js","offset":40} ──
  ── ⚙ run_command {"command":"git log --oneline -n 5"} ──

  ── ✦ Plan ─────────────────────────────────────
  Add a --version flag to the CLI

   1. add a `--version` case to parseArgs in harness.js (opts.version)
   2. print `coding-harness v<pkg.version>` and return before the config is loaded
   3. document the flag in the CLI flags block of README.md

  files  harness.js, README.md
  verify node harness.js --version
  notes  --help already prints the version, so the two should agree
  ● plan ready — /approve to implement it, /plan off to leave plan mode, or reply with changes

plan ❯ /approve
  ● plan approved: Add a --version flag to the CLI — implementing (3 step(s))
```

| Command | What it does |
| --- | --- |
| `/plan <task>` | Turn plan mode on and start researching that task |
| `/plan` | Turn plan mode on (then type the task as a normal message) |
| `/plan show` | Print the current plan again |
| `/approve [note]` | Accept the plan, leave plan mode, start implementing. The note is passed to the model (`/approve skip the README part`) |
| `/plan off`, `/build` | Leave plan mode without a plan |

`--plan` starts a session in plan mode (`node harness.js --plan`), `"planMode": true` makes it the
default, and the prompt (`plan ❯`) plus the `mode` row in the banner show which mode you are in.

### What "read-only" actually means

Plan mode is enforced by the harness, not by asking the model nicely:

- **`write_file` and `edit_file` are not offered at all**, and are refused even if the model calls one
  from memory.
- **`run_command` only accepts commands that cannot change anything** — `ls`, `cat`, `head`, `wc`,
  `grep`/`rg`, `find`, `git status|log|diff|show|blame|ls-files`, `git branch -v`, `npm ls`,
  `<anything> --version`, and pipelines of those. Every segment of a chain is checked, so
  `ls && rm -rf build` is refused as a whole. Output redirection (`> file`), command substitution
  (`$(…)`, backticks), `find -delete`/`-exec`, `sed -i`, installers, `git commit`/`push`, and
  interpreters that can run arbitrary code (`node x.js`, `python …`) are all rejected — with a reason
  the model can act on.
- **MCP tools are hidden** (an MCP server can write anywhere); list the safe ones in `planAllowTools`.
- Project-specific read-only commands go in `planAllowCommands`: `["make"]` allows the command,
  `["npm test"]` allows exactly that prefix.

```json
{ "planAllowCommands": ["make", "npm test"], "planAllowTools": ["mcp_docs_search"] }
```

### From plan to implementation

`present_plan` is how a planning turn ends: the model calls it with a title, ordered steps, the files
involved, how it will verify the result and any open questions. The harness renders the plan and stops
the turn there — nothing is implemented while you read it.

`/approve` then does three things: it switches back to build mode (the mutating tools come back), pins
the approved plan into the system prompt so it survives compaction and stays in front of the model for
the whole implementation, and sends the "implement this now" turn. If you would rather refine the plan,
just keep chatting — plan mode stays on until a plan is approved or you leave it. `/reset` clears the
conversation and the plan together.

If the model describes its approach in prose instead of calling `present_plan`, `/approve` accepts that
description — you read it, so it counts.

## MCP servers (optional)

Any [Model Context Protocol](https://modelcontextprotocol.io) stdio or Streamable HTTP server can be plugged in via config. Its tools become `mcp_<server>_<tool>` and are offered to the model next to the built-ins.

```json
{
  "mcp": {
    "servers": {
      "fs": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/extra/dir"],
        "env": {}
      },
      "remote": {
        "type": "http",
        "url": "https://example.com/mcp",
        "headers": { "Authorization": "Bearer YOUR_TOKEN" }
      }
    }
  }
}
```

For HTTP servers, use `type: "http"` and the server's MCP endpoint URL. Optional `headers` are sent with every request. A failing server is reported at startup and skipped; the rest keep working.

## Terminal chat view

Simple ANSI styling, no TUI framework: role headers, streaming output with light Markdown (bold, `inline code`, fenced code, bullets), dim tool-call/result lines, spinner while waiting.

```
  ── You ───────────────────────────────────────
  add a --version flag

  ── Assistant ─────────────────────────────────
  I'll look at the entry point first.

  ── ⚙ search_files {"pattern":"process.argv"} ─
    · cli.js:42: if (process.argv.includes('--help'))

  ── ⚙ edit_file {"path":"cli.js", …} ──────────
    · Replaced 1 occurrence(s) in cli.js

  ── Assistant ─────────────────────────────────
  Done — `cli.js` now supports `--version`.
```

## Multiline input

**Enter sends** the message; everything below keeps composing instead:

| What you do | What happens |
| --- | --- |
| end the line with `\` | the backslash is dropped and the prompt turns into `│` — keep typing |
| **Shift+Enter** / **Alt+Enter** | same, in terminals that report those keys as `ESC+CR` (VS Code's terminal, and iTerm2 / WezTerm / kitty / most terminals once shift+enter is bound to send it — Alt+Enter works out of the box in most of them) |
| paste several lines | the pasted lines become one draft |
| plain **Enter** | sends the whole draft as a single message |
| **Ctrl+C** | discards the draft; while the agent is working, interrupts the active model request |

The draft is delivered as one message with its newlines intact, so code snippets and multi-paragraph
prompts survive. Blank lines are part of the message: put a `\` on an empty line to keep one. A draft
that was never finished is still sent when the input ends (piped scripts, Ctrl+D).

## Session commands

`/help` `/config` `/tools` `/set dir <path>` `/set prompt <full|compact>` `/cwd` `/usage` `/compact` `/reset` (clear conversation) `/export <file>` (save chat) `/import <file>` (load chat) `/clear` (clear screen) `/exit`

Plan first: `/plan <task>` `/plan show` `/approve [note]` `/plan off` (see [Plan mode](#plan-mode)).

One conversation per run (single session). `/reset` starts fresh context inside the same session.

## Progress, tokens and context

While the model is working you get a live indicator — an animated spinner with elapsed seconds
(`⠹ thinking… 4.2s`) from the moment a request goes out until the first streamed token, and the same
for each tool (`⠹ running run_command… 1.8s`). When output is piped (not a TTY) it prints `· thinking…`
lines instead, so logs still show progress.

Every reply carries a usage footnote:

```
  ⓘ 12.4k in · 322 out · 58 tok/s · 5.6s · session 41.2k · context 34%
```

`in`/`out` are the token counts the server reports (`~` prefix means they were estimated because the
server sent no usage), `tok/s` is generation speed after the first token, and `context` is how full the
context window is. `/usage` prints the session totals and average speed.

**Compaction.** When the history reaches ~80% of the usable context, the harness summarizes it into a
single message (the last few messages are kept verbatim) and the turn simply continues — nothing is lost
silently and you are told what happened:

```
  ● compacted conversation (context 81% full): 58.2k → 3.1k tokens
```

Compaction never makes things worse: if the summary comes back no smaller than the messages it would
replace (a short history under a long system prompt), the raw messages are kept and you are told —
`compacting would not free anything (2.2k → 2.3k tokens) — history kept as is`.

Compaction only runs when it can actually free something. If the context is full but the summarizable
part of the history is already tiny — a `contextSize` too small for the system prompt plus the last few
messages — the harness says so once instead of compacting on every step:

```
  ● context 159% full with nothing left to compact — the system prompt and the last messages alone fill it. Raise "contextSize" in the config.
```

`/compact` does the same on demand. Turn it off with `"autoCompact": false` in the config — you then get
a warning to run `/compact` before the oldest turns start getting dropped.

`/set dir <path>` changes the working directory while the session is running — file tools and `run_command`
switch to it immediately and the model is told about the new workspace. Paths may be absolute or relative
to the current directory, `~` is expanded, and quotes are allowed (`/set dir "C:\My Project"`).
`/set dir` without an argument (or `/cwd`) prints the current directory.

### Not getting cut off mid-task

The harness actively keeps a turn running to completion instead of stopping half-way:

- **Token-limit cut-offs are continued.** When a reply arrives with `finish_reason: "length"` (the model
  hit `max_tokens` mid-sentence), the harness appends a `[continue]` nudge and the model finishes the
  reply — the turn picks up where it stopped. You are told what happened:
  `the reply was cut off by the token limit — asking the model to continue…`
- **Half tool calls are never executed.** If the token limit cut a tool call mid-JSON, the call is *not*
  run; the model gets an error result asking it to re-issue the complete call, so no command ever runs
  with truncated arguments.
- **The step limit warns before it bites.** A turn is capped at `maxSteps` model replies (default 50 —
  previously a hardcoded 25). Three steps before the limit the model is told to wrap the task up or say
  what remains; if the limit is still reached, the message points at the `"maxSteps"` config key. Raise
  it for long autonomous runs (env override: `HARNESS_MAX_STEPS`).
- **Transient API errors are retried.** Connection failures and HTTP 408/429/5xx are retried up to three
  attempts (honoring `Retry-After`) — never once anything has been streamed to your terminal, so output
  is never duplicated. A turn aborted by a persistent error keeps its history: say "continue".

## CLI flags

```
node harness.js [--config <path>] [--dir <path>] [--init] [--once "<prompt>"] [--plan] [--stream | --no-stream] [--model <name>] [--prompt <full|compact>]
```

`--dir <path>` starts the session in a different working directory (same as typing `/set dir <path>` first).

`--prompt <full|compact>` picks the system prompt style for the session (see [Full or compact](#full-or-compact)).

`--once` runs a single turn and exits (handy for scripting/tests).

`--plan` starts in plan mode — combined with `--once` it prints a plan for a task and changes nothing
(`node harness.js --plan --once "add caching to the API client"`).

## Tests

```bash
npm test
```

Runs an end-to-end suite against a mock OpenAI server and a mock MCP server (streaming on/off, tool
round-trips, MCP tools, built-in tool smoke tests, search ignore rules, multiline input rules, and plan
mode: the read-only command rules, the tool gating, and a full plan → `/approve` → implementation run).
