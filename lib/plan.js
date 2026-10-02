/* Plan mode: research first, implement only after the user approves.
 *
 * In plan mode the workspace is read-only — the mutating built-ins are not
 * offered at all, run_command accepts only commands that cannot change
 * anything, and the model is asked to finish with present_plan. The user
 * reviews that plan and accepts it with /approve, which switches back to build
 * mode with the approved plan pinned in the system prompt.
 *
 * Everything here is pure (no I/O, no UI) so the rules can be unit-tested.
 */

export const PLAN_MODE = 'plan';
export const BUILD_MODE = 'build';

/** Marker that identifies the message sent when a plan is approved (used by the test mock). */
export const APPROVED_TAG = '[plan approved]';

/* ------------------------------------------------------------------ */
/* Read-only command classification                                    */
/* ------------------------------------------------------------------ */

/**
 * Base commands that only read. Anything that can run arbitrary code
 * (node, python, xargs, env, make, …) is deliberately absent: it would be a
 * hole straight through the read-only rule.
 */
const READ_ONLY_COMMANDS = new Set([
  // listing / navigation / metadata
  'ls', 'dir', 'vdir', 'tree', 'pwd', 'cd', 'chdir', 'stat', 'file', 'du', 'df',
  'basename', 'dirname', 'realpath', 'readlink', 'wslpath',
  // reading files
  'cat', 'bat', 'type', 'head', 'tail', 'nl', 'wc', 'strings', 'xxd', 'od', 'hexdump',
  // searching
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'findstr', 'locate',
  'which', 'where', 'whereis',
  // text pipelines — they write to stdout only (redirection is rejected separately)
  'sort', 'uniq', 'cut', 'tr', 'column', 'diff', 'cmp', 'comm', 'jq', 'yq', 'fc',
  'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'cksum',
  // environment / trivia
  'echo', 'printf', 'date', 'whoami', 'hostname', 'uname', 'ver', 'id', 'uptime',
  'printenv', 'true', 'false', 'test', 'sleep',
]);

/** Flags that turn an otherwise read-only command into one that writes or executes. */
const DENIED_FLAGS = {
  find: /^(-delete|-exec|-execdir|-ok|-okdir|-fprint|-fprintf|-fls)$/i,
  fd: /^(-x|-X|--exec|--exec-batch)$/i,
  rg: /^(--pre|--hostname-bin)(=.*)?$/i,
  sort: /^(-o|--output)(=.*)?$/i,
  tail: /^(-f|-F|--follow)(=.*)?$/i,
};

/** `<anything> --version` / `--help` cannot do damage, whatever the binary is. */
const INERT_FLAGS = new Set(['--version', '-v', '-V', '--help', '-h', '-?', '/?']);

/** git subcommands that never modify the repository or the working tree. */
const GIT_READ_ONLY = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'annotate', 'shortlog', 'reflog', 'whatchanged',
  'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'rev-parse', 'rev-list', 'describe', 'grep',
  'show-ref', 'symbolic-ref', 'name-rev', 'merge-base', 'diff-tree', 'diff-index', 'count-objects',
  'check-ignore', 'check-attr', 'verify-commit', 'verify-tag', 'var', 'version', 'help',
]);

/**
 * git subcommands that both list and modify — allowed only in their listing form.
 * `bare`: the subcommand on its own already lists. `verbs`: read-only sub-verbs.
 * `flags`: flags that keep it read-only.
 */
const GIT_LISTING = {
  branch: { bare: true, verbs: null, flags: /^(-v|-vv|-a|-r|-l|--list|--all|--remotes|--verbose|--show-current|--contains|--merged|--no-merged|--color|--no-color|--sort=.*|--format=.*|--points-at=.*)$/ },
  tag: { bare: true, verbs: null, flags: /^(-l|--list|-n\d*|--contains|--merged|--no-merged|--sort=.*|--format=.*|--points-at=.*)$/ },
  remote: { bare: true, verbs: /^(show|get-url)$/, flags: /^(-v|--verbose)$/ },
  stash: { bare: false, verbs: /^(list|show)$/, flags: /^(-p|--patch|--stat|--name-only|-u)$/ },
  worktree: { bare: false, verbs: /^list$/, flags: /^(-v|--porcelain)$/ },
  submodule: { bare: true, verbs: /^(status|summary)$/, flags: /^(--cached|--recursive)$/ },
};

