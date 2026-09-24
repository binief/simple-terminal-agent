/* Terminal UI: ANSI styling + chat message rendering. Zero dependencies. */

const useColor =
  Boolean(process.stdout.isTTY) &&
  !process.env.NO_COLOR &&
  (process.env.TERM ?? '') !== 'dumb';

const paint = (open) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[0m` : String(s));

export const s = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
  gray: paint('90'),
  inv: paint('7'),
};

export function out(line = '') {
  process.stdout.write(line + '\n');
}

export function termWidth() {
  return Math.max(40, Math.min(120, process.stdout.columns || 80));
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function vlen(str) {
  return String(str).replace(ANSI_RE, '').length;
}

function truncate(str, n) {
  str = String(str);
  return str.length <= n ? str : str.slice(0, Math.max(0, n - 1)) + '…';
}

/* ------------------------------------------------------------------ */
/* Inline formatting: `code` and **bold** become atomic styled tokens. */
/* ------------------------------------------------------------------ */

const PH = (i) => `\u0000${i}\u0000`;
const PH_RE = /\u0000(\d+)\u0000/g;

function inlineFormat(line) {
  const map = [];
  const stash = (styled) => {
    map.push(styled);
    return PH(map.length - 1);
  };
  let t = String(line);
  t = t.replace(/`([^`]+)`/g, (_, c) => stash(s.inv(' ' + c + ' ')));
  t = t.replace(/\*\*([^*]+)\*\*/g, (_, c) => stash(s.bold(c)));
  return { t, map };
}

function restore(t, map) {
  return t.replace(PH_RE, (_, i) => map[Number(i)] ?? '');
}

function wordWidth(word, map) {
  const m = /^\u0000(\d+)\u0000$/.exec(word);
  if (m) return Math.max(1, vlen(map[Number(m[1])] ?? ''));
  return vlen(word);
}

/** Wrap a line of text that may contain styled placeholder tokens. */
function wrapLine(line, map, max, indent) {
  const room = Math.max(8, max - indent.length);
  const words = line.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  let curLen = 0;
  for (const w of words) {
    const wl = wordWidth(w, map);
    if (curLen === 0) {
      cur = w;
      curLen = wl;
    } else if (curLen + 1 + wl <= room) {
      cur += ' ' + w;
      curLen += 1 + wl;
    } else {
      lines.push(cur);
      cur = w;
      curLen = wl;
    }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => restore(indent + l, map));
}

/* ------------------------------------------------------------------ */
/* StreamRenderer: renders assistant/user text with simple markdown.  */
/* ------------------------------------------------------------------ */

export class StreamRenderer {
  constructor() {
    this.buf = '';
    this.inFence = false;
  }

  /** Feed a chunk of text; complete lines are rendered immediately. */
  push(text) {
    this.buf += text;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.renderLine(line);
    }
  }

  /** Flush any remaining buffered text. */
  end() {
    if (this.buf) {
      const line = this.buf;
      this.buf = '';
      this.renderLine(line);
    }
  }

  renderLine(rawLine) {
    const line = rawLine.replace(/\s+$/, '');
    if (/^\s*(```|~~~)/.test(line)) {
      this.inFence = !this.inFence;
      return;
    }
    if (this.inFence) {
      this.codeLine(line);
      return;
    }
    if (!line.trim()) {
      out();
      return;
    }
    const width = termWidth();
    const header = /^#{1,6}\s+(.*)$/.exec(line);
    if (header) {
      const { t, map } = inlineFormat(header[1]);
      for (const l of wrapLine(t, map, width, '  ')) out(s.bold(l));
      return;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const { t, map } = inlineFormat(bullet[1]);
      const wrapped = wrapLine(t, map, width, '    ');
      wrapped[0] = '  • ' + wrapped[0].slice(4);
      for (const l of wrapped) out(l);
      return;
    }
    const { t, map } = inlineFormat(line);
    for (const l of wrapLine(t, map, width, '  ')) out(l);
  }

  codeLine(line) {
    const text = line.replace(/\t/g, '  ');
    const room = Math.max(20, termWidth() - 4);
    if (vlen(text) <= room) {
      out(s.dim('  │ ' + text));
      return;
    }
    for (let i = 0; i < text.length; i += room) {
      out(s.dim('  │ ' + text.slice(i, i + room)));
    }
  }
}

/** Render a complete message block (used for user text and non-streamed replies). */
export function renderText(text) {
  const r = new StreamRenderer();
  r.push(String(text ?? ''));
  r.end();
}

/* ------------------------------------------------------------------ */
/* Chat message printers                                              */
/* ------------------------------------------------------------------ */

function header(label, colorFn) {
  const tag = `  ${colorFn(s.bold(label))} `;
  const dash = '─'.repeat(Math.max(4, termWidth() - vlen(tag) - 2));
  out(`${tag}${s.gray(dash)}`);
}

export function printUser(text) {
  out();
  header('You', s.cyan);
  renderText(text);
}

export function assistantHeader() {
  out();
  header('Assistant', s.green);
  return new StreamRenderer();
}

export function printToolCall(name, argsJson) {
  out(`  ${s.yellow(s.bold('⚙'))} ${s.yellow(name)} ${s.gray(truncate(argsJson || '{}', 110))}`);
}

export function printToolResult(text) {
  const lines = String(text ?? '').replace(/\s+$/, '').split('\n');
  const shown = lines.slice(0, 40);
  for (const l of shown) {
    const room = Math.max(20, termWidth() - 4);
    if (vlen(l) > room) {
      out(s.dim('    · ' + l.slice(0, room - 2) + '…'));
    } else {
      out(s.dim('    · ' + l));
    }
  }
  if (lines.length > 40) out(s.dim(`    · … ${lines.length - 40} more line(s)`));
}

export function printSystem(text) {
  out(`  ${s.magenta('●')} ${s.dim(text)}`);
}

export function printError(text) {
  out();
  out(`  ${s.red(s.bold('✖'))} ${s.red(text)}`);
}

/* ------------------------------------------------------------------ */
/* Spinner + banner                                                   */
/* ------------------------------------------------------------------ */

export function spinner(label) {
  if (!useColor) return { stop() {} };
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let stopped = false;
  const id = setInterval(() => {
    process.stdout.write(`\r\x1b[K${s.dim(frames[i++ % frames.length] + ' ' + label)}`);
  }, 80);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(id);
      process.stdout.write('\r\x1b[K');
    },
  };
}

export function banner({ version, configPath, configCreated, model, baseURL, streaming, contextSize, temperature, workspace, tools, mcp }) {
  out();
  out(`  ${s.bold(s.cyan('coding-harness'))} ${s.dim('v' + version)}`);
  const row = (k, v) => out(`  ${s.gray(k.padEnd(10))}${v}`);
  row('config', configPath + (configCreated ? s.yellow('  (created — edit it)') : s.dim('')));
  row('model', `${s.bold(model)} ${s.dim('@ ' + baseURL)}`);
  row('options', `${streaming ? 'stream: on' : 'stream: off'} · context: ${contextSize} · temp: ${temperature}`);
  row('tools', tools.join(', '));
  if (mcp) row('mcp', mcp);
  row('workspace', workspace);
  out();
  out(s.dim('  type /help for commands, /exit to quit'));
}
