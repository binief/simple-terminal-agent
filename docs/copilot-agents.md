# GitHub Copilot custom agents — the basic.mjs pipeline as `.agent.md` files

`basic.mjs` has three phases: **REWRITE** shapes the raw request into a prompt, **PLAN** researches it
read-only and writes the plan, **IMPLEMENT** makes the change. `.github/agents/` carries the same
pipeline into GitHub Copilot, one agent per phase, so the request is turned into a correct prompt
before any code moves — and the phase boundary is a **tool boundary**, not a request in a prompt.

| basic.mjs mode | Copilot agent | Tools | Gives back |
| --- | --- | --- | --- |
| `rewrite` (`rewriteSystem()`) | [`rewrite`](../.github/agents/rewrite.agent.md) | `read`, `search` | a `REFINED PROMPT` block |
| `plan` (`planSystem()`) | [`plan`](../.github/agents/plan.agent.md) | `read`, `search`, `execute` (read-only commands) | an `IMPLEMENT PROMPT` block |
| `implement` (no extra system prompt) | [`implement`](../.github/agents/implement.agent.md) | `read`, `edit`, `search`, `execute`, `todo` | the change, verified and reported |

```
raw request ──▶ rewrite ──▶ REFINED PROMPT ──▶ plan ──▶ IMPLEMENT PROMPT ──▶ implement ──▶ verified diff
                 (read-only)                    (read-only)                  (the only writer)
```

## Using the agents

**VS Code / Copilot CLI.** Pick the agent from the agent dropdown (`rewrite`, `plan`, `implement`), or
run `copilot --agent plan` in the CLI. Each agent's file ends with a handoff button — *Plan this
refined prompt*, *Implement this plan* — which switches to the next agent with the conversation and a
pre-filled prompt, so a task moves phase by phase:

1. Select **rewrite**, paste the raw request. The reply is only the `REFINED PROMPT` block.
2. Review it, then click **Plan this refined prompt** (or paste the block into **plan** yourself).
3. Review the plan, then click **Implement this plan**.
4. **implement** makes the change, runs the verification the plan names, and reports file by file.

**GitHub.com coding agent.** Custom agents are selected in the task UI; `handoffs` are not supported
there (they are a VS Code/CLI feature and are ignored), so run the phases in sequence — the
`REFINED PROMPT` text is what you give the `plan` agent, and the `IMPLEMENT PROMPT` text is what you
give the `implement` agent. `rewrite` sets `disable-model-invocation: true`, so it is never picked
automatically: the shaping phase is opt-in, exactly as `config rewrite: true` is in `basic.mjs`.

## Why the tools are the guardrail

`basic.mjs` enforces its read-only phases in code: `write_file`/`edit_file` refuse every project path
and `run_command` accepts only read-only commands (`ls`, `cat`, `grep`, `find`,
`git status`/`log`/`diff`, …). The Copilot frontmatter is the equivalent enforcement:

- **rewrite** holds no writer at all — `read` and `search` cannot change a file, so the phase that
  *changes the request* cannot change the repository.
- **plan** holds no editing tool either. `execute` stays, because a plan is better when it can read
  `git log`/`git diff` and the file listing, and the body fixes that tool to the same read-only
  commands `PLAN` mode allows (builds, installs, test runs, redirection, `sed -i`, `git commit`/`push`
  are refused in writing). If you want a strictly read-only planner, delete `execute` from
  `tools:` in `plan.agent.md` — nothing else depends on it.
- **implement** is the only agent with `edit`, and it carries the working rules: read before changing,
  smallest correct diff, finish the task in one run, never commit or push unless asked, verify before
  reporting.

## The two blocks are the interface

Both markers are read by `basic.mjs` itself (`lib/plan.js`: `extractRefinedPrompt()` /
`extractImplementPrompt()`), tolerantly — decorated markers, `***` or missing closing delimiters, a
reply cut off by the token limit. So the pipeline is not Copilot-only: paste a `REFINED PROMPT` block
into `node basic.mjs` and it can plan it, paste an `IMPLEMENT PROMPT` into `/implement` and the CLI runs
it from the same brief.

`test/copilot-agents.mjs` checks exactly that: the files' frontmatter, the tool allowlists above, the
handoff chain (rewrite → plan → implement, each `send: false` so the user confirms every phase), and
that the documented block format round-trips through `basic.mjs`'s extractors.

## Plan files

`basic.mjs` keeps `planDir` **outside** the workspace so a plan is never part of the project; a Copilot
agent can only write inside the repository. The rule is kept with a git-ignored directory instead:

```
.copilot/plans/plan-2026-10-14T09-30-00.md    # git-ignored, never part of the project
```

The plan phase cannot write it (it holds no editor), so the **implement** phase saves the brief it
received there before its first change — the resume point if the session is lost, mirroring
`savePlan()`: the plan alone, or `# Refined prompt` → `# Original request (superseded …)` →
`# Implement prompt` when the plan grew out of a rewrite. `.gitignore` in this repository carries the
entry; copy it when you copy the agents into another project.

## Customizing

- **Model.** No `model` is set, so each agent runs on the model you picked in the chat. Add
  `model: Claude Sonnet 4.5` (or a list, tried in order) to pin one per phase — a smaller model for
  `rewrite`, the strongest one for `plan` is a reasonable split.
- **Surface.** No `target` is set, so the agents are available in the IDE and on GitHub.com. Set
  `target: vscode` (or `github-copilot`) to narrow that.
- **Scope.** The agents write to `.copilot/plans/`, which is repository-relative and works anywhere.
  Teams that want plans committed can drop the `.gitignore` entry and say so in `plan.agent.md`.
