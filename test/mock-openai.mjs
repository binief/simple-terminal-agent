/* Mock OpenAI-compatible /chat/completions server for tests.
   Prints "PORT <n>" on startup. Behavior (keyed on user text):
   - "TRUNCATE-CUT"  -> text reply cut off mid-sentence (finish_reason "length"),
                        then a complete reply once the [continue] nudge arrives
   - "TRUNCATE-TOOL" -> tool call whose arguments were cut off mid-JSON
                        (finish_reason "length"), then the complete call, then final
   - "LOOP-FOREVER"  -> tool call on every reply (never finishes) — step-limit tests
   - "RETRY-ME"      -> server answers 503 once, then a plain final reply
   - "ADD2"          -> tool_call mcp_fake_add {a:2,b:40}, then final "MOCK-DONE <tool result>"
   - otherwise       -> tool_call write_file, then tool_call run_command (cat/type), then final
   Honors body.stream (SSE vs JSON). */

import http from 'node:http';

import { COMPACT_TAG, CONTINUE_TAG } from '../lib/agent.js';

const isWin = process.platform === 'win32';

function plan(messages) {
  const toolMsgs = messages.filter((m) => m.role === 'tool');
  const userText = messages.filter((m) => m.role === 'user').map((m) => m.content).join(' ');
  const lastTool = toolMsgs.length ? String(toolMsgs[toolMsgs.length - 1].content) : '';

  // compaction request: answer with a summary, never with a tool call
  if (userText.includes(COMPACT_TAG)) {
    return { text: 'COMPACTED: earlier messages summarized. Task: write hello-harness.txt.' };
  }

  // proves that config "instructions" reached the model's system message
  const systemText = messages.filter((m) => m.role === 'system').map((m) => m.content).join(' ');
  if (systemText.includes('HAIKU-RULE')) {
    return { text: 'MOCK-DONE instructions-seen' };
  }

  // reports how the input actually arrived: one user message, and whether it
  // contains a newline (multi-line input tests)
  if (userText.includes('MULTILINE-PROBE')) {
    const users = messages.filter((m) => m.role === 'user');
    const multiline = users.some((m) => String(m.content ?? '').includes('\n'));
    return { text: `MOCK-DONE users=${users.length} multiline=${multiline}` };
  }

  // a text reply that the token limit cut in half; the harness should send a
  // [continue] nudge and then the full answer arrives
  if (userText.includes('TRUNCATE-CUT')) {
    if (userText.includes(CONTINUE_TAG)) return { text: 'MOCK-DONE continued-ok' };
    return { text: 'MOCK-PART this sentence was cut in half by the token lim', finish_reason: 'length' };
  }

  // a tool call whose arguments JSON was cut off — must not be executed; the
  // model then re-issues the complete call and finishes
  if (userText.includes('TRUNCATE-TOOL')) {
    if (toolMsgs.length === 0) {
      return {
        text: 'I will write the file now',
        tool: { id: 'call_t1', name: 'write_file', arguments: '{"path":"cut-file.txt","content":"never-fin' },
        finish_reason: 'length',
      };
    }
    if (lastTool.includes('cut off')) {
      return {
        tool: { id: 'call_t2', name: 'write_file', arguments: JSON.stringify({ path: 'cut-file.txt', content: 'recovered-ok' }) },
      };
    }
    return { text: 'MOCK-DONE tool-recovered' };
  }

  // never finishes: one tool call per reply, forever — for step-limit tests
  if (userText.includes('LOOP-FOREVER')) {
    return {
      tool: { id: `call_l${toolMsgs.length}`, name: 'run_command', arguments: JSON.stringify({ command: 'echo loop' }) },
    };
  }

  if (userText.includes('RETRY-ME')) {
    return { text: 'MOCK-DONE retried-ok' };
  }

  if (userText.includes('ADD2')) {
    if (toolMsgs.length === 0) {
      return { tool: { id: 'call_m', name: 'mcp_fake_add', arguments: JSON.stringify({ a: 2, b: 40 }) } };
    }
    return { text: `MOCK-DONE add=${lastTool}` };
  }

  if (toolMsgs.length === 0) {
    return {
      tool: {
        id: 'call_1',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'hello-harness.txt', content: 'harness-ok' }),
      },
    };
  }
  if (toolMsgs.length === 1) {
    return {
      tool: {
        id: 'call_2',
        name: 'run_command',
        arguments: JSON.stringify({ command: isWin ? 'type hello-harness.txt' : 'cat hello-harness.txt' }),
      },
    };
  }
  const stdoutPart = /--- stdout ---\n([\s\S]*?)\n--- stderr ---/.exec(lastTool);
  return { text: `MOCK-DONE file=${(stdoutPart ? stdoutPart[1] : lastTool).trim() || ''}` };
}

function jsonReply(res, decision, body) {
  const msg = decision.tool
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: decision.tool.id,
            type: 'function',
            function: { name: decision.tool.name, arguments: decision.tool.arguments },
          },
        ],
      }
    : { role: 'assistant', content: decision.text };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: body.model,
      choices: [
        {
          index: 0,
          message: msg,
          finish_reason: decision.finish_reason || (decision.tool ? 'tool_calls' : 'stop'),
        },
      ],
      usage: { prompt_tokens: 111, completion_tokens: 22, total_tokens: 133 },
    })
  );
}

function sseReply(res, decision) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ choices: [{ index: 0, delta: { role: 'assistant' } }] });
  if (decision.text) {
    const words = decision.text.split(/(?<= )/); // keep spaces attached
    for (const w of words) send({ choices: [{ index: 0, delta: { content: w } }] });
  }
  if (decision.tool) {
    // tool call: name first, arguments split across chunks
    send({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: decision.tool.id, type: 'function', function: { name: decision.tool.name, arguments: '' } },
            ],
          },
        },
      ],
    });
    const args = decision.tool.arguments;
    const mid = Math.ceil(args.length / 2);
    send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, mid) } }] } }] });
    send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(mid) } }] } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: decision.finish_reason || 'tool_calls' }] });
  } else {
    send({ choices: [{ index: 0, delta: {}, finish_reason: decision.finish_reason || 'stop' }] });
  }
  // usage arrives in its own final chunk when stream_options.include_usage is honoured
  send({ choices: [], usage: { prompt_tokens: 222, completion_tokens: 33, total_tokens: 255 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

let retryArmed = true; // the RETRY-ME marker gets exactly one 503 per server run

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      res.end('bad json');
      return;
    }
    const userText = (body.messages || []).filter((m) => m.role === 'user').map((m) => m.content).join(' ');
    if (userText.includes('RETRY-ME') && retryArmed) {
      retryArmed = false;
      res.writeHead(503, { 'retry-after': '0' });
      res.end('transient server error');
      return;
    }
    const decision = plan(body.messages || []);
    if (body.stream) sseReply(res, decision);
    else jsonReply(res, decision, body);
  });
});

server.listen(Number(process.env.MOCK_PORT) || 0, '127.0.0.1', () => {
  console.log(`PORT ${server.address().port}`);
});
