# System prompt proposal for `coding-harness`

Status: **implemented.** The prompt below is what `lib/prompt.js` produces; `lib/agent.js`
`systemPrompt()` now only gathers the environment and calls it. This document is kept as the
rationale — why each rule is there and where it came from.

---

## 1. What I analysed

Cloned and read `x1xhlol/system-prompts-and-models-of-ai-tools` (519 commits, ~100 prompt files).
I focused on the **terminal / autonomous-agent** prompts, because that is what this harness is —
not the web-app builders (v0, Lovable, Bolt, Orchids) whose rules are mostly about React scaffolding.

| Source | Why it matters here |
| --- | --- |
| `Open Source prompts/Codex CLI/…20250820.txt` | Closest analogue: terminal agent, plan tool, sandbox/approval tiers, very strong "final answer structure" section |
| `Anthropic/Claude Code/Prompt.txt` + `Claude Code 2.0.txt` | Verbosity contract (<4 lines), conventions-first editing, `file_path:line` references, TodoWrite discipline, "never commit unless asked" |
| `Cursor Prompts/Agent CLI Prompt 2025-08-07.txt` | Persistence clause, `<status_update_spec>`/`<summary_spec>`, aggressive parallel-tool-call mandate, code-style block |
| `Warp.dev/Prompt.txt` | Best shell-hygiene rules anywhere: no interactive/pager commands, avoid `cd`, never `cat` to read files, never edit files via shell |
| `Augment Code/gpt-5-agent-prompts.txt` | "One high-signal discovery call, then decide", tool-selection matrix, task-list triggers |
| `Google/Antigravity/planning-mode.txt` | PLANNING → EXECUTION → VERIFICATION mode machine, plan artifact + verification plan |
| `Devin AI/Prompt.txt`, `Junie`, `Qoder`, `Traycer` | Long-horizon autonomy, "report the blocker instead of a third variation" |

### Patterns that recur in ≥4 of them (the ones worth copying)

1. **Identity + environment block up front** — cwd, OS/shell, date, git state, mode. Every single one.
2. **Persistence clause** — "keep going until the query is fully resolved; only yield when solved."
3. **Explicit verbosity contract** for a terminal renderer, with a separate *final answer* spec.
4. **Preamble / status updates** before tool batches (Codex, Cursor, Augment) — 1 short sentence.
5. **Parallelise reads, sequence writes** — stated as a hard rule, not a suggestion.
6. **Read before edit; never re-read after a successful write** (Codex states both explicitly).
7. **Conventions-first**: check the manifest before assuming a library exists; mimic local style.
8. **Root-cause over patch; don't fix unrelated bugs — mention them instead.**
9. **Verification ladder**: narrowest test → broader → lint/typecheck, and "never claim success unverified."
10. **Safety trio**: no secrets, no unrequested commits/pushes, warn before destructive ops.
11. **Explicit anti-pattern list** (the "NEVER" block) — models follow prohibitions better when enumerated.
12. **Tool-specific quirks documented inline** (apply_patch grammar, 5k-line read chunks, ERE escaping).

### Things I deliberately did **not** copy

- TodoWrite/task-list tooling — this harness has no todo tool (`present_plan` covers planning).
- Sub-agent / `Task` delegation, WebFetch, screenshots, memory files — no such tools here.
- Cursor's `startLine:endLine:filepath` citation fences — the terminal renderer can't click them;
  plain `path.js:42` (Claude Code style) is what works here.
- Codex's `apply_patch` grammar — this harness uses `edit_file` with exact `old_text`.
- Emoji/personality flourishes ("Ok cool, so I've wrapped my head around the repo") — noise in a log.

---

## 2. What the current prompt already does well

Your existing prompt is above average: it has the environment block, the 5-phase execution protocol,
locate-then-window, batching, anti-loop rules and verify-before-claiming. Those all survive below.

## 3. Gaps the reference set exposes

