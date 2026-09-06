/**
 * "No model inside the runner" is the first sentence of the README. A claim
 * like that needs something that fails when it stops being true, so this file
 * pins the three facts the sentence rests on:
 *
 *   1. package.json declares zero runtime dependencies, so there is no SDK to
 *      call a model with;
 *   2. src/runner.mjs contains no HTTP client and no model API reference;
 *   3. the only route to a model is spawning the `claude` CLI as a child
 *      process for an agent node, which the runner then checks the way it
 *      checks a script: exit code, produced files, cost cap.
 *
 * These are static checks, and they say so. They cannot prove a negative at
 * runtime; they prove that the source has not grown the thing it says it
 * lacks. The selftest (`npm run selftest`) is the runtime half: it runs the
 * whole graph and makes zero model calls.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(ROOT, 'src', 'runner.mjs');

test('the runner has no model inside it: zero dependencies, no HTTP client, no model SDK', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'a runtime dependency appeared in package.json');

  const src = readFileSync(RUNNER, 'utf8');
  // Import and call shapes, not words: the runner legitimately names
  // "openai-style key" and "anthropic key" as token shapes it redacts.
  const forbidden = [
    "from 'node:http'", "from 'node:https'", "require('http')", "require('https')",
    'fetch(', 'XMLHttpRequest', 'WebSocket(',
    "from '@anthropic-ai/", "require('@anthropic-ai/", "from 'openai'", "require('openai')",
    'api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com',
  ];
  for (const needle of forbidden) {
    assert.ok(!src.includes(needle), `src/runner.mjs contains "${needle}", which is a way to reach a model from inside the runner`);
  }
});

test('an agent node is a spawned claude process, checked like a script', () => {
  const src = readFileSync(RUNNER, 'utf8');
  // The one place a model is reached: a child process, by name, with argv
  // built by a pure function the selftest asserts on.
  assert.match(src, /spawnSync\('claude',\s*args/, 'agent nodes must spawn the claude CLI as a child process');
  assert.match(src, /function buildAgentArgs\(/, 'the agent argv builder must stay a pure, testable seam');
  // And what comes back is judged the way a script is judged.
  assert.match(src, /--max-budget-usd/, 'the per-node USD cap must be passed to the child, not enforced by the model');
});
