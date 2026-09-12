#!/usr/bin/env node
/**
 * Build site/ from the artifacts it describes.
 *
 * The page under site/ states numbers: how many selftest checks passed, how
 * many tests the suite has, how many nodes and events the demo run recorded,
 * how many token shapes the redaction knows. Not one of them is typed. This
 * script derives each from its source and writes it into the page between
 * <!-- gen:NAME --> markers, then tests/site.test.mjs derives every value a
 * second time and fails if the page disagrees.
 *
 * It also re-renders examples/demo-replay.html from the committed run data
 * with the same `windlass view` command the README documents, and copies the
 * result into site/. The page can therefore never drift from the artifact:
 * the artifact is regenerated, the copy is byte-for-byte, and the test
 * asserts both.
 *
 * Deterministic, idempotent, no model in the loop. Zero dependencies.
 *
 * The one thing you may need to edit: SITE_ORIGIN, if the deploy lands on a
 * different hostname than the one named here.
 */

import { readFileSync, writeFileSync, copyFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const INDEX = join(SITE, 'index.html');
const RUNNER = join(ROOT, 'src', 'runner.mjs');
const CLI = join(ROOT, 'bin', 'windlass.mjs');
const VIEWER = join(ROOT, 'src', 'viewer.mjs');
const DEMO_RUN_DIR = join(ROOT, 'examples', 'demo', '.graph-runner', 'demo');
const DEMO_REPLAY = join(ROOT, 'examples', 'demo-replay.html');
const SITE_REPLAY = join(SITE, 'demo-replay.html');

/** Production origin. One place. Change it here if the hostname differs. */
export const SITE_ORIGIN = 'https://windlass-lyart.vercel.app';
export const REPO_URL = 'https://github.com/jamessuuu/windlass';
export const PORTFOLIO_URL = 'https://agentjames.vercel.app/';
export const TITLE = 'windlass: a pipeline runner with no model inside it';

/**
 * The maker as one Person entity. Same @id and sameAs as agentjames publishes
 * (register R15/R17 there), so engines can join this site to that entity.
 */
export const AUTHOR = {
  '@type': 'Person',
  '@id': 'https://agentjames.vercel.app/#person',
  name: 'James Lorenz Santos',
  url: 'https://agentjames.vercel.app',
  sameAs: [
    'https://www.linkedin.com/in/james-lorenz-santos-720776251/',
    'https://github.com/jamessuuu',
    'https://www.onlinejobs.ph/jobseekers/info/2766463',
    'https://ph.jobstreet.com/profiles/jameslorenz-santos-SXdpKyGqdK',
  ],
};

/**
 * The one sentence that says what this is. Byte-identical in the page's meta
 * description, its JSON-LD, llms.txt, and the first line of README.md;
 * tests/site.test.mjs checks all four.
 */
export const CANONICAL_SENTENCE =
  'windlass runs pipelines as typed graphs with verifier edges and human gates, with no model inside the runner, and every run replays as one static HTML file.';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fail(msg) { throw new Error(`build-site: ${msg}`); }

// ---------------------------------------------------------------------------
// Sources. Each function returns exactly what the page will print, and
// tests/site.test.mjs re-implements each one independently.
// ---------------------------------------------------------------------------

/** Run the runner's selftest for real and read its own summary line. */
export function selftestCounts() {
  const r = spawnSync(process.execPath, [RUNNER, '--selftest'], { encoding: 'utf8', timeout: 120000, env: { ...process.env, CLAUDECODE: '' } });
  const m = (r.stdout || '').match(/selftest: (\d+)\/(\d+) passed/);
  if (!m) fail(`selftest printed no summary line (exit ${r.status}):\n${(r.stderr || r.stdout || '').slice(-600)}`);
  const passed = Number(m[1]), total = Number(m[2]);
  if (r.status !== 0 || passed !== total) fail(`selftest ${passed}/${total}, exit ${r.status}; the site will not publish a failing number`);
  return { passed, total };
}

/** node:test declarations per file, counted the way the suite runs them. */
export function testCounts() {
  const dir = join(ROOT, 'tests');
  const files = readdirSync(dir).filter((f) => /\.test\.mjs$/.test(f)).sort();
  const perFile = files.map((f) => ({ file: `tests/${f}`, count: (readFileSync(join(dir, f), 'utf8').match(/^test\(/gm) || []).length }));
  return { perFile, total: perFile.reduce((n, x) => n + x.count, 0) };
}

/** Facts of the committed demo run, read from the runner-owned files. */
export function demoFacts() {
  const replay = JSON.parse(readFileSync(join(DEMO_RUN_DIR, 'replay.json'), 'utf8'));
  const state = JSON.parse(readFileSync(join(DEMO_RUN_DIR, 'state.json'), 'utf8'));
  const events = readFileSync(join(DEMO_RUN_DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const { graph } = replay;
  const gates = graph.nodes.filter((n) => n.kind === 'gate');
  const answers = events.filter((e) => e.type === 'gate-answer');
  return {
    graphId: graph.id,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    gates: gates.length,
    gateId: gates[0]?.id ?? null,
    events: events.length,
    bumpAttempts: state.nodes.bump.attempts,
    activeMs: state.active_ms,
    usdTotal: state.usd_total,
    status: state.status,
    startedAt: state.started_at,
    answer: answers.length ? JSON.stringify(answers[0].answer) : null,
  };
}

/** Names of the token shapes runner.mjs redacts, parsed from its source. */
export function redactionShapes() {
  const src = readFileSync(RUNNER, 'utf8');
  const start = src.indexOf('const SECRET_PATTERNS = [');
  const end = src.indexOf('].map(', start);
  if (start < 0 || end < 0) fail('SECRET_PATTERNS block not found in src/runner.mjs');
  const block = src.slice(start, end);
  const names = [...block.matchAll(/^\s*\['([^']+)',/gm)].map((m) => m[1]);
  if (!names.length) fail('SECRET_PATTERNS parsed to zero names');
  return names;
}

export function packageFacts() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies ?? {}).length;
  const nodeMin = String(pkg.engines?.node ?? '').match(/(\d+)/)?.[1] ?? null;
  if (!nodeMin) fail('package.json engines.node has no version number');
  return { deps, nodeMin, version: pkg.version };
}

/** All test and selftest names, so the page can only quote real ones. */
export function knownTestTitles() {
  const titles = new Set();
  const dir = join(ROOT, 'tests');
  for (const f of readdirSync(dir).filter((x) => /\.test\.mjs$/.test(x))) {
    const text = readFileSync(join(dir, f), 'utf8');
    // test('single-line title') and test('a ' +\n 'b') joined by the author
    for (const m of text.matchAll(/^test\(\s*'((?:[^'\\]|\\.)*)'/gm)) titles.add(m[1]);
  }
  const selftest = readFileSync(RUNNER, 'utf8');
  for (const m of selftest.matchAll(/^\s*check\(\s*'((?:[^'\\]|\\.)*)'/gm)) titles.add(m[1]);
  for (const m of selftest.matchAll(/^\s*check\(\s*\n\s*'((?:[^'\\]|\\.)*)'/gm)) titles.add(m[1]);
  return titles;
}

// ---------------------------------------------------------------------------
// The replay: regenerate, gate, copy, excerpt.
// ---------------------------------------------------------------------------

export function regenerateReplay() {
  // Exactly the README's command. --title is not passed; the viewer's default
  // is what the committed artifact carries.
  const r = spawnSync(process.execPath, [CLI, 'view', DEMO_RUN_DIR, '--out', DEMO_REPLAY], { encoding: 'utf8', cwd: ROOT, timeout: 60000 });
  if (r.status !== 0) fail(`windlass view failed (exit ${r.status}):\n${r.stderr || r.stdout}`);
  copyFileSync(DEMO_REPLAY, SITE_REPLAY);
  const check = spawnSync(process.execPath, [VIEWER, '--check', SITE_REPLAY], { encoding: 'utf8', timeout: 60000 });
  if (check.status !== 0) fail(`the copied replay fails windlass view --check:\n${check.stdout}${check.stderr}`);
  return { bytes: statSync(SITE_REPLAY).size, kb: Math.round(statSync(SITE_REPLAY).size / 1024) };
}

/** Cut the three excerpts out of the rendered replay. Every anchor is asserted. */
export function replayExcerpts(html, gateId) {
  const meta = html.match(/<dl class="meta-head">[\s\S]*?<\/dl>\s*<p class="muted">[^<]*<\/p>/);
  if (!meta) fail('meta-head block not found in the replay');

  const nodesH2 = html.indexOf('<h2>Nodes (final status)</h2>');
  if (nodesH2 < 0) fail('"Nodes (final status)" heading not found in the replay');
  const nodes = html.slice(nodesH2).match(/<div class="tablewrap"><table>[\s\S]*?<\/table><\/div>/);
  if (!nodes) fail('nodes table not found in the replay');

  const gateOpen = `<details class="block" open><summary><span class="node-id"><code>${gateId}</code>`;
  const first = html.indexOf(gateOpen);
  if (first < 0) fail(`no timeline block for gate ${gateId}`);
  // The gate story ends where the next non-gate node's block begins.
  const after = html.indexOf('<details class="block" open>', html.indexOf('</details>', html.indexOf(gateOpen, first + 1)) + 1);
  if (after < 0) fail('could not find the block after the gate blocks');
  const gate = html.slice(first, after).trimEnd();
  if ((gate.match(/<details/g) || []).length !== 2 || !/control-halt/.test(gate) || !/control-answer/.test(gate) || !/control-resume/.test(gate)) {
    fail('gate excerpt does not contain two gate blocks plus the halt, answer and resume lines');
  }
  return { meta: meta[0], nodes: nodes[0], gate };
}

// ---------------------------------------------------------------------------
// Region replacement: <!-- gen:NAME -->...<!-- /gen:NAME -->
// ---------------------------------------------------------------------------

export function replaceRegion(html, name, inner) {
  const open = `<!-- gen:${name} -->`, close = `<!-- /gen:${name} -->`;
  const a = html.indexOf(open), b = html.indexOf(close);
  if (a < 0 || b < 0 || b < a) fail(`region ${name} missing from site/index.html`);
  if (html.indexOf(open, a + 1) >= 0) fail(`region ${name} appears more than once`);
  return html.slice(0, a + open.length) + inner + html.slice(b);
}

export function headHtml() {
  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: 'windlass', url: `${SITE_ORIGIN}/`, description: CANONICAL_SENTENCE, author: AUTHOR },
      {
        '@type': 'SoftwareApplication',
        name: 'windlass',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Node.js',
        description: CANONICAL_SENTENCE,
        url: `${SITE_ORIGIN}/`,
        license: 'https://opensource.org/license/mit',
        codeRepository: REPO_URL,
        author: AUTHOR,
      },
    ],
  };
  return [
    '',
    `<meta name="description" content="${esc(CANONICAL_SENTENCE)}">`,
    `<link rel="canonical" href="${SITE_ORIGIN}/">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${esc(TITLE)}">`,
    `<meta property="og:description" content="${esc(CANONICAL_SENTENCE)}">`,
    `<meta property="og:url" content="${SITE_ORIGIN}/">`,
    `<meta property="og:image" content="${SITE_ORIGIN}/og.png">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(TITLE)}">`,
    `<meta name="twitter:description" content="${esc(CANONICAL_SENTENCE)}">`,
    `<meta name="twitter:image" content="${SITE_ORIGIN}/og.png">`,
    `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>`,
    '',
  ].join('\n');
}

