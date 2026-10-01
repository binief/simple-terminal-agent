# What `late-cli` does differently, and what of it we took

Status: **implemented.** Everything marked *adopted* below is in the code and covered by
`npm test` (444 checks). This document is the rationale — what the reference project does, why each
idea was or was not worth copying, and what it cost us.

---

## 1. What I analysed

[`mlhher/late-cli`](https://github.com/mlhher/late-cli) v2.0.0 — a terminal coding agent in Go,
~440 stars, read at commit `b14d12d`. Its pitch is one sentence on the README:

> a 64k context window doing 200k+ tokens of work.

That is the whole thesis, and it is a different thesis from ours. Our harness treats the context
window as a budget to **spend carefully** (compaction, read windows, a 20k cap on tool results).
late-cli treats it as a budget to **not spend at all**: the main agent is an orchestrator that plans
and verifies, and every noisy activity happens inside a throwaway agent whose context is deleted.

Two claims from its README that shaped the design, cited there and not independently verified by me:

- arXiv 2601.15300 — reasoning accuracy collapses by ~45% past 40–50% context utilisation. If true,
  "the window is only 60% full" is not the reassurance it sounds like.
- arXiv 2506.08343 (EMNLP 2025) — 27–51% of a reasoning trajectory is spent on self-reflection
  tokens that do not advance the task.

### The structural idea worth stealing

late-cli's enforcement is **physical, not textual**. A rule in a system prompt is a request; an
unregistered tool is a fact. Concretely:

| Agent | Has | Does not have |
| --- | --- | --- |
| Lead Orchestrator | plan/todo tools, readers, delegation | write tools |
| `coder` subagent | readers, writers, shell | delegation (no recursion, depth = 1) |
| `researcher` subagent | readers, shell | write tools, delegation |

Nothing in the prompt has to say "please don't edit files" to the researcher, and nothing has to say
"please don't spawn 40 agents" to the coder. The registry says it.

The same reflex shows up in its bash gate: rather than telling the model "prefer the search tool",
`LATE_BASH_GATE` intercepts `grep|rg|ag|ack|fd` (and `find` with a name filter) and refuses with a
message naming the native tool.

---

## 2. The adaptation table

| late-cli feature | Verdict | What we did |
| --- | --- | --- |
| Context isolation via subagents | **adopted** | `lib/delegate.js` — `delegate` tool, `coder`/`researcher`, isolated history, pruned registries, flat hierarchy |
| Physical enforcement over prompt rules | **adopted** | `delegation: "enforced"` unregisters `write_file`/`edit_file` on the main agent; subagents never get `delegate`/`present_plan` |
| Bash gate (`grep`/`cat`/`sed -i` → native tools) | **adopted** | `lib/gate.js`, `commandGate: enforce\|warn\|off` |
| `.llmignore` | **adopted** | `lib/ignore.js` — a hard boundary for `search_files` *and* `read_file`, unlike `.gitignore` |
| Report-only return value | **adopted** | subagent prompts end in a mandatory `# Your report` section; the tool returns that and a one-line cost header |
| Tokenizer-based accounting (embedded cl100k BPE) | **adapted** | no dependency: we calibrate chars/4 against the `prompt_tokens` the server actually reports (`lib/llm.js`) |
| Deterministic, cache-stable prompt prefix | **adapted** | the delegation block is appended *after* `# Environment`, so the cacheable prefix does not move |
| ~1,000-token system prompt | **partially** | our `compact` style is ~785 tokens and was already there; `full` stays the default |
| Two-tier stream retry (infra vs. bad-body budgets) | **noted** | our existing retry already distinguishes them; no change |
| Logit biasing of "Wait"/"Hmm" via `/tokenize` | **rejected** | llama-server-specific, needs a live tokenizer endpoint, silently wrong against OpenAI |
| podman sandbox | **rejected** | a dependency on a container runtime, and the harness is explicit that it runs with your permissions |
| Plugin system, git worktrees per agent | **rejected** | large surface, no payoff at this size |
| `create_todos`/`finish_todo` tools | **rejected** | `present_plan` + the pinned approved plan already cover it, at one tool instead of three |
| Blocking `>` shell redirection | **rejected** | too blunt — `cmd > out.log 2>&1` is normal and useful; the gate targets the *reading* commands, where the context cost actually is |

---

## 3. What changed in the code

| File | Change |
| --- | --- |
| `lib/delegate.js` | **New**, 360 lines. `DELEGATION_MODES`, `normalizeDelegation`, `SUBAGENT_EXCLUDED`, `ENFORCED_MAIN_EXCLUDED`, `SUBAGENTS`, `subagentPrompt`, `subagentBrief`, `delegationBlock`, `createDelegateTool`. A subagent gets a fresh message list, its own system prompt (~380 tokens), a registry with `delegate`/`present_plan` excluded (plus the writers, for a researcher), and a step budget. The run returns `{report, steps, note, tokens}`; the tool returns the report under a one-line cost header. |
| `lib/gate.js` | **New**, 161 lines. `GATE_MODES`, `normalizeGateMode`, `gateCommand`, `gateMessage`. Splits a command line on `&&`/`||`/`;`/`|`, strips `VAR=x` prefixes, and classifies each segment. |
| `lib/ignore.js` | `.llmignore` support: a second layer of matchers that `include_ignored` cannot override, plus `createLlmIgnoreGuard` for single-path checks from `read_file`. |
| `lib/llm.js` | Token calibration. `calibrateTokens(sample)` fits `scale`/`offset` from the server's reported `prompt_tokens` against our chars/4 guess, with a plausibility filter (constant or shrinking samples are rejected) and `MIN_SCALE = 1`. `tokenCalibration()`/`resetTokenCalibration()` for tests. |
| `lib/tools.js` | `run_command` consults the gate. The registry gained `register(def)` — the delegate tool needs the agent's own model loop, so it cannot exist when the built-ins are built, but it must still live in the one registry that `/tools`, plan mode and `execute()` read. Hiding is driven by an `exclude: [names]` context: `listTools()` drops them and `execute()` refuses them with a message naming the agent the tool belongs to, rather than pretending it never existed. |
| `lib/agent.js` | Builds and registers `delegate` when delegation is on; tracks `subagentCalls`; exposes `delegation`. |
| `lib/prompt.js` | Takes a `delegation` block, appended after `# Environment`. |
| `lib/config.js` | `commandGate`, `delegation`, `subagentMaxSteps` + `HARNESS_COMMAND_GATE` / `HARNESS_DELEGATION`. |
| `lib/ui.js` | `printSubagentStart`/`printSubagentEnd`, a `delegate` banner row, subagent calls in `/usage`. |
| `harness.js` | `createAgent` now runs **before** `ui.banner`, so the banner and `/tools` show what the model is actually offered (no `write_file` row in enforced mode). |
| `test/*` | 444 checks, up from 352. New sections: command gate, `.llmignore`, token calibration, delegation (unit + four end-to-end runs through the mock server). |

---

## 4. Decisions taken

1. **Delegation is off by default.** An orchestrator split is a real behaviour change: it costs a
   brief per step and it changes who edits files. A default session behaves exactly as it did
   before. `optional` offers the tool; `enforced` is the late-cli shape.

2. **`enforced` means "the main agent has no editors"**, not "the main agent may only run approved
   plan steps". The second definition was considered and dropped — it duplicates plan mode and makes
   the two features fight over who owns the step list.

3. **No escape hatch.** An earlier draft let the user re-enable a withheld tool for one call. It was
   removed: a bypass that exists will be used, and then enforcement is back to being a suggestion.

4. **Subagents get no MCP tools.** An MCP server is arbitrary and often stateful; handing one to an
   agent whose context is about to be deleted is a good way to get half-finished side effects that
   nobody can see. Subagents get built-ins only.

5. **The gate refuses `cat file.js`, not `cat`.** The gate is about commands that pour unbounded
   text into the context, so the shapes with no built-in equivalent are allowed through: bare
   `cat`/`cat -`, `cat x | wc -l`, `tail -f`, `sed -n '1,5p'`, and `find … -exec/-delete`. Every
   allowance is pinned by a test, because the failure mode of an over-eager gate (a model that
   cannot run its build) is worse than the one it prevents.

6. **Calibration, not a tokenizer.** Shipping a BPE table would break the zero-dependency rule and
   still be wrong for every non-OpenAI model. The server already tells us `prompt_tokens` on every
   response; fitting a line through those samples is ~80 lines and is right for whatever model is
   actually answering. It refuses to fit when the samples are implausible, so a server that reports
   a constant leaves the estimate alone.

7. **The delegation block goes after `# Environment`.** Prompt prefixes are cached by most providers;
   inserting a variable block early would invalidate the cache on every mode change. A test pins the
   ordering.

---

## 5. What we did not solve

- **Cost visibility.** `/usage` now separates subagent calls, but a subagent that burns 18k tokens to
  return a 40-line report is only *probably* a good trade. There is no measurement here of when it
  stops being one.
- **Brief quality.** The whole arrangement rests on the main agent writing a self-contained brief.
  When it writes a vague one, the subagent wastes its budget rediscovering context the caller already
  had. The prompt pushes hard on this ("write it for someone who has never seen this repository"),
  which is still a prompt-level fix in a design whose point is not relying on those.
- **Depth 1 is a guess.** late-cli fixes the hierarchy flat and so do we, on the argument that a tree
  of agents multiplies brief-writing cost. Neither project demonstrates that two levels would be
  worse.
