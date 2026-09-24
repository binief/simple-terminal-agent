# coding-harness

A minimal, concretely working **coding harness** in Node.js — a single-session terminal chat agent for any OpenAI-compatible API, with built-in coding tools, OS-aware command execution, optional MCP servers, and a styled chat view.

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
  "temperature": 0.2,
  "streaming": true,
  "workspace": null,
  "shell": null,
  "lineEndings": "auto",
  "autoCompact": true,
  "commandTimeout": 60,
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
| `temperature` | Sampling temperature. |
| `streaming` | `true` = stream tokens as they arrive; `false` = show the reply when complete. Also `--stream` / `--no-stream`. |
| `workspace` | Root for file tools and commands. `null` = the directory you launch from. |
| `shell` | Override the command shell. `null` = OS-aware default (`cmd.exe /d /s /c` on Windows, bash/sh `-c` elsewhere). A string like `"powershell"` or `"zsh"` is understood; or `{ "command": "...", "args": [...] }` for full control. |
| `lineEndings` | Newline style for files the tools write: `auto` (default — keep the file's own style, else the OS default), `lf`, `crlf`, `cr`, `native`. |
| `autoCompact` | `true` (default) = summarize the conversation automatically before the context fills up. `false` = only warn; use `/compact` yourself. |
| `commandTimeout` | Default timeout (seconds) for `run_command`. |
| `mcp.servers` | Named MCP servers (see below). |

Env var overrides: `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`,
`HARNESS_STREAMING`, `HARNESS_CONTEXT_SIZE`, `HARNESS_TEMPERATURE`.

## Built-in coding tools

| Tool | What it does |
| --- | --- |
| `read_file` | Read a text file (optional line window) |
| `write_file` | Create/overwrite a file (makes parent dirs) |
| `edit_file` | Exact-text replacement, line-ending aware (see below) |
| `list_dir` | List a directory (dirs first) |
| `search_files` | Recursive regex content search (skips `node_modules`, `.git`, build output) |
| `run_command` | Run a shell command in the workspace, returns stdout/stderr/exit code |

**Line endings are OS-aware.** Files are read and normalised to `\n`, so a CRLF (Windows) file matches
the `old_text` you copied out of `read_file`, and it is written back with its own CRLF endings intact.
`write_file` keeps the existing file's style (new files get the OS default), and
`config.lineEndings` can force `lf` / `crlf` / `cr` / `native` when you want something specific.
If a match still fails, `edit_file` retries line-by-line ignoring trailing whitespace before erroring.

Commands run through an **OS-aware shell**: `cmd.exe /d /s /c` on Windows, `/bin/bash` (or `zsh`/`sh`) `-c` on Unix. The system prompt tells the model which OS/shell it is writing for.

> The harness runs with your user's permissions — review commands the model wants to run if that matters to you.

## MCP servers (optional)

Any [Model Context Protocol](https://modelcontextprotocol.io) stdio server can be plugged in via config. Its tools become `mcp_<server>_<tool>` and are offered to the model next to the built-ins.

```json
{
  "mcp": {
    "servers": {
      "fs": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/extra/dir"],
        "env": {}
      }
    }
  }
}
```

A failing server is reported at startup and skipped; the rest keep working.

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

## Session commands

`/help` `/config` `/tools` `/set dir <path>` `/cwd` `/usage` `/compact` `/reset` (clear conversation) `/clear` (clear screen) `/exit`

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

`/compact` does the same on demand. Turn it off with `"autoCompact": false` in the config — you then get
a warning to run `/compact` before the oldest turns start getting dropped.

`/set dir <path>` changes the working directory while the session is running — file tools and `run_command`
switch to it immediately and the model is told about the new workspace. Paths may be absolute or relative
to the current directory, `~` is expanded, and quotes are allowed (`/set dir "C:\My Project"`).
`/set dir` without an argument (or `/cwd`) prints the current directory.

## CLI flags

```
node harness.js [--config <path>] [--dir <path>] [--init] [--once "<prompt>"] [--stream | --no-stream] [--model <name>]
```

`--dir <path>` starts the session in a different working directory (same as typing `/set dir <path>` first).

`--once` runs a single turn and exits (handy for scripting/tests).

## Tests

```bash
npm test
```

Runs an end-to-end suite against a mock OpenAI server and a mock MCP server (streaming on/off, tool round-trips, MCP tools, built-in tool smoke tests).
