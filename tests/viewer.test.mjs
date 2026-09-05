// tests/viewer.test.mjs — node:test only, zero dependencies.
//
// Two things this suite must prove, per the windlass build brief:
//   1. Every `--check` rule is provable to bite: for each rule, a fixture
//      that violates EXACTLY that rule fails, and the clean fixture passes.
//      A rule that cannot fail is not a check.
//   2. The honesty law: a value that was never recorded renders as
//      "not recorded", never as a fabricated 0/blank/guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderReplay, checkHtml } from '../src/viewer.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(HERE, '..');
const RUNNER = join(PKG_DIR, 'src', 'runner.mjs');
const ECHO_SRC = join(PKG_DIR, 'examples', 'echo');

// Built by runtime concatenation, same discipline as runner.mjs's own
// SECRET_PATTERNS: a static read of this file never sees a contiguous
// token-shaped string, only string-concat at test time produces one. Not a
// real credential — a fixture proving the --check secret rule fires.
function fakeGithubToken() {
  return 'gh' + 'p_' + 'A1b2C3'.repeat(6); // ghp_ + 36 alnum chars
}

function baseReplay() {
  const graph = {
    id: 'fixture-graph', version: 1, cwd: '.', artifacts_dir: '.',
    caps: { attended: true, max_wall_minutes: 5, max_attempts_per_node: 2, max_usd_total: 1 },
    env_deny: ['SOME_SECRET'],
    nodes: [
      { id: 'S1', kind: 'script', run: 'node -e "1"', produces: ['out.txt'], timeout_minutes: 1 },
      { id: 'A1', kind: 'agent', agent: 'fake-agent', prompt_file: 'p.md', produces: ['a-out.md'], tools: 'Read', max_usd: 1 },
      {
        id: 'GATE1', kind: 'gate', question: 'proceed?', reads: ['out.txt'],
        answer_schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
        writes: 'gate1-answer.json',
      },
      { id: 'L1', kind: 'loop', config: 'loop.json' },
      { id: 'NEVER', kind: 'script', run: 'node -e "1"', produces: ['never.txt'] },
    ],
    edges: [
      { from: 'S1', to: 'A1', verify: 'node -e "process.exit(0)"' },
      { from: 'A1', to: 'GATE1', verify: 'node -e "process.exit(0)"' },
      { from: 'GATE1', to: 'L1', verify: 'node -e "process.exit(0)"' },
    ],
  };
  const state = {
    graph_id: 'fixture-graph', run_id: 'fixture-run-1', started_at: '2026-09-05T00:00:00.000Z',
    graph_hash: 'sha256:deadbeef', status: 'done', halt_reason: null, current: 'L1',
    nodes: {
      S1: { status: 'done', attempts: 1, exit: 0, ms: 42, usd: 0, produced: { 'out.txt': 'sha256:aaa' } },
      A1: { status: 'done', attempts: 1, exit: 0, ms: 5000, usd: 0.0234, produced: { 'a-out.md': 'sha256:bbb' } },
      GATE1: { status: 'done', attempts: 1, exit: 0, ms: 0, usd: 0, produced: { 'gate1-answer.json': 'sha256:ccc' } },
      L1: { status: 'done', attempts: 1, exit: 0, ms: 900, usd: 0, produced: {} },
      // NEVER intentionally has no entry here — it was never reached.
    },
    usd_total: 0.0234, active_ms: 5942, last_progressed: true,
  };
  const events = [
    { ts: '2026-09-05T00:00:00.000Z', type: 'node-start', node: 'S1', kind: 'script' },
    { ts: '2026-09-05T00:00:00.010Z', type: 'command', node: 'S1', cmd: 'node -e "1"' },
    { ts: '2026-09-05T00:00:00.050Z', type: 'produce', node: 'S1', path: 'out.txt', hash: 'sha256:aaa' },
    { ts: '2026-09-05T00:00:00.050Z', type: 'exit', node: 'S1', exit: 0, ms: 42, usd: 0 },
    { ts: '2026-09-05T00:00:00.060Z', type: 'verify', edge: 'S1->A1', exit: 0, ms: 5 },
    { ts: '2026-09-05T00:00:00.070Z', type: 'node-start', node: 'A1', kind: 'agent' },
    { ts: '2026-09-05T00:00:00.080Z', type: 'command', node: 'A1', cmd: 'claude -p (agent=fake-agent, prompt_file=p.md)' },
    { ts: '2026-09-05T00:00:05.070Z', type: 'produce', node: 'A1', path: 'a-out.md', hash: 'sha256:bbb' },
    { ts: '2026-09-05T00:00:05.070Z', type: 'exit', node: 'A1', exit: 0, ms: 5000, usd: 0.0234 },
    { ts: '2026-09-05T00:00:05.080Z', type: 'verify', edge: 'A1->GATE1', exit: 0, ms: 3 },
    { ts: '2026-09-05T00:00:05.090Z', type: 'node-start', node: 'GATE1', kind: 'gate' },
    { ts: '2026-09-05T00:00:05.090Z', type: 'gate-request', node: 'GATE1', question: 'proceed?', writes: 'gate1-answer.json' },
    { ts: '2026-09-05T00:00:05.090Z', type: 'halt', status: 'paused', reason: 'gate' },
    { ts: '2026-09-05T00:10:00.000Z', type: 'resume', node: 'GATE1' },
    { ts: '2026-09-05T00:10:00.010Z', type: 'node-start', node: 'GATE1', kind: 'gate' },
    { ts: '2026-09-05T00:10:00.010Z', type: 'gate-answer', node: 'GATE1', writes: 'gate1-answer.json', answer: { ok: true } },
    { ts: '2026-09-05T00:10:00.010Z', type: 'exit', node: 'GATE1', exit: 0, ms: 0, usd: 0 },
    { ts: '2026-09-05T00:10:00.020Z', type: 'verify', edge: 'GATE1->L1', exit: 0, ms: 2 },
    { ts: '2026-09-05T00:10:00.030Z', type: 'node-start', node: 'L1', kind: 'loop' },
    { ts: '2026-09-05T00:10:00.040Z', type: 'command', node: 'L1', cmd: 'loop-runner --config loop.json' },
    { ts: '2026-09-05T00:10:00.930Z', type: 'exit', node: 'L1', exit: 0, ms: 900, usd: 0 },
  ];
  return { graph, state, events };
}

