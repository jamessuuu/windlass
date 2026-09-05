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
import { mkdtempSync, copyFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
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
