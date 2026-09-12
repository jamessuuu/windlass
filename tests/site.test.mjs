/**
 * The site must not state a number the artifact does not.
 *
 * site/index.html is filled in by bin/build-site.mjs from the runner, the
 * test files, the committed demo run and package.json. This file derives
 * every one of those values again, on its own, and compares. It also holds
 * the page to the rest of its promises: the served replay is the committed
 * artifact byte for byte and still passes the viewer's own gate; every test
 * the page quotes exists; the canonical sentence is identical everywhere it
 * appears; the copy uses none of the words the house forbids; no script runs.
 *
 * No network, no browser. Files on disk, compared.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const INDEX = join(SITE, 'index.html');
const RUNNER = join(ROOT, 'src', 'runner.mjs');
const VIEWER = join(ROOT, 'src', 'viewer.mjs');
const DEMO_RUN_DIR = join(ROOT, 'examples', 'demo', '.graph-runner', 'demo');

const page = () => readFileSync(INDEX, 'utf8');

/** <!-- gen:NAME -->value<!-- /gen:NAME --> */
function gen(name) {
  const m = page().match(new RegExp(`<!-- gen:${name} -->([\\s\\S]*?)<!-- /gen:${name} -->`));
  assert.ok(m, `region ${name} is not on the page; run npm run build:site`);
  return m[1];
}
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// ---------------------------------------------------------------------------
// numbers
// ---------------------------------------------------------------------------

test('selftest checks on the page equal a real selftest run', () => {
  const r = spawnSync(process.execPath, [RUNNER, '--selftest'], { encoding: 'utf8', timeout: 120000, env: { ...process.env, CLAUDECODE: '' } });
  const m = (r.stdout || '').match(/selftest: (\d+)\/(\d+) passed/);
  assert.ok(m, 'the selftest printed no summary line');
  assert.equal(r.status, 0, 'the selftest is failing; the page must not publish it');
  const receipts = gen('receipts');
  assert.ok(receipts.includes(`<td class="n">${m[1]} / ${m[2]}</td>`), `page does not state selftest ${m[1]} / ${m[2]}`);
});

