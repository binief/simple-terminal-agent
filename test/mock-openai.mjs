/* Mock OpenAI-compatible /chat/completions server for tests.
   Prints "PORT <n>" on startup. Behavior (keyed on user text):
   - "PLAN-ME"       -> tries to write a file (plan mode must refuse it), tries a mutating
                        command (refused), runs a read-only one, then calls present_plan;
                        once the approval message arrives it implements the plan
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
import { APPROVED_TAG } from '../lib/plan.js';

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

  // plan mode: research (the mutating calls must be refused), hand over a plan,
  // then implement it once the user has approved it
  if (userText.includes('PLAN-ME')) {
    if (userText.includes(APPROVED_TAG)) {
      if (/^(Wrote|Overwrote) plan-probe\.txt/.test(lastTool)) return { text: 'MOCK-DONE plan-approved' };
      return {
        tool: { id: 'call_pa', name: 'write_file', arguments: JSON.stringify({ path: 'plan-probe.txt', content: 'plan-ok' }) },
      };
    }
    switch (toolMsgs.length) {
      case 0: // must be refused: plan mode has no write_file
        return {
          tool: { id: 'call_p0', name: 'write_file', arguments: JSON.stringify({ path: 'plan-probe.txt', content: 'should-not-exist' }) },
        };
      case 1: // must be refused: the command changes the workspace
        return {
          tool: { id: 'call_p1', name: 'run_command', arguments: JSON.stringify({ command: isWin ? 'del plan-probe.txt' : 'rm -f plan-probe.txt' }) },
        };
      case 2: // read-only commands are still allowed
        return { tool: { id: 'call_p2', name: 'run_command', arguments: JSON.stringify({ command: isWin ? 'dir' : 'ls -a' }) } };
      case 3:
        return {
          tool: {
            id: 'call_p3',
            name: 'present_plan',
            arguments: JSON.stringify({
              title: 'Add the probe file',
              steps: ['create plan-probe.txt with the probe text', 'read it back to confirm'],
              files: ['plan-probe.txt'],
              verification: 'cat plan-probe.txt',
              notes: 'PLAN-NOTES: nothing risky here',
            }),
          },
        };
      default:
        return { text: 'MOCK-DONE plan-stalled' }; // present_plan should have ended the turn
    }
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

  // --- delegation ---------------------------------------------------------
  // A subagent runs in its own conversation, so it is recognised by its system
  // prompt rather than by the user text. Each one first reaches for a tool it
  // must not have, to prove the registry is pruned and not merely asked nicely.
  if (systemText.includes('coding subagent')) {
    if (toolMsgs.length === 0) {
      return {
        tool: { id: 'call_s1', name: 'write_file', arguments: JSON.stringify({ path: 'delegated.txt', content: 'written-by-subagent' }) },
      };
    }
    if (toolMsgs.length === 1) {
      return { tool: { id: 'call_s2', name: 'delegate', arguments: JSON.stringify({ agent: 'coder', goal: 'recurse please' }) } };
    }
    return { text: `SUBAGENT-REPORT Done: wrote delegated.txt. Recursion: ${/not available to this agent/.test(lastTool) ? 'refused' : 'allowed'}.` };
  }
  if (systemText.includes('research subagent')) {
    if (toolMsgs.length === 0) {
      return { tool: { id: 'call_r1', name: 'write_file', arguments: JSON.stringify({ path: 'research-probe.txt', content: 'nope' }) } };
    }
    if (toolMsgs.length === 1) {
      return {
        tool: { id: 'call_r2', name: 'run_command', arguments: JSON.stringify({ command: isWin ? 'del nothing.txt' : 'rm -f research-probe.txt' }) },
      };
    }
    const refusedWrite = /not available to this agent/.test(String(toolMsgs[0].content));
    const refusedCmd = /read-only/.test(lastTool);
    return { text: `RESEARCH-REPORT Answer: write=${refusedWrite ? 'refused' : 'allowed'} command=${refusedCmd ? 'refused' : 'allowed'}` };
  }

  if (userText.includes('DELEGATE-ME')) {
    if (toolMsgs.length === 0) {
      return {
        tool: {
          id: 'call_d1',
          name: 'delegate',
          arguments: JSON.stringify({
            agent: 'coder',
            goal: 'Create delegated.txt containing written-by-subagent.',
            files: ['delegated.txt'],
            context: 'Nothing exists yet.',
          }),
        },
      };
    }
    return {
      text:
        `MOCK-DONE delegated=${/SUBAGENT-REPORT/.test(lastTool) ? 'report-seen' : 'report-missing'}` +
        ` head=${/subagent finished: \d+ step\(s\)/.test(lastTool) ? 'yes' : 'no'}`,
    };
  }

  if (userText.includes('RESEARCH-ME')) {
    if (toolMsgs.length === 0) {
      return { tool: { id: 'call_d2', name: 'delegate', arguments: JSON.stringify({ agent: 'researcher', goal: 'Find out what is writable from here.' }) } };
    }
    return { text: `MOCK-DONE researched=${/RESEARCH-REPORT/.test(lastTool) ? lastTool.split('RESEARCH-REPORT ')[1].trim() : 'report-missing'}` };
  }

  // enforced delegation: the main agent has no write_file and must be refused
  if (userText.includes('ENFORCED-ME')) {
    if (toolMsgs.length === 0) {
      return { tool: { id: 'call_x1', name: 'write_file', arguments: JSON.stringify({ path: 'forbidden.txt', content: 'x' }) } };
    }
    return { text: `MOCK-DONE enforced=${/not available to this agent/.test(lastTool) ? 'refused' : 'allowed'}` };
  }

  // the command gate: a model that greps through the shell is pointed at search_files
  if (userText.includes('GATE-ME')) {
    if (toolMsgs.length === 0) {
      return { tool: { id: 'call_g1', name: 'run_command', arguments: JSON.stringify({ command: 'grep -r needle .' }) } };
    }
    return { text: `MOCK-DONE gate=${/search_files/.test(lastTool) ? 'redirected' : 'ran'}` };
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
    return { tool: { id: 'call_2', name: 'read_file', arguments: JSON.stringify({ path: 'hello-harness.txt' }) } };
  }
  if (toolMsgs.length === 2) {
    // the model still reaches for the shell to re-check it — the gate refuses
    return {
      tool: {
        id: 'call_3',
        name: 'run_command',
        arguments: JSON.stringify({ command: isWin ? 'type hello-harness.txt' : 'cat hello-harness.txt' }),
      },
    };
  }
  const body = String(toolMsgs[1]?.content ?? '').split('\n').slice(1).join('\n');
  return { text: `MOCK-DONE file=${body.trim()} gate=${/refused/.test(lastTool) ? 'refused' : 'ran'}` };
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
