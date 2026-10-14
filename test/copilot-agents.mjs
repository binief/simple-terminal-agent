/* Validates the GitHub Copilot custom agents in .github/agents/.
 *
 * Run: node --test test/copilot-agents.mjs
 *
 * The files are prompts, so what is checkable is their contract: frontmatter the
 * Copilot surfaces accept, tool allowlists that keep the read-only phases
 * read-only, handoffs that chain the three phases and point at agents that
 * exist, and the REFINED PROMPT / IMPLEMENT PROMPT blocks in exactly the shape
 * basic.mjs reads them with (lib/plan.js).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractImplementPrompt, extractRefinedPrompt } from '../lib/plan.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const agentsDir = path.join(repo, '.github', 'agents');
const PLAN_DIR = '.copilot/plans';

/** Tool aliases Copilot accepts in an agent profile (GitHub's custom agents reference). */
const TOOL_ALIASES = new Set(['read', 'edit', 'search', 'execute', 'agent', 'web', 'todo']);

const unquote = (value) => {
  const text = String(value).trim();
  const quote = text[0];
  return (quote === "'" || quote === '"') && text.length > 1 && text.endsWith(quote) ? text.slice(1, -1) : text;
};

function scalar(value) {
  const text = value.trim();
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text.startsWith('[') && text.endsWith(']')) {
    return text
      .slice(1, -1)
      .split(',')
      .map((part) => unquote(part))
      .filter((part) => part !== '');
  }
  return unquote(text);
}

/** The frontmatter of an agent file, as the small YAML subset these files use. */
function frontmatter(raw, file) {
  const text = raw.replace(/\r\n?/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  assert.ok(match, `${file}: must open with a YAML frontmatter block`);
  const data = {};
  let listKey = null; // the top-level key currently collecting list items
  let entry = null; // the object inside that list, when the items are mappings
  for (const line of match[1].split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const nested = line.match(/^\s+-\s*(.*)$/);
    if (nested && listKey) {
      const kv = nested[1].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (kv) {
        entry = { [kv[1]]: scalar(kv[2]) };
        data[listKey].push(entry);
      } else {
        entry = null;
        data[listKey].push(scalar(nested[1]));
      }
      continue;
    }
    const item = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
    if (item && listKey && entry) {
      entry[item[1]] = scalar(item[2]);
      continue;
    }
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    assert.ok(top, `${file}: frontmatter line not understood: ${line}`);
    if (top[2].trim() === '') {
      listKey = top[1];
      entry = null;
      data[listKey] = [];
    } else {
      listKey = null;
      entry = null;
      data[top[1]] = scalar(top[2]);
    }
  }
  return { data, body: text.slice(match[0].length) };
}

function readAgent(id) {
  const file = path.join(agentsDir, `${id}.agent.md`);
  assert.ok(fs.existsSync(file), `missing .github/agents/${id}.agent.md`);
  const raw = fs.readFileSync(file, 'utf8');
  return { id, raw, ...frontmatter(raw, `${id}.agent.md`) };
}

const agentIds = () =>
  fs
    .readdirSync(agentsDir)
    .filter((name) => name.endsWith('.agent.md'))
    .map((name) => name.replace(/\.agent\.md$/, ''));

function fencedBlocks(body) {
  const blocks = [];
  let current = null;
  for (const line of body.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      if (current) blocks.push(current.join('\n'));
      current = current ? null : [];
      continue;
    }
    if (current) current.push(line);
  }
  return blocks;
}

/** The reply template an agent documents for its own block, checked for shape. */
function blockTemplate(body, marker) {
  const block = fencedBlocks(body).find((text) => text.split('\n').some((line) => line.trim() === marker));
  assert.ok(block, `no ${marker} example block in the prompt`);
  const lines = block.split('\n').map((line) => line.trim());
  assert.equal(lines[0], marker, 'the example must open with the marker line');
  assert.equal(lines[1], '---', 'the marker is followed by the opening ---');
  assert.equal(lines[lines.length - 1], '---', 'the block closes with ---');
  assert.ok(lines.slice(2, -1).join('\n').trim(), 'the example body must not be empty');
}

/** A reply in the documented format, with `text` as the prompt. */
const reply = (marker, text) => `${marker}\n---\n${text}\n---`;