| Gap | Fix in the new prompt |
| --- | --- |
| No persistence clause — model may yield mid-task | §Autonomy: "keep going until resolved" + what *does* justify stopping |
| No verbosity contract — replies drift long in a terminal | §Communication: preamble ≤1 line, final summary ≤10 lines, direct answers for questions |
| Question vs. task not distinguished (Warp's best idea) | §Autonomy: answer questions without mutating anything |
| No `file:line` reference convention | §Communication |
| Shell hygiene missing (pagers, interactive cmds, `cd`, `cat` to read) | §run_command |
| "No comments unless asked", "no unrelated fixes", "no license headers" absent | §Code quality |
| Never `git commit`/`push`/branch unless asked — not stated | §Safety |
| Library-exists check before importing | §Code quality |
| Harness mechanics invisible to the model (step budget, compaction, 20k tool-result cap, `[continue]`) | §Harness facts |
| Tool list not summarised in prose (models pick better with a 1-line matrix) | §Tools |
| Defensive-security stance / malicious-request refusal absent | §Safety |

---

## 4. The prompt (as shipped)

Values in `{braces}` are filled in by `buildSystemPrompt()`. The Git line is omitted when the
workspace is not a repository, and the plan/approved-plan/instructions blocks only appear when they
apply. The first Autonomy bullet is mode-dependent: in plan mode it becomes *"Research until you can
hand over a complete, concrete plan — the plan is the deliverable, not the code"*, because the build-mode
wording ("do not hand back a plan instead of the work") would otherwise contradict plan mode.
Measured cost: ~9.1k characters, ≈2.3k tokens — about 3.5% of the default 64k context, in line with
Claude Code (~3k) and below Codex CLI (~5k).

```text

```

## 5. What changed in the code

| File | Change |
| --- | --- |
| `lib/prompt.js` | **New.** `buildSystemPrompt({ cwd, platform, date, planning, git, blocks, instructions })` assembles the prompt; `gitInfo(cwd)` reads branch + dirty count (1.5s timeout, 3s cache, silent when git is absent or the directory is not a repo); `clearGitCache()` for tests. |
| `lib/agent.js` | `systemPrompt()` reduced to gathering `cwd`, shell, plan blocks and instructions and calling `buildSystemPrompt()`. Compaction gained a guard: when the summarizable part of the history is under 500 tokens, it warns once ("nothing left to compact — raise contextSize") instead of compacting on every step. Exposed by the larger prompt; it would also have hit any user with a small `contextSize`. |
| `test/run-tests.mjs` | The system-prompt block now asserts every section, the environment/git line, the harness-mechanics block, block ordering (defaults → plan → instructions) and determinism of `buildSystemPrompt`; the compaction tests use a realistic `contextSize` and a new case covers the cramped-context warning. 304 checks pass. |
| `README.md` | "Work method (the system prompt)" rewritten as a section-by-section table; compaction docs mention the new warning. |
| `lib/tools.js` | `TOOL_LIMITS` exported (read window caps + tool-result cap). The `read_file` description, the tool schema and the prompt all interpolate it, so the numbers the model is told cannot drift from the ones enforced. |

## 6. Decisions taken

1. **Git line** — included. Costs one `git rev-parse` + one `git status --porcelain` per prompt rebuild
   (session start, `/set dir`, mode switch), cached for 3s, silently skipped outside a repository.
2. **Length** — both, switchable. `full` (≈2.2k tokens) is the default; `compact` (≈790 tokens) keeps
   every rule that changes behaviour and drops the explanations, the tool matrix and the
   harness-mechanics section. Set it with `promptStyle` in the config, `--prompt <style>`,
   `HARNESS_PROMPT_STYLE`, or `/set prompt <style>` mid-session. Both styles are generated from the
   same module, so a rule added to one is a deliberate choice about the other rather than drift.
3. **Comments** — softened from Claude Code's "no comments unless asked" to "comment the way the
   surrounding file does", which matches this codebase.
4. **git commit** — kept the hard rule: never commit, push or switch branches unless asked.