/** `git config` is read-only only when one of these is present. */
const GIT_CONFIG_READ = /^(-l|--list|--get|--get-all|--get-regexp|--get-urlmatch|--show-origin|--show-scope)$/;

/** Node package managers: subcommands that only report. */
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PM_READ_ONLY = new Set([
  'ls', 'list', 'view', 'info', 'show', 'outdated', 'why', 'audit', 'ping', 'root', 'prefix',
  'bin', 'whoami', 'explain', 'search', 'doctor', 'config',
]);

/**
 * Split a command line into the segments a shell would run separately
 * (`&&`, `||`, `;`, `|`, newline, background `&`) and flag the constructs that
 * make a static check meaningless. Quotes are respected; `2>&1` is not a write.
 */
export function scanCommand(command) {
  const src = String(command ?? '');
  const segments = [];
  let cur = '';
  let quote = null;
  let redirectsOutput = false;
  let substitutes = false;
  const flush = () => {
    const t = cur.trim();
    if (t) segments.push(t);
    cur = '';
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1] ?? '';
    if (ch === '\\' && next && quote !== "'") {
      cur += ch + next;
      i++;
      continue;
    }
    if (quote) {
      if (quote === '"' && (ch === '`' || (ch === '$' && next === '('))) substitutes = true;
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '`' || (ch === '$' && next === '(')) {
      substitutes = true;
      cur += ch;
      continue;
    }
    if (ch === '>') {
      // 2>&1 / >&2 only duplicate a descriptor — they do not write a file
      if (!/^>>?\s*&\s*\d/.test(src.slice(i))) redirectsOutput = true;
      cur += ch;
      continue;
    }
    if (ch === '&') {
      if (/[>]\s*$/.test(cur) && /^&\s*\d/.test(src.slice(i))) {
        cur += ch; // part of 2>&1
        continue;
      }
      if (next === '&') i++;
      flush();
      continue;
    }
    if (ch === '|') {
      if (next === '|') i++;
      flush();
      continue;
    }
    if (ch === ';' || ch === '\n') {
      flush();
      continue;
    }
    cur += ch;
  }
  flush();
  return { segments, redirectsOutput, substitutes };
}

/** Split one segment into argv, honouring quotes and backslash escapes. */
export function splitArgs(segment) {
  const src = String(segment ?? '');
  const argv = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && src[i + 1]) {
        cur += src[++i];
      } else if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\' && src[i + 1]) {
      cur += src[++i];
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) argv.push(cur);
      cur = '';
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) argv.push(cur);
  return argv;
}

/** "/usr/bin/git" -> "git", "NPM.CMD" -> "npm" */
function baseName(word) {
  return String(word)
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.(exe|cmd|bat|com|ps1)$/i, '')
    .toLowerCase();
}

function gitIsReadOnly(args) {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(a)) {
      i += 2; // flag with a value
      continue;
    }
    if (a.startsWith('-')) {
      i++;
      continue;
    }
    break;
  }
  const sub = (args[i] || '').toLowerCase();
  const rest = args.slice(i + 1);
  if (!sub) return true; // bare `git` prints usage
  if (GIT_READ_ONLY.has(sub)) return true;
  if (sub === 'config') {
    const positional = rest.filter((a) => !a.startsWith('-'));
    return rest.some((a) => GIT_CONFIG_READ.test(a)) && positional.length <= 1;
  }
  const spec = GIT_LISTING[sub];
  if (!spec) return false;
  if (!rest.length) return spec.bare;
  const [first, ...more] = rest;
  if (spec.verbs?.test(first)) return more.every((a) => !a.startsWith('-') || spec.flags.test(a));
  return rest.every((a) => spec.flags.test(a));
}

function packageManagerIsReadOnly(base, args) {
  const sub = (args.find((a) => !a.startsWith('-')) || '').toLowerCase();
  if (!sub) return false;
  if (!PM_READ_ONLY.has(sub)) return false;
  // `npm config set …` writes; only the reading verbs are fine
  if (sub === 'config') return args.some((a) => /^(get|list|ls)$/i.test(a));
  return true;
}