function cleanHtml() {
  return renderReplay(baseReplay(), { title: 'fixture replay' });
}

// ---------------------------------------------------------------------
// Rendering content — proves the page shows what the brief asked for.
// ---------------------------------------------------------------------
test('renderReplay: clean fixture output passes --check with zero problems', () => {
  const { problems } = checkHtml(cleanHtml());
  assert.deepEqual(problems, []);
});

test('renderReplay: shows the gate question and the answer the human gave', () => {
  const html = cleanHtml();
  assert.match(html, /proceed\?/);
  assert.match(html, /the answer the human gave/);
  assert.match(html, /"ok": true/);
});

test('renderReplay: shows the verify command text for edges', () => {
  const html = cleanHtml();
  assert.match(html, /process\.exit\(0\)/);
});

test('renderReplay: halt class and run metadata are shown', () => {
  const r = baseReplay();
  r.state.status = 'halted';
  r.state.halt_reason = 'cap:usd';
  const html = renderReplay(r);
  assert.match(html, /HALTED/);
  assert.match(html, /cap:usd/);
});

// ---------------------------------------------------------------------
// Honesty law — never fabricate a number that was not recorded.
// ---------------------------------------------------------------------
test('honesty law: a node never reached shows "not started" / "not recorded", never a bare 0', () => {
  const html = cleanHtml();
  const rowMatch = html.match(/<tr><td><code>NEVER<\/code><\/td>[\s\S]*?<\/tr>/);
  assert.ok(rowMatch, 'expected a summary row for the never-reached node');
  const row = rowMatch[0];
  assert.match(row, /not started/);
  assert.match(row, /not recorded/);
  assert.doesNotMatch(row, />\$0</);
  assert.doesNotMatch(row, />0 ms</);
  assert.doesNotMatch(row, />0</); // no bare zero anywhere in this row
});