test('test counts on the page equal the test() declarations in tests/', () => {
  const files = readdirSync(join(ROOT, 'tests')).filter((f) => /\.test\.mjs$/.test(f)).sort();
  let total = 0;
  const parts = [];
  for (const f of files) {
    const n = (readFileSync(join(ROOT, 'tests', f), 'utf8').match(/^test\(/gm) || []).length;
    total += n;
    parts.push(`${f.replace('.test.mjs', '')} ${n}`);
  }
  const expected = `<td class="n">${total} (${parts.join(', ')})</td>`;
  assert.ok(gen('receipts').includes(expected), `page does not state "${expected}"`);
});

test('demo-run numbers on the page equal the committed run files', () => {
  const replay = JSON.parse(readFileSync(join(DEMO_RUN_DIR, 'replay.json'), 'utf8'));
  const state = JSON.parse(readFileSync(join(DEMO_RUN_DIR, 'state.json'), 'utf8'));
  const events = readFileSync(join(DEMO_RUN_DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const gates = replay.graph.nodes.filter((n) => n.kind === 'gate').length;
  const answer = JSON.stringify(events.find((e) => e.type === 'gate-answer').answer);

  assert.equal(gen('bump-attempts'), String(state.nodes.bump.attempts));
  assert.equal(gen('events'), String(events.length));
  assert.equal(gen('nodes'), String(replay.graph.nodes.length));
  assert.equal(gen('run-date'), `<time datetime="${state.started_at}">${state.started_at.slice(0, 10)}</time>`);

  const receipts = gen('receipts');
  for (const cell of [
    `${replay.graph.nodes.length} nodes, ${replay.graph.edges.length} edges`,
    `<td class="n">${gates}</td>`,
    `<td class="n">${events.length}</td>`,
    `<td class="n">${state.nodes.bump.attempts}</td>`,
    `<td class="n">${state.active_ms} ms,`,
    `<td class="n">$${state.usd_total},`,
    `<td class="n">${answer.replace(/"/g, '&quot;')}</td>`,
  ]) assert.ok(receipts.includes(cell), `receipts table lacks "${cell}"`);
});

test('the token-shape list on the page equals SECRET_PATTERNS in the runner', () => {
  const src = readFileSync(RUNNER, 'utf8');
  const block = src.slice(src.indexOf('const SECRET_PATTERNS = ['), src.indexOf('].map('));
  const names = [...block.matchAll(/^\s*\['([^']+)',/gm)].map((m) => m[1]);
  assert.ok(names.length > 0);
  assert.equal(gen('shape-count'), String(names.length));
  const listed = [...gen('shapes').matchAll(/<li>([^<]+)<\/li>/g)].map((m) => unescape(m[1]));
  assert.deepEqual(listed, names, 'the list on the page is not the runner\'s list');
  assert.ok(gen('receipts').includes(`<td class="n">${names.length}</td>`));
});

test('package facts on the page equal package.json', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(gen('deps'), String(Object.keys(pkg.dependencies ?? {}).length));
  assert.equal(gen('node-version'), String(pkg.engines.node).match(/(\d+)/)[1]);
});

// ---------------------------------------------------------------------------
// the artifact
// ---------------------------------------------------------------------------

test('the served replay is the committed artifact, byte for byte', () => {
  const a = readFileSync(join(ROOT, 'examples', 'demo-replay.html'));
  const b = readFileSync(join(SITE, 'demo-replay.html'));
  assert.ok(a.equals(b), 'site/demo-replay.html differs from examples/demo-replay.html; run npm run build:site');
  const kb = Math.round(statSync(join(SITE, 'demo-replay.html')).size / 1024);
  assert.equal(gen('replay-kb'), String(kb));
});

test('the served replay still passes windlass view --check', () => {
  const r = spawnSync(process.execPath, [VIEWER, '--check', join(SITE, 'demo-replay.html')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('the excerpts on the page are verbatim slices of the served replay', () => {
  const replay = readFileSync(join(SITE, 'demo-replay.html'), 'utf8');
  for (const name of ['replay-meta', 'replay-nodes', 'replay-gate']) {
    const slice = gen(name).trim();
    assert.ok(slice.length > 100, `${name} excerpt is too short to be real`);
    assert.ok(replay.includes(slice), `${name} excerpt is not a verbatim slice of the replay`);
  }
  assert.match(gen('replay-gate'), /the answer the human gave/);
  assert.match(gen('replay-gate'), /paused — waiting on human/);
});

// ---------------------------------------------------------------------------
// promises about the copy
// ---------------------------------------------------------------------------

test('every test the page quotes exists verbatim in the suite or the selftest', () => {
  const known = new Set();
  for (const f of readdirSync(join(ROOT, 'tests')).filter((x) => /\.test\.mjs$/.test(x))) {
    for (const m of readFileSync(join(ROOT, 'tests', f), 'utf8').matchAll(/^test\(\s*'((?:[^'\\]|\\.)*)'/gm)) known.add(m[1]);
  }
  const src = readFileSync(RUNNER, 'utf8');
  for (const m of src.matchAll(/^\s*check\(\s*'((?:[^'\\]|\\.)*)'/gm)) known.add(m[1]);
  for (const m of src.matchAll(/^\s*check\(\s*\n\s*'((?:[^'\\]|\\.)*)'/gm)) known.add(m[1]);
  const quoted = [...page().matchAll(/<code class="t">([^<]+)<\/code>/g)].map((m) => unescape(m[1]));
  assert.ok(quoted.length >= 6, 'expected the page to quote its receipts');
  for (const t of quoted) assert.ok(known.has(t), `quoted test does not exist: "${t}"`);
});

test('the canonical sentence is byte-identical in the meta description, the JSON-LD, llms.txt and the README', () => {
  const html = page();
  const desc = unescape(html.match(/<meta name="description" content="([^"]+)">/)[1]);
  assert.ok(desc.length >= 70 && desc.length <= 160, `description is ${desc.length} chars`);
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  for (const node of ld['@graph']) assert.equal(node.description, desc, `JSON-LD ${node['@type']} description differs`);
  assert.ok(readFileSync(join(SITE, 'llms.txt'), 'utf8').includes(desc), 'llms.txt lacks the sentence');
  assert.ok(readFileSync(join(ROOT, 'README.md'), 'utf8').includes(desc), 'README.md lacks the sentence');
});

test('the page uses none of the words the house forbids', () => {
  const text = page().replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ');
  const banned = [
    'AI-powered', 'production-grade', 'passionate', '10x', 'simply', 'powerful', 'seamless', 'robust', 'leverage',
    'unlock', 'supercharge', 'cutting-edge', 'best-in-class', 'revolutionary', 'Certainly', 'In conclusion',
  ];
  for (const w of banned) assert.doesNotMatch(text, new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), `page uses "${w}"`);
  // "just" is banned as filler; the excerpt is the artifact's text, the prose is ours
  const prose = text.replace(/GRAPH PAUSED[^.]*\./g, '');
  assert.doesNotMatch(prose, /\bjust\b/i, 'page uses "just"');
  // em dashes are banned in copy this repo writes; the ones inside the excerpt
  // belong to the artifact and are counted against the artifact alone
  const ours = page().replace(/<!-- gen:replay-[\s\S]*?<!-- \/gen:replay-[a-z]+ -->/g, '').replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(ours, /—/, 'an em dash reached the page copy');
});

test('no script runs on the page, and nothing is fetched from another origin', () => {
  const html = page();
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  for (const s of scripts) assert.match(s, /type="application\/ld\+json"/, `a runnable script tag is on the page: ${s}`);
  // www.linkedin.com joined this list on 2026-09-06 with the attribution kit.
  // agentjames.vercel.app -- the kit's other link -- was already allowed, so
  // the allowlist simply predated the kit's second link rather than objecting
  // to it. Checked before widening: LinkedIn appears exactly once, as an
  // <a href> with rel="me", and zero times in a src= or <link>. So nothing is
  // FETCHED from it and this test's actual promise still holds.
  // www.onlinejobs.ph and ph.jobstreet.com joined on 2026-09-12 the same way
  // (register R15/R17): each is one <a href rel="me"> in the maker line and
  // nothing else, checked the same way before widening.
  // The regex covers href too, which means it polices outbound anchors as well
  // as resource loads; that is the stricter reading and worth keeping, but it
  // is why an ordinary hyperlink needs an entry here at all.
  assert.doesNotMatch(html, /\b(?:src|href)="(?:https?:)?\/\/(?!github\.com|agentjames\.vercel\.app|windlass-lyart\.vercel\.app|www\.linkedin\.com|www\.onlinejobs\.ph|ph\.jobstreet\.com|schema\.org|opensource\.org)/, 'a remote resource or link to an unexpected host');
  assert.doesNotMatch(html, /<link[^>]+href="https?:\/\/(?!windlass-lyart\.vercel\.app\/)/, 'a stylesheet or asset is loaded from another origin');
});

test('every internal link and asset on the page resolves to a file under site/', () => {
  const html = page();
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const target = m[1];
    if (/^https?:/.test(target) || target.startsWith('data:')) continue;
    if (target.startsWith('#')) { assert.ok(ids.has(target.slice(1)), `anchor ${target} has no id`); continue; }
    const rel = target.replace(/^\//, '');
    const candidates = rel === '' ? ['index.html'] : [rel, `${rel}.html`];
    assert.ok(candidates.some((c) => existsSync(join(SITE, c))), `${target} does not resolve under site/`);
  }
});

test('sitemap, robots, canonical and og:url agree on one origin', () => {
  const html = page();
  const canonical = html.match(/<link rel="canonical" href="([^"]+)">/)[1];
  const origin = new URL(canonical).origin;
  assert.equal(html.match(/<meta property="og:url" content="([^"]+)">/)[1], `${origin}/`);
  assert.ok(html.match(/<meta property="og:image" content="([^"]+)">/)[1].startsWith(origin + '/'));
  const sitemap = readFileSync(join(SITE, 'sitemap.xml'), 'utf8');
  for (const m of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) assert.equal(new URL(m[1]).origin, origin);
  assert.ok(readFileSync(join(SITE, 'robots.txt'), 'utf8').includes(`Sitemap: ${origin}/sitemap.xml`));
});