export function receiptsHtml(f) {
  const rows = [
    ['Selftest checks passed', `${f.selftest.passed} / ${f.selftest.total}`, 'src/runner.mjs, the selftest() function', 'npm run selftest'],
    ['Tests in the suite', `${f.tests.total} (${f.tests.perFile.map((x) => `${x.file.replace('tests/', '').replace('.test.mjs', '')} ${x.count}`).join(', ')})`, 'tests/*.test.mjs, one test() each', 'npm test'],
    ['Runtime dependencies', String(f.pkg.deps), 'package.json, "dependencies"', 'node -e "console.log(Object.keys(require(\'./package.json\').dependencies||{}).length)"'],
    ['Nodes and edges in the demo graph', `${f.demo.nodes} nodes, ${f.demo.edges} edges`, 'examples/demo/pipeline.graph.json', 'node bin/windlass.mjs validate examples/demo/pipeline.graph.json'],
    ['Human gates in the demo graph', String(f.demo.gates), 'examples/demo/pipeline.graph.json, nodes with kind "gate"', 'same as above'],
    ['Events recorded in the demo run', String(f.demo.events), 'examples/demo/.graph-runner/demo/events.jsonl, one line each', 'node bin/windlass.mjs replay examples/demo/pipeline.graph.json --run-id demo'],
    ['Attempts the bump node needed', String(f.demo.bumpAttempts), 'examples/demo/.graph-runner/demo/state.json, nodes.bump.attempts', 'same as above'],
    ['Active runner time', `${f.demo.activeMs} ms, excluding time paused at the gate`, 'state.json, active_ms', 'same as above'],
    ['Total cost', `$${f.demo.usdTotal}, measured (script nodes cost nothing)`, 'state.json, usd_total', 'same as above'],
    ['The answer the human gave', f.demo.answer ?? 'not recorded', 'events.jsonl, the gate-answer event', 'same as above'],
    ['Token shapes the redaction knows', String(f.shapes.length), 'src/runner.mjs, SECRET_PATTERNS', 'listed below'],
    ['Replay page', `${f.replay.kb} KB, one file, no script, no remote resource`, 'examples/demo-replay.html', 'node bin/windlass.mjs view examples/demo/.graph-runner/demo --out examples/demo-replay.html, then node src/viewer.mjs --check examples/demo-replay.html'],
  ];
  return [
    '',
    '  <div class="receipts-table"><table>',
    '    <colgroup><col class="c-what"><col class="c-value"><col class="c-artifact"><col class="c-how"></colgroup>',
    '    <thead><tr><th scope="col">What</th><th scope="col">Value</th><th scope="col">Artifact</th><th scope="col">Regenerate with</th></tr></thead>',
    '    <tbody>',
    ...rows.map(([what, value, artifact, how]) => `      <tr><th scope="row">${esc(what)}</th><td class="n">${esc(value)}</td><td><code>${esc(artifact)}</code></td><td><code>${esc(how)}</code></td></tr>`),
    '    </tbody>',
    '  </table></div>',
    '  ',
  ].join('\n');
}

