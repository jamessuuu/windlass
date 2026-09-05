/**
 * Gate answers are the ONE exception to design law 6: the answer value itself
 * travels in events.jsonl, not just the path it was written to, because "the
 * gate a human answered" is the fact an attended replay exists to show.
 *
 * That exception is only safe because every string leaf of the answer is
 * redacted before it is written. This file is the proof. A privacy guarantee
 * that is not tested is a promise, not a control, and a replay is published.
 *
 * Verified by running the real runner end to end (no mocks): a secret planted
 * in a gate answer must not survive anywhere in the events log.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, '..', 'src', 'runner.mjs');
const GRAPH = join(HERE, '..', 'examples', 'echo', 'pipeline.graph.json');

/** A GitHub-token-shaped string, built by concatenation so this file never
 *  contains a literal that a secret scanner would flag. */
const FAKE_TOKEN = 'ghp_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

function run(cwd, args) {
  return execFileSync(process.execPath, [RUNNER, ...args, '--allow-nested'], {
    cwd,
    encoding: 'utf8',
    // The runner refuses to start under a live Claude Code session unless
    // --allow-nested is passed; the flag is above. CLAUDECODE is stripped as
    // well so the test behaves identically in and out of a session.
    env: { ...process.env, CLAUDECODE: '' },
  });
}

function eventsOf(cwd) {
  const base = join(cwd, '.graph-runner');
  const runs = readdirSync(base);
  assert.equal(runs.length, 1, 'expected exactly one run directory');
  const p = join(base, runs[0], 'events.jsonl');
  assert.ok(existsSync(p), 'events.jsonl was not written');
  return readFileSync(p, 'utf8');
}

test('a secret planted in a gate answer never reaches events.jsonl', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'windlass-redact-'));
  copyFileSync(GRAPH, join(cwd, 'pipeline.graph.json'));

  // Runs until the gate, which halts with exit 3. execFileSync throws on a
  // non-zero exit, and a paused gate IS non-zero, so the throw is expected.
  try {
    run(cwd, ['run', 'pipeline.graph.json']);
  } catch (err) {
    assert.equal(err.status, 3, `expected the gate to pause with exit 3, got ${err.status}`);
  }

  run(cwd, ['answer', 'pipeline.graph.json', 'gate1', JSON.stringify({ ok: true, note: `token ${FAKE_TOKEN}` })]);

  const events = eventsOf(cwd);
  assert.ok(!events.includes(FAKE_TOKEN), 'the raw token survived into events.jsonl');
  assert.match(events, /"type":"gate-answer"/, 'no gate-answer event was recorded');
  assert.match(events, /REDACTED/, 'the answer was logged but nothing was redacted');
});

test('the human decision itself still survives, or the replay shows nothing', () => {
  // The redaction must not be so blunt that it eats the answer. A replay whose
  // whole point is "the gate a human answered" is worthless if the answer is
  // scrubbed to nothing, so this asserts the other side of the same rule.
  const cwd = mkdtempSync(join(tmpdir(), 'windlass-keep-'));
  copyFileSync(GRAPH, join(cwd, 'pipeline.graph.json'));

  try {
    run(cwd, ['run', 'pipeline.graph.json']);
  } catch (err) {
    assert.equal(err.status, 3);
  }
  run(cwd, ['answer', 'pipeline.graph.json', 'gate1', JSON.stringify({ ok: true })]);

  const line = eventsOf(cwd)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((e) => e.type === 'gate-answer');

  assert.ok(line, 'no gate-answer event');
  assert.deepEqual(line.answer, { ok: true }, 'the decision the human made was not preserved');
});

// ---------------------------------------------------------------------------
// One test per documented exit code.
//
// The README's "Exit codes" table is a promise, and CL5 in the cli-library
// harness pack holds it to one: every code the table documents must have a
// test that produces it. Each title names its code so the table and the proof
// are greppable to each other. Exit 3 is the one that matters — a runner that
// cannot prove it stops at a gate is not a runner with human gates.
// ---------------------------------------------------------------------------

test('exit 0: validate accepts a well-formed graph', () => {
  const out = run(process.cwd(), ['validate', GRAPH]);
  assert.match(out, /\S/, 'validate printed nothing');
});

test('exit 2: a graph file that does not exist is a config error, not a failure', () => {
  try {
    run(process.cwd(), ['validate', 'no-such-graph.json']);
    assert.fail('expected a non-zero exit');
  } catch (err) {
    assert.equal(err.status, 2, `expected exit 2, got ${err.status}`);
  }
});

test('exit 3: the run stops at the gate and waits for a human', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'windlass-exit3-'));
  copyFileSync(GRAPH, join(cwd, 'pipeline.graph.json'));
  try {
    run(cwd, ['run', 'pipeline.graph.json']);
    assert.fail('the gate did not stop the run, which is the whole contract');
  } catch (err) {
    assert.equal(err.status, 3, `expected exit 3 (paused), got ${err.status}`);
  }
});

test('exit 1: --check finds a violation in a rendered replay and says no', () => {
  // The other half of the table's `1`: not a config problem, an actual
  // verdict. A replay page carrying a <script> is not self-contained, and the
  // gate is supposed to refuse it rather than warn and pass.
  const cwd = mkdtempSync(join(tmpdir(), 'windlass-exit1-'));
  const bad = join(cwd, 'bad.html');
  writeFileSync(
    bad,
    '<!doctype html><html><head><meta name="viewport" content="width=device-width">' +
      '<style>@media print{body{color:#000}}</style></head><body>' +
      '<script>alert(1)</script><details open><summary>s</summary><pre>x</pre></details>' +
      '</body></html>',
    'utf8',
  );
  try {
    execFileSync(process.execPath, [join(HERE, '..', 'src', 'viewer.mjs'), '--check', bad], { encoding: 'utf8' });
    assert.fail('--check passed a page containing a <script>');
  } catch (err) {
    assert.equal(err.status, 1, `expected exit 1, got ${err.status}`);
  }
});
