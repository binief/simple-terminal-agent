/* Fake MCP server for tests: ndjson JSON-RPC 2.0 over stdio.
   Exposes one tool: add(a, b) -> String(a + b). */

let buf = '';

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(msg) {
  if (msg.id === undefined) return; // notification
  const ok = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

  switch (msg.method) {
    case 'initialize':
      ok({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '0.0.1' },
      });
      break;
    case 'ping':
      ok({});
      break;
    case 'tools/list':
      ok({
        tools: [
          {
            name: 'add',
            description: 'Add two numbers and return the sum.',
            inputSchema: {
              type: 'object',
              properties: {
                a: { type: 'number', description: 'first number' },
                b: { type: 'number', description: 'second number' },
              },
              required: ['a', 'b'],
            },
          },
        ],
      });
      break;
    case 'tools/call': {
      const args = msg.params?.arguments || {};
      if (msg.params?.name !== 'add') {
        ok({ content: [{ type: 'text', text: `unknown tool ${msg.params?.name}` }], isError: true });
        break;
      }
      const sum = Number(args.a) + Number(args.b);
      ok({ content: [{ type: 'text', text: String(sum) }], isError: false });
      break;
    }
    default:
      fail(-32601, `Method not found: ${msg.method}`);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      /* ignore malformed lines */
    }
  }
});
