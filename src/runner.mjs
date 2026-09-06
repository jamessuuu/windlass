#!/usr/bin/env node
// GRAPH-RUNNER v1 — the executable form of an attended pipeline (harness
// sibling of loop-runner.mjs). Full contract: SPEC.md in this directory —
// that file is authoritative for every command, flag, file name, exit code,
// state field, and design law; this file is the implementation of it.
//
// Design laws (SPEC.md "Design laws", each traces to evidence there):
//   1. Agent nodes exchange file PATHS, never free text — a prompt_file that
//      embeds a prior artifact's contents ({{cat ...}}, {{read ...}},
//      $(cat ...)) is refused at validate. Only {{inputs}}/{{produces}}
//      expand, and only to path lists.
//   2. Every edge is a command that can fail — an edge with no `verify` is a
//      spec error (validate refuses it), not a default-pass.
//   3. Caps are declared before the run and enforced by the RUNNER, not the
//      agent: max_wall_minutes (<=240 hard), max_attempts_per_node (default
//      2), max_usd_per_agent_node / max_usd_total, attended:true required.
//      A cap trip halts (exit 3) and never re-loops.
//   4. Two halt classes are distinguished: "stall" (a node's failure
//      signature — exit code + last 200 chars of stderr — repeats twice) and
//      "budget-while-working" (a cap trips right after a processing round
//      that was still changing something, ported from loop-runner's
//      identical distinction — Long-Horizon-Terminal-Bench, arXiv:2607.08964
//      — rather than a naive "did the cap trip mid-spawn" timing check).
//   5. Runner-owned state on disk (state.json), rewritten after every node —
//      agents never edit it; resume reads from state, never from chat.
//   6. Replay is a first-class output: events.jsonl (append-only) + state +
//      graph, with artifact HASHES only, never bodies.
//   7. Human gates are real stops: a gate node writes a request file and
//      halts (exit 3, status "paused"); only `answer` + `resume` continue
//      it. No timeout ever auto-answers a gate — wall-clock accumulation
//      (active_ms) excludes time spent paused waiting on a human.
//
// Runtime: Node >=22 ESM, zero dependencies, no network, Windows-safe paths.
// A nested `claude -p` spawned from inside a live Claude Code session has
// been observed to time out, so the runner refuses to `run`/`resume` when
// CLAUDECODE is set unless --allow-nested is passed.
//
// Usage:
//   node graph-runner.mjs validate <graph.json>
//   node graph-runner.mjs run <graph.json> [--run-id <id>] [--allow-nested]
//   node graph-runner.mjs answer <graph.json> <GATE_ID> '<json>' [--run-id <id>]
//   node graph-runner.mjs resume <graph.json> --run-id <id> [--allow-nested]
//   node graph-runner.mjs replay <graph.json> --run-id <id> [--out replay.json]
//   node graph-runner.mjs --selftest
// Exit codes: 0 done · 3 paused/halted · 1 failed · 2 config.

import { spawnSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync,
  statSync, readdirSync, copyFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
// The package root: src/ holds the runner and schema, examples/ sits beside it.
const TOOL_DIR = SRC_DIR;
const PKG_DIR = join(SRC_DIR, '..');
const WALL_HARD_CEILING_MIN = 240;

// ---------------------------------------------------------------------
// Secret redaction for events.jsonl command text — SAME concat-built,
// high-confidence-only patterns as secret-leak-guard.mjs (harness component
// 2/3), copied deliberately rather than imported so this file has zero
// dependencies on another tool's internals and never matches a secret
// scanner itself (the whole point of building patterns by concatenation).
// ---------------------------------------------------------------------
const SECRET_PATTERNS = [
  ['github token', 'gh' + 'p_' + '[A-Za-z0-9]{36}'],
  ['github oauth', 'gh' + 'o_' + '[A-Za-z0-9]{30,}'],
  ['github fine-grained PAT', 'github' + '_pat_' + '[A-Za-z0-9_]{50,}'],
  ['anthropic key', 'sk-' + 'ant-' + '[A-Za-z0-9\\-_]{40,}'],
  ['openai-style key', 'sk-' + 'proj-' + '[A-Za-z0-9\\-_]{40,}'],
  ['aws access key', 'AKI' + 'A[0-9A-Z]{16}'],
  ['slack token', 'xox' + '[baprs]-' + '[A-Za-z0-9-]{10,}'],
  ['google api key', 'AIz' + 'a[0-9A-Za-z_\\-]{35}'],
  ['telegram bot token', '\\b[0-9]{8,10}:' + 'AA' + '[A-Za-z0-9_-]{33}\\b'],
  ['private key block', '-----BEGIN' + ' [A-Z ]*' + 'PRIVATE' + ' KEY-----'],
  ['stripe live key', 'sk_' + 'live_' + '[A-Za-z0-9]{20,}'],
].map(([name, re]) => [name, new RegExp(re, 'g')]);

function redact(text) {
  let out = String(text == null ? '' : text);
  for (const [name, re] of SECRET_PATTERNS) out = out.replace(re, `[REDACTED:${name}]`);
  return out;
}

// Same redaction, applied to every string leaf of a gate answer object (a
// gate's answer_schema is arbitrary, so a leaf could in principle be
// secret-shaped even though answers are normally small control data).
function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

// Prompt-injection scan: an agent node's prompt_file may only expand
// {{inputs}}/{{produces}} to PATHS. Anything that tries to pull another
// node's output text into the prompt is refused at validate (design law 1).
const INJECTION_PATTERNS = [
  [/\{\{\s*cat\b/i, '{{cat ...}}'],
  [/\{\{\s*read\b/i, '{{read ...}}'],
  [/\$\(cat\b/i, '$(cat ...)'],
];
function scanForInjection(text) {
  const hits = [];
  for (const [re, label] of INJECTION_PATTERNS) if (re.test(text)) hits.push(label);
  return hits;
}

// ---------------------------------------------------------------------
// Minimal zero-dependency JSON-Schema evaluator — supports exactly the
// keywords schema.json and gate answer_schema use (type incl. "integer",
// enum, const, required, properties, additionalProperties:false, items,
// minItems, minimum/maximum, minLength, pattern). No $ref/oneOf/anyOf —
// schema.json is written fully inlined so this stays sufficient.
// ---------------------------------------------------------------------
function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
function typeOk(v, t) {
  switch (t) {
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return true;
  }
}
function validateValue(value, schema, path) {
  const p = path || '(root)';
  const errs = [];
  if (!schema || typeof schema !== 'object') return errs;
  if (schema.const !== undefined) {
    if (JSON.stringify(value) !== JSON.stringify(schema.const)) errs.push(`${p}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    return errs;
  }
  if (schema.enum) {
    if (!schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) errs.push(`${p}: not one of enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(value, t))) errs.push(`${p}: expected type ${types.join('|')}, got ${typeName(value)}`);
  }
  const isObjType = schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'));
  if (isObjType && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const req of schema.required || []) {
      if (!(req in value)) errs.push(`${p}: missing required property '${req}'`);
    }
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in value) errs.push(...validateValue(value[k], sub, p === '(root)' ? k : `${p}.${k}`));
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const k of Object.keys(value)) {
        if (!(k in schema.properties)) errs.push(`${p}: additional property '${k}' not allowed`);
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${p}: fewer than minItems ${schema.minItems}`);
    if (schema.items) value.forEach((v, i) => errs.push(...validateValue(v, schema.items, `${p}[${i}]`)));
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${p}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${p}: above maximum ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${p}: shorter than minLength ${schema.minLength}`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errs.push(`${p}: does not match pattern ${schema.pattern}`);
  }
  return errs;
}
function validateAgainstSchema(value, schema) {
  return validateValue(value, schema, '(root)');
}

// ---------------------------------------------------------------------
// Graph loading + validation (shape via schema.json, then semantic rules
// schema.json can't express: DAG-ness, unique ids, exactly-one-start,
// on_fail target existence, per-kind required fields, prompt injection).
// ---------------------------------------------------------------------
function loadGraphFile(graphPath) {
  if (!existsSync(graphPath)) throw new Error(`graph file not found: ${graphPath}`);
  let raw;
  try { raw = readFileSync(graphPath, 'utf8'); } catch (e) { throw new Error(`cannot read graph file: ${e.message}`); }
  let graph;
  try { graph = JSON.parse(raw); } catch (e) { throw new Error(`graph file is not valid JSON: ${e.message}`); }
  return { graph, raw };
}

function resolveP(cwd, p) { return isAbsolute(p) ? p : resolve(cwd, p); }

function resolvedCwdFor(graph, graphPath) {
  return resolve(dirname(resolve(graphPath)), graph.cwd || '.');
}

function findCycle(nodeIds, edges) {
  const adj = {};
  for (const id of nodeIds) adj[id] = [];
  for (const e of edges) if (adj[e.from]) adj[e.from].push(e.to);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = Object.fromEntries(nodeIds.map((id) => [id, WHITE]));
  const stack = [];
  function dfs(u) {
    color[u] = GRAY; stack.push(u);
    for (const v of adj[u] || []) {
      if (color[v] === GRAY) return [...stack, v];
      if (color[v] === WHITE) { const c = dfs(v); if (c) return c; }
    }
    stack.pop(); color[u] = BLACK;
    return null;
  }
  for (const id of nodeIds) if (color[id] === WHITE) { const c = dfs(id); if (c) return c; }
  return null;
}

function validateGraph(graph, graphPath) {
  const errors = [];
  let schema;
  try { schema = JSON.parse(readFileSync(join(TOOL_DIR, 'schema.json'), 'utf8')); }
  catch (e) { return [`internal: cannot load schema.json: ${e.message}`]; }
  errors.push(...validateAgainstSchema(graph, schema).map((e) => `shape: ${e}`));
  if (errors.length) return errors; // shape must be sound before semantic checks are meaningful

  const resolvedCwd = resolvedCwdFor(graph, graphPath);
  const nodesById = {};
  const dupes = [];
  for (const n of graph.nodes) {
    if (nodesById[n.id]) dupes.push(n.id);
    nodesById[n.id] = n;
  }
  if (dupes.length) errors.push(`duplicate node id(s): ${[...new Set(dupes)].join(', ')}`);

  for (const n of graph.nodes) {
    if (n.kind === 'script' && !n.run) errors.push(`node ${n.id}: script kind requires "run"`);
    if (n.kind === 'agent' && (!n.agent || !n.prompt_file)) errors.push(`node ${n.id}: agent kind requires "agent" and "prompt_file"`);
    if (n.kind === 'gate' && (!n.question || !n.writes || !n.answer_schema)) errors.push(`node ${n.id}: gate kind requires "question", "writes", and "answer_schema"`);
    if (n.kind === 'loop' && !n.config) errors.push(`node ${n.id}: loop kind requires "config"`);
  }

  for (const e of graph.edges) {
    if (!nodesById[e.from]) errors.push(`edge references unknown "from" node: ${e.from}`);
    if (!nodesById[e.to]) errors.push(`edge references unknown "to" node: ${e.to}`);
    if (!e.verify || !String(e.verify).trim()) errors.push(`edge ${e.from}->${e.to}: missing "verify" — every edge must be a command that can fail (design law 2)`);
  }

  for (const n of graph.nodes) {
    if (n.on_fail && n.on_fail.goto && !nodesById[n.on_fail.goto]) {
      errors.push(`node ${n.id}: on_fail.goto references unknown node: ${n.on_fail.goto}`);
    }
  }

  const incoming = new Set(graph.edges.map((e) => e.to));
  const starts = graph.nodes.filter((n) => !incoming.has(n.id));
  if (starts.length !== 1) errors.push(`graph must have exactly one start node (zero incoming edges); found ${starts.length}${starts.length ? ': ' + starts.map((n) => n.id).join(', ') : ''}`);

  if (dupes.length === 0) {
    const cyc = findCycle(graph.nodes.map((n) => n.id), graph.edges);
    if (cyc) errors.push(`graph's edges contain a cycle (on_fail.goto is the only sanctioned back-edge, and it is excluded from this check): ${cyc.join(' -> ')}`);
  }

  for (const n of graph.nodes) {
    if (n.kind !== 'agent' || !n.prompt_file) continue;
    const p = resolveP(resolvedCwd, n.prompt_file);
    if (!existsSync(p)) { errors.push(`node ${n.id}: prompt_file not found: ${n.prompt_file}`); continue; }
    let text;
    try { text = readFileSync(p, 'utf8'); } catch (e) { errors.push(`node ${n.id}: cannot read prompt_file: ${e.message}`); continue; }
    const hits = scanForInjection(text);
    if (hits.length) errors.push(`node ${n.id}: prompt_file embeds artifact contents (${hits.join(', ')}) — agent nodes exchange file paths only, never pasted content (design law 1)`);
  }

  if (graph.caps && graph.caps.attended !== true) errors.push('caps.attended must be true — no unattended graph runs');
  if (graph.caps && graph.caps.max_wall_minutes > WALL_HARD_CEILING_MIN) errors.push(`caps.max_wall_minutes must be <= ${WALL_HARD_CEILING_MIN} (hard ceiling)`);

  return errors;
}

// ---------------------------------------------------------------------
// env_deny, shell execution, produces/hash checks
// ---------------------------------------------------------------------
function buildChildEnv(envDeny) {
  const env = { ...process.env };
  for (const name of envDeny || []) delete env[name];
  return env;
}

function timeoutMsFor(node, fallbackMinutes = 10) {
  const m = (typeof node.timeout_minutes === 'number' && node.timeout_minutes > 0) ? node.timeout_minutes : fallbackMinutes;
  return Math.max(50, Math.round(m * 60000));
}

// The Windows shell never expands `~`, so a graph written with `~/.claude/...`
// (the portable form, valid on the laptop too) would fail here. Expand a
// leading `~/` or `~\` token to HOME before the shell sees it (2026-09-03,
// found by the first real graph). Pure, so the selftest can assert it.
function expandTilde(cmd) {
  const home = HOME.replace(/\\/g, '/');
  return String(cmd).replace(/(^|[\s"'=(])~(?=[\\/])/g, (m, p) => p + home);
}

function runShell(cmd, cwd, env, timeoutMs) {
  const t0 = Date.now();
  const r = spawnSync(expandTilde(cmd), { shell: true, cwd, encoding: 'utf8', timeout: timeoutMs, env, maxBuffer: 16 * 1024 * 1024 });
  const code = r.status === null ? -1 : r.status;
  return { code, stdout: r.stdout || '', stderr: r.stderr || '', ms: Date.now() - t0, timedOut: r.status === null };
}

function sha256File(absPath) {
  return 'sha256:' + createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

function checkProduces(node, cwd) {
  const missing = [];
  const produced = {};
  for (const p of node.produces || []) {
    const abs = resolveP(cwd, p);
    let size = -1;
    try { size = statSync(abs).size; } catch { missing.push(p); continue; }
    if (size === 0) { missing.push(p); continue; }
    produced[p] = sha256File(abs);
  }
  return { ok: missing.length === 0, missing, produced };
}

function sig(exitCode, stderrText) {
  return `${exitCode}:${String(stderrText || '').slice(-200)}`;
}

// ---------------------------------------------------------------------
// Agent node: claude -p headless. Flags follow SPEC.md's node-kind table
// literally: --permission-mode auto, --tools <allowlist>,
// --append-system-prompt-file <charter>, --max-budget-usd, --output-format
// json, cwd = graph cwd. Prompt travels via STDIN (same reasoning as
// loop-runner: multi-line prompts through the Windows cmd.exe shim would be
// a quoting disaster as argv).
// ---------------------------------------------------------------------
function expandPlaceholders(text, node) {
  return text
    .replace(/\{\{\s*inputs\s*\}\}/g, (node.inputs || []).join('\n'))
    .replace(/\{\{\s*produces\s*\}\}/g, (node.produces || []).join('\n'));
}

function parseAgentCost(stdout) {
  try {
    const j = JSON.parse(stdout || '{}');
    if (typeof j.total_cost_usd === 'number') return j.total_cost_usd;
    if (typeof j.cost_usd === 'number') return j.cost_usd;
  } catch { /* defensive, same posture as loop-runner's usage parse */ }
  return 0;
}

// Pure seam: the real `claude -p` argv for an agent node, so the selftest can
// assert on it without spawning anything (same pattern as loop-runner's
// buildAgentCommand). `--restricted` is the harness's own floor (strips
// shell/code tools and WebFetch unless named in --tools, confines file tools
// to cwd, refuses bypass); a node opts out only with `restricted: false`.
// `--tools <tools...>` is variadic — one argument per tool, never a
// comma-joined token (which the CLI would read as one unknown tool name).
function buildAgentArgs(node, charter) {
  const args = ['-p', '--permission-mode', 'auto'];
  if (node.restricted !== false) args.push('--restricted');
  if (node.tools) args.push('--tools', ...String(node.tools).split(/[,\s]+/).filter(Boolean));
  args.push('--append-system-prompt-file', charter);
  if (node.max_usd != null) args.push('--max-budget-usd', String(node.max_usd));
  args.push('--output-format', 'json');
  if (node.model) args.push('--model', node.model);
  return args;
}

function runAgentNode(node, cwd, env, timeoutMs) {
  const charter = join(HOME, '.claude', 'agents', `${node.agent}.md`);
  const promptPath = resolveP(cwd, node.prompt_file);
  const promptText = expandPlaceholders(readFileSync(promptPath, 'utf8'), node);
  const args = buildAgentArgs(node, charter);
  const t0 = Date.now();
  const r = spawnSync('claude', args, {
    cwd, encoding: 'utf8', timeout: timeoutMs, input: promptText,
    maxBuffer: 32 * 1024 * 1024, env, shell: process.platform === 'win32', // claude is a .cmd shim on Windows
  });
  const usd = parseAgentCost(r.stdout);
  return { code: r.status === null ? -1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '', usd, ms: Date.now() - t0, timedOut: r.status === null };
}

function runLoopNode(node, cwd, env, timeoutMs) {
  const cfgPath = resolveP(cwd, node.config);
  const loopRunnerPath = join(HOME, '.claude', 'tools', 'loop-runner.mjs');
  const t0 = Date.now();
  const r = spawnSync('node', [loopRunnerPath, '--config', cfgPath], { cwd, encoding: 'utf8', timeout: timeoutMs, env, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status === null ? -1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '', ms: Date.now() - t0 };
}

function executeGate(node, cwd, isResumedFirstStep, emit) {
  const writesPath = resolveP(cwd, node.writes);
  const reqPath = writesPath + '.request.json';
  if (isResumedFirstStep) {
    if (!existsSync(writesPath)) return { pass: false, exit: 2, ms: 0, usd: 0, stderrTail: `answer file not found: ${node.writes}` };
    let answer;
    try { answer = JSON.parse(readFileSync(writesPath, 'utf8')); }
    catch (e) { return { pass: false, exit: 2, ms: 0, usd: 0, stderrTail: `answer file unparseable: ${e.message}` }; }
    const errs = validateAgainstSchema(answer, node.answer_schema || {});
    if (errs.length) return { pass: false, exit: 2, ms: 0, usd: 0, stderrTail: `answer failed schema: ${errs.join('; ')}` };
    // The answer VALUE travels in the event (not just the file path) so the
    // replay viewer (S2) can show "the answer the human gave" without ever
    // reading an artifact off disk to fill a gap — it is small, schema-
    // validated control data the human explicitly chose, not client material
    // (2026-09-05, see SPEC.md "State and replay").
    emit('gate-answer', { node: node.id, writes: node.writes, answer });
    return { pass: true, exit: 0, ms: 0, usd: 0, produced: { [node.writes]: sha256File(writesPath) } };
  }
  mkdirSync(dirname(writesPath), { recursive: true });
  writeFileSync(reqPath, JSON.stringify({ node: node.id, question: node.question || '', reads: node.reads || [], answer_schema: node.answer_schema || {}, writes: node.writes }, null, 2));
  emit('gate-request', { node: node.id, question: node.question, writes: node.writes });
  return { pass: false, paused: true, exit: null, ms: 0, usd: 0 };
}

function executeNode(node, cwd, env, isResumedFirstStep, emit, graph) {
  const timeoutMs = timeoutMsFor(node);
  const t0 = Date.now();
  if (node.kind === 'script') {
    emit('command', { node: node.id, cmd: node.run });
    const r = runShell(node.run, cwd, env, timeoutMs);
    const pc = checkProduces(node, cwd);
    for (const [p, h] of Object.entries(pc.produced)) emit('produce', { node: node.id, path: p, hash: h });
    return { pass: r.code === 0 && pc.ok, exit: r.code, stderrTail: r.stderr.slice(-200) || (pc.missing.length ? `missing produces: ${pc.missing.join(', ')}` : ''), produced: pc.produced, ms: Date.now() - t0, usd: 0 };
  }
  if (node.kind === 'agent') {
    emit('command', { node: node.id, cmd: `claude -p (agent=${node.agent}, prompt_file=${node.prompt_file})` });
    const r = runAgentNode(node, cwd, env, timeoutMs);
    const pc = checkProduces(node, cwd);
    const capNode = node.max_usd ?? (graph.caps && graph.caps.max_usd_per_agent_node);
    const overCap = capNode != null && r.usd > capNode;
    for (const [p, h] of Object.entries(pc.produced)) emit('produce', { node: node.id, path: p, hash: h });
    let stderrTail = r.stderr.slice(-200);
    if (!stderrTail && !pc.ok) stderrTail = `missing produces: ${pc.missing.join(', ')}`;
    if (!stderrTail && overCap) stderrTail = `agent cost ${r.usd} exceeded node cap ${capNode}`;
    return { pass: r.code === 0 && pc.ok && !overCap, exit: r.code, stderrTail, produced: pc.produced, ms: Date.now() - t0, usd: r.usd };
  }
  if (node.kind === 'loop') {
    emit('command', { node: node.id, cmd: `loop-runner --config ${node.config}` });
    const r = runLoopNode(node, cwd, env, timeoutMs);
    return { pass: r.code === 0, exit: r.code, stderrTail: r.stderr.slice(-200), produced: {}, ms: Date.now() - t0, usd: 0 };
  }
  if (node.kind === 'gate') return executeGate(node, cwd, isResumedFirstStep, emit);
  throw new Error(`unknown node kind: ${node.kind}`);
}

// ---------------------------------------------------------------------
// State + events I/O — runner-owned, JSON. Agents never edit this.
// ---------------------------------------------------------------------
function runsDirFor(resolvedCwd) { return join(resolvedCwd, '.graph-runner'); }
function stateDirFor(resolvedCwd, runId) { return join(runsDirFor(resolvedCwd), runId); }
function statePathFor(resolvedCwd, runId) { return join(stateDirFor(resolvedCwd, runId), 'state.json'); }
function eventsPathFor(resolvedCwd, runId) { return join(stateDirFor(resolvedCwd, runId), 'events.jsonl'); }

function writeState(resolvedCwd, runId, state) {
  mkdirSync(stateDirFor(resolvedCwd, runId), { recursive: true });
  writeFileSync(statePathFor(resolvedCwd, runId), JSON.stringify(state, null, 2));
}
function readState(resolvedCwd, runId) {
  const p = statePathFor(resolvedCwd, runId);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function makeEventEmitter(resolvedCwd, runId) {
  mkdirSync(stateDirFor(resolvedCwd, runId), { recursive: true });
  const p = eventsPathFor(resolvedCwd, runId);
  return (type, fields) => {
    const entry = { ts: new Date().toISOString(), type, ...fields };
    if (entry.cmd !== undefined) entry.cmd = redact(entry.cmd);
    if (entry.answer !== undefined) entry.answer = redactDeep(entry.answer);
    appendFileSync(p, JSON.stringify(entry) + '\n');
  };
}
function readEvents(resolvedCwd, runId) {
  const p = eventsPathFor(resolvedCwd, runId);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return { parse_error: true, raw: l }; }
  });
}
function hashGraphText(raw) { return 'sha256:' + createHash('sha256').update(raw).digest('hex'); }
function newRunId() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + Math.random().toString(36).slice(2, 6);
}
function round6(n) { return Math.round(n * 1e6) / 1e6; }

// ---------------------------------------------------------------------
// Core run engine — shared by `run` and `resume`. `isResume` is true only
// for the FIRST node processed by this call: if that node is a gate, its
// pass condition becomes "the answer file exists and validates" instead of
// "write a request and pause" (see executeGate). Every subsequent gate hit
// later in the SAME invocation pauses fresh, same as a first encounter.
// ---------------------------------------------------------------------
function processOneNode(state, graph, nodesById, edgesFrom, resolvedCwd, childEnv, emit, isResumedFirstStep) {
  const nodeId = state.current;
  const node = nodesById[nodeId];
  if (!node) return { status: 'failed', halt_reason: null, error: `internal: unknown node id in state.current: ${nodeId}`, exitCode: 1 };

  const nodeState = state.nodes[nodeId] || (state.nodes[nodeId] = { status: 'pending', attempts: 0 });
  emit('node-start', { node: nodeId, kind: node.kind });

  let execResult;
  try {
    execResult = executeNode(node, resolvedCwd, childEnv, isResumedFirstStep, emit, graph);
  } catch (e) {
    return { status: 'failed', halt_reason: null, error: `internal error executing node ${nodeId}: ${e && e.message ? e.message : e}`, exitCode: 1 };
  }

  if (node.kind === 'gate' && execResult.paused) {
    nodeState.status = 'paused';
    return { status: 'paused', halt_reason: 'gate', exitCode: 3 };
  }

  nodeState.attempts += 1;
  nodeState.exit = execResult.exit;
  nodeState.ms = execResult.ms;
  if (typeof execResult.usd === 'number' && execResult.usd > 0) {
    state.usd_total = round6(state.usd_total + execResult.usd);
    nodeState.usd = round6((nodeState.usd || 0) + execResult.usd);
  } else if (nodeState.usd === undefined) {
    nodeState.usd = 0;
  }
  emit('exit', { node: nodeId, exit: execResult.exit, ms: execResult.ms, usd: execResult.usd || 0 });

  let advanced = false, edgeTarget = null, failSig = null;

  if (execResult.pass) {
    const outs = edgesFrom[nodeId] || [];
    if (outs.length === 0) {
      nodeState.status = 'done';
      Object.assign(nodeState.produced || (nodeState.produced = {}), execResult.produced || {});
      state.last_progressed = true;
      return { status: 'done', halt_reason: null, exitCode: 0 };
    }
    for (const e of outs) {
      const vr = runShell(e.verify, resolvedCwd, childEnv, 5 * 60 * 1000);
      emit('verify', { edge: `${e.from}->${e.to}`, exit: vr.code, ms: vr.ms });
      if (vr.code === 0) { advanced = true; edgeTarget = e.to; break; }
      failSig = sig(vr.code, vr.stderr);
    }
    if (advanced) {
      nodeState.status = 'done';
      Object.assign(nodeState.produced || (nodeState.produced = {}), execResult.produced || {});
      nodeState.lastFailSig = undefined;
      state.current = edgeTarget;
      state.last_progressed = true;
      return null; // continue looping
    }
    // node itself passed, but no outgoing edge verified — treated as a node failure
  } else {
    failSig = sig(execResult.exit, execResult.stderrTail || '');
  }

  // FAILURE PATH — retry in place, jump via on_fail, or halt (stall / cap:attempts)
  const prevSig = nodeState.lastFailSig;
  if (prevSig !== undefined && prevSig === failSig) {
    nodeState.status = 'stalled';
    state.last_progressed = false;
    return { status: 'halted', halt_reason: 'stall', exitCode: 3 };
  }
  state.last_progressed = prevSig !== undefined; // first-ever failure has no baseline -> not "progress"; a CHANGED failure is
  nodeState.lastFailSig = failSig;

  const capMax = (node.on_fail && node.on_fail.max) || (graph.caps && graph.caps.max_attempts_per_node) || 2;
  if (nodeState.attempts >= capMax) {
    nodeState.status = 'failed';
    return { status: 'halted', halt_reason: 'cap:attempts', exitCode: 3 };
  }

  if (node.on_fail && node.on_fail.goto) {
    state.current = node.on_fail.goto; // bounded back-edge
  } // else: retry the same node in place (state.current unchanged)
  return null; // continue looping
}

function runLoop(state, graph, resolvedCwd, childEnv, emit, isResume) {
  const nodesById = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  const edgesFrom = {};
  for (const e of graph.edges) (edgesFrom[e.from] || (edgesFrom[e.from] = [])).push(e);
  const segmentStart = Date.now();
  let firstStep = isResume;
  const persist = () => writeState(resolvedCwd, state.run_id, state);

  state.status = 'running';
  state.halt_reason = null;
  persist();

  while (true) {
    const elapsedMin = (state.active_ms + (Date.now() - segmentStart)) / 60000;
    if (elapsedMin >= graph.caps.max_wall_minutes) {
      state.active_ms = round6(state.active_ms + (Date.now() - segmentStart));
      state.status = 'halted';
      state.halt_reason = state.last_progressed ? 'budget-while-working' : 'cap:wall';
      persist();
      emit('halt', { status: state.status, reason: state.halt_reason });
      return { status: state.status, exitCode: 3 };
    }
    const usdCap = graph.caps.max_usd_total;
    if (usdCap != null && state.usd_total >= usdCap) {
      state.active_ms = round6(state.active_ms + (Date.now() - segmentStart));
      state.status = 'halted';
      state.halt_reason = state.last_progressed ? 'budget-while-working' : 'cap:usd';
      persist();
      emit('halt', { status: state.status, reason: state.halt_reason });
      return { status: state.status, exitCode: 3 };
    }

    const result = processOneNode(state, graph, nodesById, edgesFrom, resolvedCwd, childEnv, emit, firstStep);
    firstStep = false;

    if (result) {
      state.active_ms = round6(state.active_ms + (Date.now() - segmentStart));
      state.status = result.status;
      state.halt_reason = result.halt_reason ?? null;
      if (result.error) state.error = result.error;
      persist();
      emit('halt', { status: result.status, reason: state.halt_reason });
      return { status: result.status, exitCode: result.exitCode };
    }
    persist();
  }
}

// ---------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------
function checkNestedRefusal(allowNested) {
  if (process.env.CLAUDECODE && !allowNested) {
    console.error(
      'graph-runner: refusing to start — CLAUDECODE is set (a nested "claude -p" spawned from inside a live ' +
      'Claude Code session has been observed to time out). Run from a plain terminal, or pass --allow-nested ' +
      'to override and accept the risk.',
    );
    process.exit(2);
  }
}

function printResult(state, runId) {
  const label = { done: 'DONE', paused: 'PAUSED', halted: 'HALTED', failed: 'FAILED' }[state.status] || String(state.status).toUpperCase();
  console.log(
    `\n=== GRAPH ${label} === (run ${runId})\n` +
    `  status: ${state.status}\n` +
    `  halt_reason: ${state.halt_reason ?? 'null'}\n` +
    `  current: ${state.current}\n` +
    `  usd_total: ${state.usd_total}\n` +
    (state.error ? `  error: ${state.error}\n` : ''),
  );
}

function findPausedRuns(resolvedCwd, graphId, gateId) {
  const dir = runsDirFor(resolvedCwd);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const s = readState(resolvedCwd, entry.name);
    if (s && s.status === 'paused' && s.graph_id === graphId && s.current === gateId) out.push(entry.name);
  }
  return out;
}

// ---------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------
function cmdValidate(graphPathArg) {
  const graphPath = resolve(graphPathArg);
  let graph;
  try { ({ graph } = loadGraphFile(graphPath)); }
  catch (e) { console.error(`graph-runner validate: ${e.message}`); process.exit(2); }
  const errors = validateGraph(graph, graphPath);
  if (errors.length) {
    console.error(`graph-runner validate: ${errors.length} error(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(2);
  }
  console.log(`graph-runner validate: OK — ${graph.id} v${graph.version}, ${graph.nodes.length} nodes, ${graph.edges.length} edges.`);
  process.exit(0);
}

function cmdRun(graphPathArg, opts) {
  checkNestedRefusal(opts.allowNested);
  const graphPath = resolve(graphPathArg);
  let graph, raw;
  try { ({ graph, raw } = loadGraphFile(graphPath)); }
  catch (e) { console.error(`graph-runner run: ${e.message}`); process.exit(2); }
  const errors = validateGraph(graph, graphPath);
  if (errors.length) {
    console.error('graph-runner run: graph invalid, refusing to start:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(2);
  }

  const resolvedCwd = resolvedCwdFor(graph, graphPath);
  mkdirSync(resolvedCwd, { recursive: true });
  const runId = opts.runId || newRunId();
  const childEnv = buildChildEnv(graph.env_deny);
  const emit = makeEventEmitter(resolvedCwd, runId);

  const incoming = new Set(graph.edges.map((e) => e.to));
  const start = graph.nodes.find((n) => !incoming.has(n.id));

  const state = {
    graph_id: graph.id, run_id: runId, started_at: new Date().toISOString(),
    graph_hash: hashGraphText(raw),
    status: 'running', halt_reason: null, current: start.id,
    nodes: {}, usd_total: 0, active_ms: 0, last_progressed: false,
  };
  writeState(resolvedCwd, runId, state);

  console.log(
    `graph-runner run ${runId}\n` +
    `  graph: ${graph.id} (${graphPath})\n` +
    `  cwd:   ${resolvedCwd}\n` +
    `  caps:  ${graph.caps.max_wall_minutes} min wall | ${graph.caps.max_attempts_per_node ?? 2} attempts/node` +
    `${graph.caps.max_usd_total != null ? ` | $${graph.caps.max_usd_total} total cap` : ''}\n` +
    `  start: ${start.id}`,
  );

  const result = runLoop(state, graph, resolvedCwd, childEnv, emit, false);
  printResult(state, runId);
  process.exit(result.exitCode);
}

function cmdResume(graphPathArg, opts) {
  checkNestedRefusal(opts.allowNested);
  if (!opts.runId) { console.error('graph-runner resume: --run-id is required'); process.exit(2); }
  const graphPath = resolve(graphPathArg);
  let graph, raw;
  try { ({ graph, raw } = loadGraphFile(graphPath)); }
  catch (e) { console.error(`graph-runner resume: ${e.message}`); process.exit(2); }

  const resolvedCwd = resolvedCwdFor(graph, graphPath);
  const state = readState(resolvedCwd, opts.runId);
  if (!state) { console.error(`graph-runner resume: no state for run-id ${opts.runId} under ${runsDirFor(resolvedCwd)}`); process.exit(2); }

  const curHash = hashGraphText(raw);
  if (state.graph_hash !== curHash) {
    console.error('graph-runner resume: graph file has changed since this run started — refusing to resume (start a new run).');
    process.exit(2);
  }
  if (state.status !== 'paused') {
    console.error(`graph-runner resume: run ${opts.runId} is not paused (status=${state.status}); a halted run (cap/stall) never re-loops by design (design law 3) — fix the root cause and start a new run.`);
    process.exit(2);
  }
  if (state.halt_reason !== 'gate') {
    console.error(`graph-runner resume: run ${opts.runId} is paused for an unexpected reason (${state.halt_reason}); only gate pauses can be resumed.`);
    process.exit(2);
  }

  const nodesById = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  const gateNode = nodesById[state.current];
  if (!gateNode || gateNode.kind !== 'gate') {
    console.error(`graph-runner resume: current node ${state.current} is not a gate; state is inconsistent.`);
    process.exit(2);
  }
  const writesPath = resolveP(resolvedCwd, gateNode.writes);
  if (!existsSync(writesPath)) {
    console.error(`graph-runner resume: gate ${gateNode.id} has no answer yet at ${gateNode.writes} — use 'answer' first.`);
    process.exit(3);
  }
  let answer;
  try { answer = JSON.parse(readFileSync(writesPath, 'utf8')); }
  catch (e) { console.error(`graph-runner resume: answer file unparseable: ${e.message}`); process.exit(3); }
  const aerrs = validateAgainstSchema(answer, gateNode.answer_schema || {});
  if (aerrs.length) {
    console.error(`graph-runner resume: answer at ${gateNode.writes} fails answer_schema — ${aerrs.join('; ')}`);
    process.exit(3);
  }

  const childEnv = buildChildEnv(graph.env_deny);
  const emit = makeEventEmitter(resolvedCwd, opts.runId);
  emit('resume', { node: gateNode.id });

  console.log(`graph-runner resume ${opts.runId}\n  graph: ${graph.id}\n  cwd:   ${resolvedCwd}\n  gate:  ${gateNode.id} answered — continuing.`);

  const result = runLoop(state, graph, resolvedCwd, childEnv, emit, true);
  printResult(state, opts.runId);
  process.exit(result.exitCode);
}

function cmdAnswer(graphPathArg, gateId, jsonStr, opts) {
  const graphPath = resolve(graphPathArg);
  let graph;
  try { ({ graph } = loadGraphFile(graphPath)); }
  catch (e) { console.error(`graph-runner answer: ${e.message}`); process.exit(2); }

  const resolvedCwd = resolvedCwdFor(graph, graphPath);
  const nodesById = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  const gateNode = nodesById[gateId];
  if (!gateNode || gateNode.kind !== 'gate') { console.error(`graph-runner answer: ${gateId} is not a gate node in this graph`); process.exit(2); }

  let answer;
  try { answer = JSON.parse(jsonStr); }
  catch (e) { console.error(`graph-runner answer: <json> argument is not valid JSON: ${e.message}`); process.exit(2); }
  const errs = validateAgainstSchema(answer, gateNode.answer_schema || {});
  if (errs.length) { console.error(`graph-runner answer: answer fails ${gateId}'s answer_schema — ${errs.join('; ')}`); process.exit(2); }

  let runId = opts.runId;
  if (!runId) {
    const found = findPausedRuns(resolvedCwd, graph.id, gateId);
    if (found.length === 0) { console.error(`graph-runner answer: no paused run of ${graph.id} is waiting at gate ${gateId} under ${runsDirFor(resolvedCwd)} — pass --run-id if you know it.`); process.exit(2); }
    if (found.length > 1) { console.error(`graph-runner answer: ${found.length} paused runs are waiting at gate ${gateId} — disambiguate with --run-id (${found.join(', ')})`); process.exit(2); }
    [runId] = found;
  }
  const state = readState(resolvedCwd, runId);
  if (!state) { console.error(`graph-runner answer: no state for run-id ${runId}`); process.exit(2); }
  if (state.status !== 'paused' || state.current !== gateId) {
    console.error(`graph-runner answer: run ${runId} is not currently paused at gate ${gateId} (status=${state.status}, current=${state.current})`);
    process.exit(2);
  }

  const reqPath = resolveP(resolvedCwd, gateNode.writes) + '.request.json';
  if (!existsSync(reqPath)) { console.error(`graph-runner answer: no gate request file found at ${reqPath} — has this gate actually been reached?`); process.exit(2); }

  const writesPath = resolveP(resolvedCwd, gateNode.writes);
  mkdirSync(dirname(writesPath), { recursive: true });
  writeFileSync(writesPath, JSON.stringify(answer, null, 2));

  const emit = makeEventEmitter(resolvedCwd, runId);
  emit('gate-answer', { node: gateId, writes: gateNode.writes, answer });

  console.log(`graph-runner answer: wrote ${gateNode.writes} for gate ${gateId} in run ${runId}. Run 'resume <graph.json> --run-id ${runId}' to continue.`);
  process.exit(0);
}

function cmdReplay(graphPathArg, opts) {
  if (!opts.runId) { console.error('graph-runner replay: --run-id is required'); process.exit(2); }
  const graphPath = resolve(graphPathArg);
  let graph;
  try { ({ graph } = loadGraphFile(graphPath)); }
  catch (e) { console.error(`graph-runner replay: ${e.message}`); process.exit(2); }

  const resolvedCwd = resolvedCwdFor(graph, graphPath);
  const state = readState(resolvedCwd, opts.runId);
  if (!state) { console.error(`graph-runner replay: no state for run-id ${opts.runId}`); process.exit(2); }
  const events = readEvents(resolvedCwd, opts.runId);
  const replay = { graph, state, events };
  const outPath = opts.out ? resolve(opts.out) : join(stateDirFor(resolvedCwd, opts.runId), 'replay.json');
  writeFileSync(outPath, JSON.stringify(replay, null, 2));
  console.log(`graph-runner replay: wrote ${outPath} (${events.length} events, ${Object.keys(state.nodes || {}).length} nodes) — hashes only, no artifact bodies.`);
  process.exit(0);
}

// ---------------------------------------------------------------------
// --selftest — examples/echo, zero model calls. Copies the committed
// fixtures into temp cwds (never mutates examples/echo/ in place) and
// cleans up after itself, per the "never write outside the tool dir except
// <cwd>/.graph-runner/ for the run under test" rule.
// ---------------------------------------------------------------------
const DONE_MARKER = 'ARTIFACT-BODY-MARKER-7f3a9c';

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name), d = join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

function selftest() {
  const base = join(tmpdir(), 'graph-runner-selftest-' + Date.now());
  mkdirSync(base, { recursive: true });
  let failed = 0;
  // Counted as checks run, never typed: an earlier version hardcoded the
  // total, four checks were added later, and the summary line kept printing
  // 21/21 while 25 checks ran. The site and the docs read this number.
  let total = 0;
  const check = (name, ok, detail) => {
    total++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
    if (!ok) { failed++; if (detail) console.log(`      ${String(detail).slice(0, 400)}`); }
  };
  const self = process.argv[1];
  const runNode = (args, opts = {}) => spawnSync('node', [self, ...args], { encoding: 'utf8', timeout: 60000, cwd: opts.cwd, env: opts.env || process.env });

  const echoSrc = join(PKG_DIR, 'examples', 'echo');

  // ---- positive path: write, on_fail back-edge, gate pause, resume, replay ----
  const posDir = join(base, 'positive');
  copyDir(echoSrc, posDir);
  const posGraph = join(posDir, 'pipeline.graph.json');

  const v1 = runNode(['validate', posGraph]);
  check('positive graph validates', v1.status === 0, v1.stderr || v1.stdout);

  const r1 = runNode(['run', posGraph, '--run-id', 'selftest-pos', '--allow-nested'], { cwd: posDir });
  check('run pauses at gate (exit 3)', r1.status === 3, `stdout=${(r1.stdout || '').slice(-400)} stderr=${(r1.stderr || '').slice(-400)}`);
  check('run reports GRAPH PAUSED', /GRAPH PAUSED/.test(r1.stdout || ''), r1.stdout);

  const stateAfterRun = readState(posDir, 'selftest-pos');
  check(
    'on_fail back-edge fired exactly once (bump attempts == 2)',
    !!stateAfterRun && !!stateAfterRun.nodes.bump && stateAfterRun.nodes.bump.attempts === 2,
    JSON.stringify(stateAfterRun && stateAfterRun.nodes.bump),
  );
  check(
    'paused at gate1',
    !!stateAfterRun && stateAfterRun.current === 'gate1' && stateAfterRun.halt_reason === 'gate',
    JSON.stringify(stateAfterRun && { current: stateAfterRun.current, halt_reason: stateAfterRun.halt_reason }),
  );

  const ans = runNode(['answer', posGraph, 'gate1', JSON.stringify({ ok: true }), '--run-id', 'selftest-pos'], { cwd: posDir });
  check('answer accepted (exit 0)', ans.status === 0, ans.stderr || ans.stdout);

  const res1 = runNode(['resume', posGraph, '--run-id', 'selftest-pos', '--allow-nested'], { cwd: posDir });
  check('resume completes (exit 0)', res1.status === 0, `stdout=${(res1.stdout || '').slice(-400)} stderr=${(res1.stderr || '').slice(-400)}`);
  check('resume reports GRAPH DONE', /GRAPH DONE/.test(res1.stdout || ''), res1.stdout);

  const doneTxt = join(posDir, 'DONE.txt');
  check('finish node produced DONE.txt', existsSync(doneTxt) && readFileSync(doneTxt, 'utf8').length > 0);

  const replayOut = join(posDir, 'replay.json');
  const rep = runNode(['replay', posGraph, '--run-id', 'selftest-pos', '--out', replayOut], { cwd: posDir });
  check('replay exits 0', rep.status === 0, rep.stderr || rep.stdout);
  let noBodies = false, hashesMatch = false;
  if (existsSync(replayOut)) {
    const text = readFileSync(replayOut, 'utf8');
    noBodies = !text.includes(DONE_MARKER);
    try {
      const parsed = JSON.parse(text);
      const produced = parsed.state && parsed.state.nodes && parsed.state.nodes.finish && parsed.state.nodes.finish.produced;
      const expectedHash = existsSync(doneTxt) ? sha256File(doneTxt) : null;
      hashesMatch = !!produced && !!expectedHash && produced['DONE.txt'] === expectedHash;
    } catch { /* leave false */ }
  }
  check('replay.json exists', existsSync(replayOut));
  check('replay.json contains no artifact bodies', noBodies);
  check('replay.json hash matches file on disk', hashesMatch);

  // ---- stall / cap trip: a node blows its timeout_minutes twice with an
  // identical signature -> halt_reason "stall" ----
  const stallDir = join(base, 'stall');
  copyDir(echoSrc, stallDir);
  const stallGraph = join(stallDir, 'stall.graph.json');
  const r2 = runNode(['run', stallGraph, '--run-id', 'selftest-stall', '--allow-nested'], { cwd: stallDir });
  check('stall run halts (exit 3)', r2.status === 3, `stdout=${(r2.stdout || '').slice(-400)} stderr=${(r2.stderr || '').slice(-400)}`);
  const stallState = readState(stallDir, 'selftest-stall');
  check('stall halt_reason is "stall"', !!stallState && stallState.halt_reason === 'stall', JSON.stringify(stallState && { status: stallState.status, halt_reason: stallState.halt_reason }));
  check('stall reported in stdout', /stall/i.test(r2.stdout || ''), r2.stdout);

  // ---- negative controls ----
  const negDir = join(base, 'negative');
  mkdirSync(negDir, { recursive: true });
  const okGraph = JSON.parse(readFileSync(posGraph, 'utf8'));

  const noVerify = structuredClone(okGraph);
  delete noVerify.edges[0].verify;
  const noVerifyPath = join(negDir, 'no-verify.graph.json');
  writeFileSync(noVerifyPath, JSON.stringify(noVerify));
  const nv = runNode(['validate', noVerifyPath]);
  check('edge without verify fails validate (exit 2)', nv.status === 2, nv.stderr || nv.stdout);

  writeFileSync(join(negDir, 'bad-prompt.md'), 'Do the thing.\n{{cat prior.md}}\n');
  const injectionGraph = {
    id: 'inj-test', version: 1, cwd: '.', caps: { attended: true, max_wall_minutes: 5 },
    nodes: [{ id: 'A', kind: 'agent', agent: 'fake-agent', prompt_file: 'bad-prompt.md', produces: ['out.md'], tools: 'Read' }],
    edges: [],
  };
  const injPath = join(negDir, 'injection.graph.json');
  writeFileSync(injPath, JSON.stringify(injectionGraph));
  const inj = runNode(['validate', injPath]);
  check('prompt injection ({{cat ...}}) refused at validate (exit 2)', inj.status === 2, inj.stderr || inj.stdout);

  const unattended = structuredClone(okGraph);
  unattended.caps.attended = false;
  const unattendedPath = join(negDir, 'unattended.graph.json');
  writeFileSync(unattendedPath, JSON.stringify(unattended));
  const ua = runNode(['validate', unattendedPath]);
  check('attended:false refused at validate (exit 2)', ua.status === 2, ua.stderr || ua.stdout);

  const nestedDir = join(base, 'nested');
  copyDir(echoSrc, nestedDir);
  const nestedGraph = join(nestedDir, 'pipeline.graph.json');
  const nested = spawnSync('node', [self, 'run', nestedGraph, '--run-id', 'selftest-nested'], {
    encoding: 'utf8', timeout: 30000, cwd: nestedDir, env: { ...process.env, CLAUDECODE: '1' },
  });
  check('nested run without --allow-nested refused (exit 2)', nested.status === 2, nested.stderr || nested.stdout);
  check('nested refusal names the reason', /CLAUDECODE|nested/i.test(nested.stderr || ''), nested.stderr);

  // Agent-node spawn args (pure seam, no spawn): the harness floor and the
  // variadic --tools form are asserted here because they can only fail in a
  // real run, which the selftest never makes.
  const toolsOf = (args) => { const i = args.indexOf('--tools'); if (i === -1) return []; const out = []; for (const a of args.slice(i + 1)) { if (a.startsWith('--')) break; out.push(a); } return out; };
  const a1 = buildAgentArgs({ agent: 'x', tools: 'Read,Glob,Grep', max_usd: 1 }, 'charter.md');
  check('agent node args include --restricted by default', a1.includes('--restricted') && a1.includes('--permission-mode') && a1.includes('--max-budget-usd'), a1.join(' '));
  check('agent node --tools is one argument per tool, no comma tokens', toolsOf(a1).length === 3 && !toolsOf(a1).some((t) => t.includes(',')), a1.join(' '));
  check('restricted:false omits --restricted', !buildAgentArgs({ agent: 'x', restricted: false }, 'charter.md').includes('--restricted'));
  const tilde = expandTilde('node ~/.claude/tools/x.mjs --out "~/y" && echo ~/z; echo a~b');
  check('expandTilde expands leading ~/ tokens and leaves inner ~ alone', !/(^|[\s"])~\//.test(tilde) && tilde.includes('a~b') && tilde.includes('/.claude/tools/x.mjs'), tilde);

  try { rmSync(base, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }

  console.log(`\ngraph-runner selftest: ${total - failed}/${total} passed${failed ? ' — FAILURES ABOVE' : ''}`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------
// main dispatch
// ---------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();

  const cmd = argv[0];
  const arg = (name) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : null; };
  const has = (name) => argv.includes(name);

  if (cmd === 'validate') {
    if (!argv[1]) { console.error('usage: graph-runner.mjs validate <graph.json>'); process.exit(2); }
    return cmdValidate(argv[1]);
  }
  if (cmd === 'run') {
    if (!argv[1]) { console.error('usage: graph-runner.mjs run <graph.json> [--run-id <id>] [--allow-nested]'); process.exit(2); }
    return cmdRun(argv[1], { runId: arg('--run-id'), allowNested: has('--allow-nested') });
  }
  if (cmd === 'answer') {
    if (!argv[1] || !argv[2] || argv[3] === undefined) { console.error("usage: graph-runner.mjs answer <graph.json> <GATE_ID> '<json>' [--run-id <id>]"); process.exit(2); }
    return cmdAnswer(argv[1], argv[2], argv[3], { runId: arg('--run-id') });
  }
  if (cmd === 'resume') {
    if (!argv[1]) { console.error('usage: graph-runner.mjs resume <graph.json> --run-id <id> [--allow-nested]'); process.exit(2); }
    return cmdResume(argv[1], { runId: arg('--run-id'), allowNested: has('--allow-nested') });
  }
  if (cmd === 'replay') {
    if (!argv[1]) { console.error('usage: graph-runner.mjs replay <graph.json> --run-id <id> [--out replay.json]'); process.exit(2); }
    return cmdReplay(argv[1], { runId: arg('--run-id'), out: arg('--out') });
  }

  console.error('usage: graph-runner.mjs <validate|run|answer|resume|replay> ... | --selftest');
  process.exit(2);
}

try { main(); } catch (e) { console.error('graph-runner internal error:', e); process.exit(1); }
