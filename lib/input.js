/* Multiline prompt input.
 *
 * Enter sends, every other way of finishing a line adds it to the message being
 * composed instead:
 *   - a trailing backslash       ("explain this: \") — works in every terminal,
 *   - Shift+Enter / Alt+Enter    — terminals that report those send ESC+CR
 *                                  (`\x1b\r`), which Node's readline drops, so
 *                                  it is sniffed off the raw input,
 *   - a multi-line paste         — the pasted lines become one draft.
 *
 * A draft is finished by a line that neither continues nor was pasted; the whole
 * draft is then delivered to the caller as a single message. The logic lives
 * here (not in harness.js) so it can be unit-tested with a fake readline.
 */

/** "npm run build \\" → { text: "npm run build ", continued: true }; "a\\\\" → continued: false. */
export function splitContinuation(line) {
  const text = String(line ?? '');
  const trailing = /\\+$/.exec(text);
  if (!trailing || trailing[0].length % 2 === 0) return { text, continued: false };
  return { text: text.slice(0, -1), continued: true };
}

/** Trim a finished block's edges without touching the indentation inside it. */
function tidy(text) {
  return String(text)
    .replace(/^(?:[ \t]*\n)+/, '') // drop blank lines before the message
    .replace(/\s+$/, ''); // drop the trailing newline / spaces
}

/**
 * Collects submitted lines into a message.
 *   push('one \\')            → null   (draft open)
 *   push('two')               → 'one \ntwo'
 *   push('x', {continuation}) → null   (Shift+Enter line)
 */
export function createComposer() {
  let lines = [];
  return {
    /** Lines buffered so far; 0 means the next line is a normal message. */
    get pending() {
      return lines.length;
    },
    /** The draft as it stands (for display and tests). */
    get draft() {
      return lines.join('\n');
    },
    reset() {
      lines = [];
    },
    /**
     * Add one submitted line. Returns the finished message, or null while the
     * draft is still open.
     * `continuation` marks a line that must not end the message (Shift+Enter,
     * or any line of a multi-line paste) — it is kept exactly as typed.
     */
    push(line, { continuation = false } = {}) {
      const raw = String(line ?? '');
      if (continuation) {
        if (lines.length === 0 && raw === '') return null; // Shift+Enter on an empty prompt
        lines.push(raw);
        return null;
      }
      const { text, continued } = splitContinuation(raw);
      if (continued) {
        if (lines.length === 0 && text === '') return null; // a lone "\"
        lines.push(text);
        return null;
      }
      if (lines.length === 0) {
        const single = raw.trim();
        return single || null; // blank line with no draft open: nothing to send
      }
      if (text.trim() !== '') lines.push(text);
      const message = tidy(lines.join('\n'));
      lines = [];
      return message || null;
    },
  };
}

/**
 * Finds Shift+Enter (ESC+CR / ESC+LF) in the raw terminal input, including a
 * sequence split across two reads. Node's readline neither submits nor inserts
 * anything for it, so the caller turns each hit into a continuation.
 */
export function createEscapeEnterScanner() {
  let sawEsc = false;
  return {
    /** Number of Shift+Enter presses found in `chunk`. */
    scan(chunk) {
      const s = String(chunk ?? '');
      let hits = 0;
      let esc = sawEsc; // a leading ESC may belong to the previous chunk
      for (const ch of s) {
        if (esc) {
          esc = false;
          if (ch === '\r' || ch === '\n') {
            hits++;
            continue;
          }
        }
        if (ch === '\x1b') esc = true;
      }
      sawEsc = esc;
      return hits;
    },
  };
}

/**
 * Wire a readline interface up to a composer.
 *
 *   const reader = createInputReader({ rl, stdin, isTty, prompt, continuationPrompt, onMessage, notify });
 *   reader.setBusy(true)   // while a turn runs: no prompt, no hint
 *   reader.discard()       // Ctrl+C with a draft open
 *
 * `onMessage(text)` receives finished messages in order; `notify(text)` gets the
 * dim hint shown when a draft starts. Prompts are handled here so the readline
 * stays in one place.
 */
export function createInputReader({
  rl,
  stdin = null,
  isTty = false,
  prompt = '',
  continuationPrompt = '',
  onMessage = () => {},
  notify = () => {},
}) {
  const composer = createComposer();
  const scanner = createEscapeEnterScanner();
  const queue = []; // lines from one input burst (a paste) are grouped
  let busy = false;
  let closed = false;
  let flushing = false;
  let forceContinuation = false; // set while an ESC+CR submit is being handled
  let hinted = false;
  let timer = null;

  const showPrompt = () => {
    if (!isTty || busy || closed) return;
    rl.setPrompt(composer.pending ? continuationPrompt : prompt);
    rl.prompt();
  };

  const maybeHint = () => {
    if (!isTty || busy || closed || hinted || !composer.pending) return;
    hinted = true;
    notify(`  ⋯ multiline: end a line with \\ to keep going, plain Enter sends, Ctrl+C cancels`);
  };

  const submit = (line, { continuation = false } = {}) => {
    const message = composer.push(line, { continuation });
    if (composer.pending) maybeHint();
    else hinted = false;
    if (message) onMessage(message);
    else if (!flushing) showPrompt();
  };

  const flush = () => {
    timer = null;
    const burst = queue.splice(0, queue.length);
    if (!burst.length) return;
    flushing = true;
    try {
      if (burst.length === 1) {
        submit(burst[0].line, { continuation: burst[0].continuation });
      } else {
        for (const rec of burst) submit(rec.line, { continuation: true }); // a paste = one draft
      }
    } finally {
      flushing = false;
    }
    showPrompt();
  };

  rl.on('line', (line) => {
    const continuation = forceContinuation;
    forceContinuation = false;
    if (!isTty) {
      submit(line, { continuation });
      return;
    }
    queue.push({ line, continuation });
    if (!timer) timer = setImmediate(flush);
  });
  rl.on('close', () => {
    closed = true;
  });

  if (isTty && stdin) {
    stdin.on('data', (chunk) => {
      if (!scanner.scan(chunk)) return;
      if (!rl.line) return; // nothing typed: Shift+Enter on an empty prompt does nothing
      // Shift+Enter: readline ignored the sequence, so commit the line as a draft.
      forceContinuation = true;
      try {
        rl.write(null, { name: 'return', ctrl: false, meta: false, shift: false, sequence: '\r' });
      } finally {
        forceContinuation = false;
      }
    });
  }

  return {
    get busy() {
      return busy;
    },
    get pending() {
      return composer.pending;
    },
    /** A turn (or a command) started/ended: hides and re-shows the prompt. */
    setBusy(value) {
      busy = Boolean(value);
      if (!busy) {
        maybeHint();
        showPrompt();
      }
    },
    /** Throw the draft away (Ctrl+C) and show the plain prompt again. */
    discard() {
      composer.reset();
      hinted = false;
      showPrompt();
    },
    /** Send everything buffered, e.g. on EOF — the draft still belongs to the user. */
    flushDraft() {
      if (!composer.pending) return;
      const message = tidy(composer.draft);
      composer.reset();
      hinted = false;
      if (message) onMessage(message);
    },
  };
}