test('the three phases are present as Copilot custom agents', () => {
  assert.deepEqual(agentIds().sort(), ['implement', 'plan', 'rewrite']);
  assert.match(readAgent('rewrite').body, /^# REWRITE\b/m);
  assert.match(readAgent('plan').body, /^# PLAN\b/m);
  assert.match(readAgent('implement').body, /^# IMPLEMENT\b/m);
});

test('frontmatter is what the Copilot surfaces accept', () => {
  const ids = agentIds();
  assert.ok(ids.length, 'no agent files found');
  for (const id of ids) {
    const agent = readAgent(id);
    const { description, tools, name, 'argument-hint': hint, handoffs } = agent.data;
    assert.equal(typeof description, 'string', `${id}: description is required`);
    assert.ok(
      description.length >= 40 && description.length <= 200,
      `${id}: description should be 40-200 characters, got ${description.length}`
    );
    assert.ok(!description.includes('\n'), `${id}: description must be one line`);
    if (name !== undefined) assert.equal(name, id, `${id}: name must match the file name handoffs resolve`);
    assert.ok(Array.isArray(tools) && tools.length > 0, `${id}: tools must be a non-empty array`);
    for (const tool of tools) assert.ok(TOOL_ALIASES.has(tool), `${id}: unknown tool alias "${tool}"`);
    if (hint !== undefined) assert.ok(typeof hint === 'string' && hint.length <= 120, `${id}: argument-hint is too long`);
    if (handoffs !== undefined) assert.ok(Array.isArray(handoffs), `${id}: handoffs must be a list`);
    assert.ok(agent.body.trim().length > 200, `${id}: the body is the prompt and cannot be empty`);
    assert.ok(agent.body.length <= 30000, `${id}: the prompt must fit the 30,000-character limit`);
  }
});

test('the read-only phases cannot edit the project', () => {
  const rewrite = readAgent('rewrite');
  const plan = readAgent('plan');
  assert.deepEqual(rewrite.data.tools.slice().sort(), ['read', 'search'], 'rewrite shapes a prompt: no writer, no shell');
  assert.match(rewrite.body, /read-only is enforced/i);
  assert.ok(!plan.data.tools.includes('edit'), 'plan must not hold an editing tool');
  assert.ok(plan.data.tools.includes('execute'), 'plan may run read-only commands, as PLAN mode does');
  assert.match(plan.body, /read-only commands only/i);
  assert.match(plan.body, /git status/);
  // The refusals mirror PLAN mode in basic.mjs: builds, installs, anything that writes.
  for (const refused of [/npm install/, /redirection/, /sed -i/, /git commit/]) {
    assert.match(plan.body, refused, `plan must refuse ${refused}`);
  }
  assert.match(plan.body, /Do not write anything yourself/);
});

test('only implement changes files, and it carries the working rules', () => {
  const implement = readAgent('implement');
  assert.ok(implement.data.tools.includes('edit'), 'implement is the phase with a writer');
  assert.ok(implement.data.tools.includes('execute'));
  for (const rule of [
    /Read before you change/,
    /Smallest correct diff/,
    /do not commit/i,
    /Finish the task in this run/,
    /Verify before you report/,
    /If a check fails, fix it and run it again/,
  ]) {
    assert.match(implement.body, rule);
  }
});

test('handoffs chain rewrite -> plan -> implement, and point at agents that exist', () => {
  const ids = agentIds();
  for (const [from, to] of [['rewrite', 'plan'], ['plan', 'implement']]) {
    const handoffs = readAgent(from).data.handoffs;
    assert.ok(Array.isArray(handoffs) && handoffs.length === 1, `${from}: exactly one handoff`);
    const [handoff] = handoffs;
    assert.equal(handoff.agent, to);
    assert.equal(handoff.send, false, 'each phase waits for the user, as the rewrite gate does');
    assert.ok(handoff.label && handoff.prompt, `${from}: a handoff needs a label and a prompt`);
  }
  assert.equal(readAgent('implement').data.handoffs, undefined, 'the pipeline ends at implement');
  for (const id of ids) {
    for (const handoff of readAgent(id).data.handoffs || []) {
      assert.ok(ids.includes(handoff.agent), `${id} hands off to unknown agent "${handoff.agent}"`);
    }
  }
});

test('the prompt blocks are exactly what basic.mjs reads', () => {
  blockTemplate(readAgent('rewrite').body, 'REFINED PROMPT');
  blockTemplate(readAgent('plan').body, 'IMPLEMENT PROMPT');

  const refined = 'Goal: add a --version flag to the CLI.';
  assert.equal(extractRefinedPrompt([reply('REFINED PROMPT', refined)]), refined);
  assert.equal(extractImplementPrompt([reply('REFINED PROMPT', refined)]), null, 'a refined prompt is not a plan');

  const planText = 'Goal: add a --version flag.\n\n### Files to touch\n- harness.js — parseArgs';
  assert.equal(extractImplementPrompt([reply('IMPLEMENT PROMPT', planText)]), planText);
  assert.equal(extractRefinedPrompt([reply('IMPLEMENT PROMPT', planText)]), null, 'a plan is not a refined prompt');
});

test('plan files stay out of the project', () => {
  const gitignore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
  assert.match(gitignore, /\.copilot\/plans\//, 'the plan directory must be git-ignored');

  const planBody = readAgent('plan').body;
  const implementBody = readAgent('implement').body;
  for (const body of [planBody, implementBody]) {
    assert.ok(body.includes(PLAN_DIR), 'both phases must agree on where plans live');
  }
  assert.match(planBody, /git-ignored/);
  assert.match(planBody, /not part of the project/);
  assert.match(implementBody, /plan-<UTC timestamp>\.md/, 'the implement phase saves the brief it received');
  assert.match(implementBody, /never part of the project/);
});