/**
 * Is `command` safe to run in plan mode?
 * Returns `{ ok: true }` or `{ ok: false, reason }` with a reason worth showing
 * to the model. `extraAllow` comes from config.planAllowCommands: a bare word
 * allows that command ("make"), a value with a space allows that exact prefix
 * ("npm test").
 */
export function isReadOnlyCommand(command, extraAllow = []) {
  const text = String(command ?? '').trim();
  if (!text) return { ok: false, reason: 'empty command' };

  const allowWords = new Set();
  const allowPrefixes = [];
  for (const entry of extraAllow || []) {
    const value = String(entry ?? '').trim();
    if (!value) continue;
    if (/\s/.test(value)) allowPrefixes.push(splitArgs(value).map((w) => w.toLowerCase()));
    else allowWords.add(baseName(value));
  }

  const { segments, redirectsOutput, substitutes } = scanCommand(text);
  if (redirectsOutput) return { ok: false, reason: 'it redirects output into a file (> or >>)' };
  if (substitutes) return { ok: false, reason: 'it uses command substitution ($(…) or backticks)' };
  if (!segments.length) return { ok: false, reason: 'empty command' };

  for (const segment of segments) {
    const argv = splitArgs(segment);
    let at = 0;
    while (at < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[at])) at++; // FOO=bar prefix
    if (at >= argv.length) continue; // assignment only — nothing runs
    const words = argv.slice(at).map((w) => w.toLowerCase());
    if (allowPrefixes.some((p) => p.every((w, k) => words[k] === w))) continue;

    const base = baseName(argv[at]);
    const args = argv.slice(at + 1);
    if (allowWords.has(base)) continue;
    if (args.length && args.every((a) => INERT_FLAGS.has(a.toLowerCase()))) continue;
    if (base === 'git') {
      if (gitIsReadOnly(args)) continue;
      const sub = args.find((a) => !a.startsWith('-'));
      return { ok: false, reason: `\`${sub ? `git ${sub}` : 'git'}\` can modify the repository` };
    }
    if (PACKAGE_MANAGERS.has(base)) {
      if (packageManagerIsReadOnly(base, args)) continue;
      return { ok: false, reason: `\`${base}\` can install or run scripts` };
    }
    if (READ_ONLY_COMMANDS.has(base)) {
      const denied = DENIED_FLAGS[base];
      const bad = denied && args.find((a) => denied.test(a));
      if (bad) return { ok: false, reason: `\`${base} ${bad}\` can run or write` };
      continue;
    }
    return { ok: false, reason: `\`${base}\` is not a known read-only command` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* The plan itself                                                     */
/* ------------------------------------------------------------------ */

const asList = (value) => {
  if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim()).filter(Boolean);
  const text = String(value ?? '').trim();
  if (!text) return [];
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
};

/** Validate/normalize what present_plan was called with. Throws on unusable input. */
export function normalizePlan(raw = {}) {
  const title = String(raw.title ?? '').trim();
  const steps = asList(raw.steps);
  if (!title) throw new Error('present_plan needs a short "title" describing the change');
  if (!steps.length) throw new Error('present_plan needs "steps": an ordered list of concrete steps');
  return {
    title,
    steps,
    files: asList(raw.files),
    verification: String(raw.verification ?? '').trim(),
    notes: String(raw.notes ?? '').trim(),
    createdAt: new Date().toISOString(),
  };
}

/** The plan as Markdown — what the model is shown once the plan is approved. */
export function formatPlan(plan) {
  if (!plan) return '';
  const lines = [`# ${plan.title}`];
  if (plan.files?.length) lines.push(`Files: ${plan.files.join(', ')}`);
  lines.push(...plan.steps.map((step, i) => `${i + 1}. ${step}`));
  if (plan.verification) lines.push(`Verification: ${plan.verification}`);
  if (plan.notes) lines.push(`Notes: ${plan.notes}`);
  return lines.join('\n');
}

/** Shared mode + plan state; the tools and the agent both hold the same object. */
export function createPlanState({ mode = BUILD_MODE } = {}) {
  let current = mode === PLAN_MODE ? PLAN_MODE : BUILD_MODE;
  let proposed = null; // the last plan present_plan produced
  let approved = null; // the plan the user accepted
  let fresh = false; // a plan was presented in the current turn

  return {
    get mode() {
      return current;
    },
    get planning() {
      return current === PLAN_MODE;
    },
    get proposed() {
      return proposed;
    },
    get approved() {
      return approved;
    },
    setMode(next) {
      current = next === PLAN_MODE ? PLAN_MODE : BUILD_MODE;
      if (current === PLAN_MODE) fresh = false;
      return current;
    },
    /** present_plan: record the plan and mark it for the turn loop to render. */
    present(raw) {
      proposed = normalizePlan(raw);
      fresh = true;
      return proposed;
    },
    /** The plan presented during this turn, once — the agent uses it to stop the turn. */
    takePresented() {
      if (!fresh) return null;
      fresh = false;
      return proposed;
    },
    /** Accept the proposed plan and go back to build mode. */
    approve() {
      if (!proposed) return null;
      approved = proposed;
      proposed = null;
      fresh = false;
      current = BUILD_MODE;
      return approved;
    },
    /** Drop every plan (used by /reset). */
    clear() {
      proposed = null;
      approved = null;
      fresh = false;
    },
    /**
     * Put back a mode and the plans that went with it (used by /load).
     * `fresh` stays false: a plan restored from a file was not presented in
     * this turn, so the turn loop must not stop as though it had just arrived.
     */
    restore({ mode: m, proposed: p = null, approved: a = null } = {}) {
      current = m === PLAN_MODE ? PLAN_MODE : BUILD_MODE;
      proposed = p;
      approved = a;
      fresh = false;
      return current;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Prompts and messages                                                */
/* ------------------------------------------------------------------ */

/** Why a tool or command was refused, plus what to do instead. */
export function planDenied(what, reason = '') {
  return (
    `plan mode is read-only — ${what} was not run${reason ? ` (${reason})` : ''}. ` +
    'Inspect the project with read_file, list_dir, search_files and read-only commands ' +
    '(ls, cat, git status/log/diff, …), then call present_plan. ' +
    'The user approves the plan with /approve, and you implement it after that.'
  );
}

/** System-prompt section that is active while planning. */
export const PLAN_MODE_RULES = [
  '# Plan mode',
  'PLAN MODE IS ON — research and plan, do not implement.',
  '- This overrides the Autonomy section above: in plan mode the plan is the deliverable, not the code. Research until you can hand over a complete, concrete plan, then stop.',
  '- The workspace is read-only: write_file and edit_file are not available, and run_command only accepts commands that cannot change anything (ls, cat, git status/log/diff, …). Do not look for a way around that.',
  '- Investigate first: locate the code the task touches with search_files, read it with read_file, and check how the project is built, tested and configured before planning anything.',
  '- Then call present_plan exactly once: a short title, the ordered steps you would take (each naming the file it changes), the files affected, how the result will be verified, and any risks, assumptions or open questions in the notes.',
  '- Steps must be concrete — "add a --version branch to parseArgs in harness.js", not "update the CLI". Do not write the finished code: the plan describes the work, not the diff.',
  '- If the request is ambiguous, state the question in the notes instead of guessing.',
  '- After present_plan, stop and wait. The user reviews the plan and approves it with /approve; implementation starts only then.',
].join('\n');

/** System-prompt section carrying the plan the user approved. */
export function approvedPlanBlock(plan) {
  return [
    '# Approved plan',
    'The user reviewed and accepted this plan — it is the task:',
    formatPlan(plan),
    'Work through the steps in order and verify the result. If a step turns out to be wrong or impossible, say so and explain what you did instead — do not silently redesign the plan.',
  ].join('\n');
}

/**
 * The message that starts the implementation turn after /approve.
 * `plan` is null when the model described its approach in prose instead of
 * calling present_plan — the user still read it and approved it.
 */
export function approvalMessage(plan, note = '') {
  const extra = String(note ?? '').trim();
  const head = plan
    ? `${APPROVED_TAG} The user approved the plan below. Implement it now, step by step.\n${formatPlan(plan)}\n`
    : `${APPROVED_TAG} The user approved the approach you just described. Implement it now, step by step.\n`;
  return (
    head +
    (extra ? `Additional instructions from the user: ${extra}\n` : '') +
    'Verify the result (build, tests, linters) and report what changed.'
  );
}