export function shapesHtml(shapes) {
  return ['', '  <ol class="shapes">', ...shapes.map((s) => `    <li>${esc(s)}</li>`), '  </ol>', '  '].join('\n');
}

export function writeAuxFiles() {
  writeFileSync(join(SITE, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`);
  writeFileSync(join(SITE, 'sitemap.xml'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${SITE_ORIGIN}/</loc></url>`,
    '</urlset>',
    '',
  ].join('\n'));
  writeFileSync(join(SITE, 'llms.txt'), [
    '# windlass',
    '',
    `> ${CANONICAL_SENTENCE}`,
    '',
    'One page and one artifact. The page leads with what the runner refuses to do and names the test behind each refusal; the artifact is the rendered replay of a real run.',
    '',
    `- [The finding, the replay excerpt, and how to reproduce exit code 3](${SITE_ORIGIN}/)`,
    `- [Replay of the demo run, one static file](${SITE_ORIGIN}/demo-replay)`,
    `- [Source, tests and README](${REPO_URL})`,
    '',
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function build() {
  if (!existsSync(INDEX)) fail('site/index.html is missing; it is the template this script fills in');

  const selftest = selftestCounts();
  const tests = testCounts();
  const demo = demoFacts();
  const shapes = redactionShapes();
  const pkg = packageFacts();
  const replay = regenerateReplay();
  const facts = { selftest, tests, demo, shapes, pkg, replay };

  const len = CANONICAL_SENTENCE.length;
  if (len < 70 || len > 160) fail(`canonical sentence is ${len} chars; a meta description must be 70-160`);
  if (TITLE.length > 60) fail(`title is ${TITLE.length} chars; must be <= 60`);

  const replayHtml = readFileSync(SITE_REPLAY, 'utf8');
  const ex = replayExcerpts(replayHtml, demo.gateId);

  let html = readFileSync(INDEX, 'utf8');

  // Every test title the page quotes must be a real test or selftest check.
  const known = knownTestTitles();
  for (const m of html.matchAll(/<code class="t">([^<]+)<\/code>/g)) {
    const title = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    if (!known.has(title)) fail(`the page quotes a test that does not exist: "${title}"`);
  }

  html = replaceRegion(html, 'head', headHtml());
  html = replaceRegion(html, 'deps', String(pkg.deps));
  html = replaceRegion(html, 'shape-count', String(shapes.length));
  html = replaceRegion(html, 'bump-attempts', String(demo.bumpAttempts));
  html = replaceRegion(html, 'events', String(demo.events));
  html = replaceRegion(html, 'nodes', String(demo.nodes));
  html = replaceRegion(html, 'node-version', pkg.nodeMin);
  html = replaceRegion(html, 'replay-kb', String(replay.kb));
  html = replaceRegion(html, 'run-date', `<time datetime="${esc(demo.startedAt)}">${esc(demo.startedAt.slice(0, 10))}</time>`);
  html = replaceRegion(html, 'replay-meta', `\n    ${ex.meta}\n    `);
  html = replaceRegion(html, 'replay-nodes', `\n    ${ex.nodes}\n    `);
  html = replaceRegion(html, 'replay-gate', `\n    ${ex.gate}\n    `);
  html = replaceRegion(html, 'receipts', receiptsHtml(facts));
  html = replaceRegion(html, 'shapes', shapesHtml(shapes));

  writeFileSync(INDEX, html);
  writeAuxFiles();

  process.stdout.write(
    `build-site: selftest ${selftest.passed}/${selftest.total}, ${tests.total} tests, ` +
    `demo ${demo.nodes} nodes / ${demo.edges} edges / ${demo.events} events, ${shapes.length} token shapes, replay ${replay.kb} KB\n` +
    `            examples/demo-replay.html re-rendered and copied to site/; every number on the page regenerated from its source\n`,
  );
  return facts;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { build(); } catch (e) { console.error(e.message); process.exit(1); }
}