test('honesty law: an exit event missing a cost field renders "not recorded", never $0', () => {
  const r = baseReplay();
  const ev = r.events.find((e) => e.type === 'exit' && e.node === 'L1');
  delete ev.usd;
  delete r.state.nodes.L1.usd;
  const html = renderReplay(r);
  const block = html.match(/<summary><span class="node-id"><code>L1<\/code>[\s\S]*?<\/details>/);
  assert.ok(block, 'expected an L1 timeline block');
  assert.match(block[0], /not recorded/);
  assert.doesNotMatch(block[0], /\$0(?!\.\d)/); // no bare "$0" cost value in this block
});

test('honesty law: an older gate-answer event with no answer field says so, never guesses a value', () => {
  const r = baseReplay();
  const ev = r.events.find((e) => e.type === 'gate-answer');
  delete ev.answer;
  const html = renderReplay(r);
  assert.match(html, /predates windlass recording gate-answer values/);
});

test('regression: a standalone gate-answer event (from "windlass answer", before resume) ' +
  'renders as a control banner, not a phantom node-attempt block', () => {
  // This is exactly what a real run produces: `answer` writes the file and
  // emits gate-answer once, well before `resume` ever runs and emits its
  // own gate-answer bound to a fresh node-start. An earlier version of this
  // file grouped the first, unbound gate-answer as a fake "attempt: not
  // recorded" node block for GATE1 — found by running the real echo example
  // end to end, not by a synthetic fixture.
  const r = baseReplay();
  // The real event order is: ..., gate-request, halt, [gap: nothing open],
  // resume, node-start (2nd), gate-answer (bound), exit, verify. The
  // standalone answer belongs right after "halt" and before "resume" —
  // splicing it anywhere else would land it inside an already-open block
  // and fail to reproduce the bug this test guards against.
  const haltIdx = r.events.findIndex((e) => e.type === 'halt');
  const standalone = { ts: '2026-09-05T00:05:00.000Z', type: 'gate-answer', node: 'GATE1', writes: 'gate1-answer.json', answer: { ok: true } };
  r.events.splice(haltIdx + 1, 0, standalone);

  const html = renderReplay(r);
  const gate1NodeIdCount = (html.match(/<span class="node-id"><code>GATE1<\/code>/g) || []).length;
  assert.equal(gate1NodeIdCount, 2, 'expected exactly 2 GATE1 node blocks (the paused attempt and the resumed attempt) — a standalone gate-answer must not create a third');
  assert.doesNotMatch(html, /attempt not recorded/);
  assert.match(html, /control control-answer/);
  assert.match(html, /a human answered gate/);
});

// ---------------------------------------------------------------------
// --check rules: each one is proven to bite (a targeted violation fails)
// and proven not to be a false alarm (the clean fixture passes).
// ---------------------------------------------------------------------
test('--check: clean fixture has no problems (baseline for every rule below)', () => {
  assert.deepEqual(checkHtml(cleanHtml()).problems, []);
});

test('--check rule: remote https resource is caught', () => {
  const bad = cleanHtml().replace('</body>', '<img src="https://evil.example/x.png"></body>');
  const { problems } = checkHtml(bad);
  assert.ok(problems.some((p) => /remote resource/.test(p)), problems.join('; '));
});

test('--check rule: protocol-relative resource is caught', () => {
  const bad = cleanHtml().replace('</body>', '<img src="//evil.example/x.png"></body>');
  const { problems } = checkHtml(bad);
  assert.ok(problems.some((p) => /remote resource/.test(p)), problems.join('; '));
});

test('--check rule: a <script> tag is caught', () => {
  const bad = cleanHtml().replace('</body>', '<script>alert(1)</script></body>');
  const { problems } = checkHtml(bad);
  assert.ok(problems.some((p) => /<script>/.test(p)), problems.join('; '));
});

