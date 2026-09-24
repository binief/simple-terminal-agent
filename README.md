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
| `commandTimeout` | Default timeout (seconds) for `run_command`. |
| `mcp.servers` | Named MCP servers (see below). |

Env var overrides: `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`,
`HARNESS_STREAMING`, `HARNESS_CONTEXT_SIZE`, `HARNESS_TEMPERATURE`.

## Built-in coding tools

| Tool | What it does |
| --- | --- |
| `read_file` | Read a text file (optional line window) |
| `write_file` | Create/overwrite a file (makes parent dirs) |
| `edit_file` | Exact-text replacement (`old_text` must match the file exactly) |
| `list_dir` | List a directory (dirs first) |
| `search_files` | Recursive regex content search (skips `node_modules`, `.git`, build output) |
| `run_command` | Run a shell command in the workspace, returns stdout/stderr/exit code |

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

`/help` `/config` `/tools` `/reset` (clear conversation) `/clear` (clear screen) `/exit`

One conversation per run (single session). `/reset` starts fresh context inside the same session.

## CLI flags

```
node harness.js [--config <path>] [--init] [--once "<prompt>"] [--stream | --no-stream] [--model <name>]
```

`--once` runs a single turn and exits (handy for scripting/tests).

## Tests

```bash
npm test
```

Runs an end-to-end suite against a mock OpenAI server and a mock MCP server (streaming on/off, tool round-trips, MCP tools, built-in tool smoke tests).
