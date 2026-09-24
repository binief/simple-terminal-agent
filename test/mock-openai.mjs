/* Mock OpenAI-compatible /chat/completions server for tests.
   Prints "PORT <n>" on startup. Behavior:
   - user text contains "ADD2"  -> tool_call mcp_fake_add {a:2,b:40}, then final "MOCK-DONE <tool result>"
   - otherwise                  -> tool_call write_file, then tool_call run_command (cat/type), then final
   Honors body.stream (SSE vs JSON). */

import http from 'node:http';

const isWin = process.platform === 'win32';

function plan(messages) {
  const toolMsgs = messages.filter((m) => m.role === 'tool');
  const userText = messages.filter((m) => m.role === 'user').map((m) => m.content).join(' ');
  const lastTool = toolMsgs.length ? String(toolMsgs[toolMsgs.length - 1].content) : '';

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
      choices: [{ index: 0, message: msg, finish_reason: decision.tool ? 'tool_calls' : 'stop' }],
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
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    const words = decision.text.split(/(?<= )/); // keep spaces attached
    for (const w of words) send({ choices: [{ index: 0, delta: { content: w } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

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
    const decision = plan(body.messages || []);
    if (body.stream) sseReply(res, decision);
    else jsonReply(res, decision, body);
  });
});

server.listen(Number(process.env.MOCK_PORT) || 0, '127.0.0.1', () => {
  console.log(`PORT ${server.address().port}`);
});
