/* Command gate: catch shell commands that duplicate a built-in tool.
 *
 * The system prompt already asks the model not to grep through run_command or
 * read files with `cat`. Asking is not enough — small models fall back on the
 * shell habits in their training data, and the cost is paid in context:
 * `grep -r foo .` walks node_modules and returns a wall of text, where
 * search_files prunes dependencies, build output and .gitignore'd paths and
 * caps the result; `cat big.js` dumps a whole file where read_file returns a
 * window and says what remains.
 *
 * So the rule is enforced where it can be: the command is refused with the
 * tool to use instead. The refusal is a tool result, not an error — the model
 * reads it and re-issues the right call, which is the behaviour we want.
 *
 * Only commands that have a strictly better built-in equivalent are gated.
 * Builds, tests, git, package managers and everything else go straight
 * through: this is not a security boundary (plan mode is), it is a context
 * budget.
 */

import { scanCommand, splitArgs } from './plan.js';

/** config.commandGate values. */
export const GATE_MODES = ['enforce', 'warn', 'off'];

const GATE_ALIASES = {
  enforce: 'enforce',
  on: 'enforce',
  true: 'enforce',
  block: 'enforce',
  strict: 'enforce',
  warn: 'warn',
  warning: 'warn',
  soft: 'warn',
  off: 'off',
  false: 'off',
  none: 'off',
  allow: 'off',
};

/** Canonical gate mode for a configured value; anything unknown is "enforce". */
export function normalizeGateMode(value) {
  return GATE_ALIASES[String(value ?? '').trim().toLowerCase()] || 'enforce';
}

/** Content search tools — search_files does the same thing without the noise. */
const SEARCH_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ripgrep', 'ag', 'ack', 'ack-grep', 'fd', 'fdfind']);

/** `find` flags that make it a search rather than a file operation. */
const FIND_SEARCH_FLAGS = new Set([
  '-name', '-iname', '-path', '-ipath', '-regex', '-iregex', '-lname', '-ilname', '-wholename', '-iwholename',
]);

/** `find` flags that make it do something — those are a real command, not a search. */
const FIND_ACTION_FLAGS = new Set(['-exec', '-execdir', '-delete', '-ok', '-okdir', '-fprint', '-fls']);

/** Pagers and file dumpers — read_file windows the output and reports what is left. */
const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'tac']);

/** In-place stream editors: edit_file fails loudly instead of silently rewriting. */
const INPLACE_EDITORS = new Set(['sed', 'perl', 'ruby', 'gawk']);

/** "/usr/bin/grep" -> "grep", "GREP.EXE" -> "grep" */
function baseName(word) {
  return String(word)
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.(exe|cmd|bat|com|ps1)$/i, '')
    .toLowerCase();
}

/** Strip a leading `FOO=bar` assignment run and return the remaining argv. */
function effectiveArgv(segment) {
  const argv = splitArgs(segment);
  let at = 0;
  while (at < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[at])) at++;
  return argv.slice(at);
}

/** Does this argv edit a file in place (`sed -i`, `perl -pi -e`)? */
function editsInPlace(base, args) {
  if (!INPLACE_EDITORS.has(base)) return false;
  return args.some((a) => a === '-i' || a === '--in-place' || /^--in-place=/.test(a) || /^-[a-z]*i[a-z]*$/i.test(a));
}

/**
 * Check one command line.
 * Returns null when it may run, or `{ command, tool, reason }` describing the
 * first segment that duplicates a built-in tool.
 */
export function gateCommand(command) {
  const text = String(command ?? '').trim();
  if (!text) return null;
  const { segments } = scanCommand(text);
  const single = segments.length === 1;

  for (const segment of segments) {
    const argv = effectiveArgv(segment);
    if (!argv.length) continue;
    const base = baseName(argv[0]);
    const args = argv.slice(1);

    if (SEARCH_COMMANDS.has(base)) {
      return {
        command: base,
        tool: 'search_files',
        reason: `\`${base}\` searches file contents`,
      };
    }

    if (base === 'find' && args.some((a) => FIND_SEARCH_FLAGS.has(a)) && !args.some((a) => FIND_ACTION_FLAGS.has(a))) {
      return {
        command: 'find',
        tool: 'search_files',
        reason: '`find` is being used to locate files by name',
      };
    }

    if (editsInPlace(base, args)) {
      return {
        command: base,
        tool: 'edit_file',
        reason: `\`${base}\` is editing a file in place`,
      };
    }

    // Reading is only gated when the command is nothing but a read: `cat x`
    // dumps a file into the context, while `cat x | wc -l` is a computation
    // whose output is one line. Reading stdin (`cat`, `cat -`) is not a file
    // read at all, and `tail -f` is caught by the non-interactive rule.
    if (single && READ_COMMANDS.has(base)) {
      const files = args.filter((a) => a !== '-' && !a.startsWith('-'));
      const follows = args.some((a) => a === '-f' || a === '-F' || a === '--follow' || /^-[a-zA-Z]*f/.test(a));
      if (files.length && !follows) {
        return {
          command: base,
          tool: 'read_file',
          reason: `\`${base}\` prints whole files into the conversation`,
        };
      }
    }
  }
  return null;
}

/** The message the model gets back, phrased so it can act on it. */
export function gateMessage(hit, { blocked = true } = {}) {
  const advice = {
    search_files:
      'Use search_files instead: it skips dependencies, build output, caches and .gitignore\'d paths, and caps its output ' +
      '(pass include_ignored: true when you really need those paths).',
    read_file:
      'Use read_file instead: it returns a line window, reports how many lines remain, and gives you text that edit_file can match.',
    edit_file:
      'Use edit_file instead: it matches exact text, handles line endings, and fails loudly instead of silently rewriting the file.',
  }[hit.tool];
  return blocked
    ? `run_command refused: ${hit.reason}. ${advice} Set "commandGate": "off" in the config if this really needs the shell.`
    : `Note: ${hit.reason}. ${advice}`;
}