test('--check rule: missing viewport meta is caught', () => {
  const bad = cleanHtml().replace(/<meta name="viewport"[^>]*>/, '');
  const { problems } = checkHtml(bad);
  assert.ok(problems.some((p) => /viewport/.test(p)), problems.join('; '));
});

test('--check rule: missing print stylesheet is caught', () => {
  const clean = cleanHtml();
  assert.match(clean, /@media print\{/, 'fixture must actually contain a print media query to remove');
  // Rename the media FEATURE itself (not just append text) so the mutated
  // string no longer contains "print" anywhere — "printDISABLED" would
  // still match /@media print/i and silently fail to prove this rule bites.
  const bad = clean.replace('@media print{', '@media speech{');
  assert.doesNotMatch(bad, /@media print/i);
  const { problems } = checkHtml(bad);
  assert.ok(problems.some((p) => /print stylesheet/.test(p)), problems.join('; '));
});

test('--check rule: unbalanced tags are caught', () => {
  const bad = cleanHtml().replace('</details>', '');
  const { problems } = checkHtml(bad);
  assert.ok(problems.some((p) => /unbalanced tags/.test(p)), problems.join('; '));
});

test('--check rule: a collapsed <details> is caught', () => {
  const clean = cleanHtml();
  assert.match(clean, /<details class="block" open>/, 'fixture must actually contain an open details block to mutate');
  const bad = clean.replace('<details class="block" open>', '<details class="block">');
  const { problems } = checkHtml(bad);
  assert.ok(problems.some((p) => /collapsed/.test(p)), problems.join('; '));
});

test('--check rule: a credential-shaped string is caught', () => {
  const bad = cleanHtml().replace('</body>', `<p>${fakeGithubToken()}</p></body>`);
  const { problems } = checkHtml(bad);
  assert.ok(problems.some((p) => /GitHub token/.test(p)), problems.join('; '));
});

// ---------------------------------------------------------------------
// Integration: a REAL run of the runner produces a REAL replay.json, and
// the viewer renders it to a --check-clean page with the actual answer
// value the human gave — end to end, no synthetic fixtures.
// ---------------------------------------------------------------------
test('integration: a real echo run renders to a clean, honest replay page', () => {
  const base = mkdtempSync(join(tmpdir(), 'windlass-viewer-test-'));
  try {
    cpSync(ECHO_SRC, base, { recursive: true });
    const graphPath = join(base, 'pipeline.graph.json');
    const runId = 'viewer-test-1';
    const run1 = spawnSync(process.execPath, [RUNNER, 'run', graphPath, '--run-id', runId, '--allow-nested'], { cwd: base, encoding: 'utf8' });
    assert.equal(run1.status, 3, run1.stderr || run1.stdout);

    const ans = spawnSync(process.execPath, [RUNNER, 'answer', graphPath, 'gate1', JSON.stringify({ ok: true }), '--run-id', runId], { cwd: base, encoding: 'utf8' });
    assert.equal(ans.status, 0, ans.stderr || ans.stdout);

    const res1 = spawnSync(process.execPath, [RUNNER, 'resume', graphPath, '--run-id', runId, '--allow-nested'], { cwd: base, encoding: 'utf8' });
    assert.equal(res1.status, 0, res1.stderr || res1.stdout);

    const replayOut = join(base, '.graph-runner', runId, 'replay.json');
    const rep = spawnSync(process.execPath, [RUNNER, 'replay', graphPath, '--run-id', runId, '--out', replayOut], { cwd: base, encoding: 'utf8' });
    assert.equal(rep.status, 0, rep.stderr || rep.stdout);

    const replay = JSON.parse(readFileSync(replayOut, 'utf8'));
    const html = renderReplay(replay, { title: 'echo integration replay' });
    const { problems } = checkHtml(html);
    assert.deepEqual(problems, []);
    assert.match(html, /"ok": true/); // the real gate answer, sourced from events.jsonl
    assert.match(html, /DONE — the graph completed\./);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
