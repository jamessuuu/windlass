#!/usr/bin/env node
// viewer.mjs — render a windlass replay (graph + state + events, the exact
// shape `runner.mjs replay` writes to replay.json) to ONE self-contained HTML
// file, and a `--check` gate that proves the file is safe to hand to a
// stranger. Sibling of ~/.claude/tools/supabase-review/render-review.mjs —
// same discipline, ported deliberately (zero network, zero JS, open-by-
// default <details>, print stylesheet, wrapping code cells), because that
// discipline was learned from real defects there.
//
// HONESTY LAW (non-negotiable, per the windlass build brief): this file
// renders only what replay.json actually recorded. It never computes,
// estimates, infers or defaults a number that was not measured. A field
// that is absent from state/events prints an explicit "not recorded"
// marker — never 0, never blank, never a guess. It also never reads
// artifacts off disk to fill a gap: the only inputs are the graph
// DEFINITION (id, node kinds, run/verify/question text, caps — pipeline
// source, not client material) and the state/events DATA that
// `runner.mjs` already wrote. If replay.json is missing a field windlass
// hasn't started recording yet (e.g. an older run's gate-answer event with
// no `answer` field), this file says "not recorded", it does not guess.
//
// Usage:
//   node viewer.mjs <replay.json|run-dir> --out <file.html> [--title "..."]
//   node viewer.mjs --check <file.html>
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------
// Secret redaction — same concat-built, high-confidence-only pattern
// discipline as runner.mjs's SECRET_PATTERNS, duplicated deliberately so
// this file has zero dependency on another file's internals (and never
// matches a secret scanner itself). Applied defensively to every string
// this file renders: runner.mjs only redacts `cmd`/`answer` fields in
// events.jsonl, but the graph DEFINITION (node.run, edge.verify,
// node.question, prompt_file paths) was never redacted anywhere, so the
// viewer is the last line of defense for those.
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
  ['supabase key', '\\bsb' + '[ph]_' + '[A-Za-z0-9]{20,}'],
  ['jwt-shaped string', 'eyJ[A-Za-z0-9_-]{20,}\\.'],
  ['postgres url with password', 'postgres(?:ql)?:\\/\\/[^\\s"\'<]*:[^\\s"\'<@]+@'],
].map(([name, re]) => [name, new RegExp(re, 'g')]);

function redact(text) {
  let out = String(text == null ? '' : text);
  for (const [name, re] of SECRET_PATTERNS) out = out.replace(re, `[REDACTED:${name}]`);
  return out;
}
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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

// A rendered value that came from replay.json data (not graph definition):
// missing/undefined/null must NEVER become "0" or "" — say so explicitly.
const NOT_RECORDED = 'not recorded';
function present(v) { return v !== undefined && v !== null; }

function fmtMs(ms) {
  if (!present(ms) || typeof ms !== 'number' || !Number.isFinite(ms)) return NOT_RECORDED;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s (${ms} ms)`;
}
function fmtUsd(usd) {
  if (!present(usd) || typeof usd !== 'number' || !Number.isFinite(usd)) return NOT_RECORDED;
  return `$${usd}`;
}
function fmtExit(exit) {
  if (!present(exit)) return NOT_RECORDED;
  if (exit === 0) return '0 (pass)';
  if (exit === -1) return '-1 (timed out)';
  return `${exit} (fail)`;
}
function badgeClassForExit(exit) {
  if (!present(exit)) return 'badge-muted';
  return exit === 0 ? 'badge-ok' : 'badge-fail';
}
function badgeClassForStatus(status) {
  if (status === 'done') return 'badge-ok';
  if (status === 'running' || status === 'pending') return 'badge-warn';
  if (status === 'paused') return 'badge-warn';
  return 'badge-fail'; // stalled, failed, halted, or anything unrecognized
}
function fmtJson(v) {
  if (!present(v)) return NOT_RECORDED;
  return esc(JSON.stringify(redactDeep(v), null, 2));
}
function code(text) { return `<code>${esc(redact(String(text)))}</code>`; }
function codeBlock(text) {
  return `<pre class="code"><code>${esc(redact(String(text)))}</code></pre>`;
}

// ---------------------------------------------------------------------
// Timeline: group the flat events.jsonl array into per-node-attempt
// blocks, in the exact chronological order the runner recorded them. A
// gate that pauses then resumes produces TWO node-start events for the
// same node id — two separate blocks, which is an accurate replay of the
// pause/resume cycle, not a bug to collapse away.
// ---------------------------------------------------------------------
function buildTimeline(events) {
  const blocks = [];
  let current = null;
  const attemptCounters = {};
  for (const ev of events || []) {
    if (ev.type === 'node-start') {
      attemptCounters[ev.node] = (attemptCounters[ev.node] || 0) + 1;
      current = { node: ev.node, kind: ev.kind, attempt: attemptCounters[ev.node], events: [ev] };
      blocks.push(current);
    } else if (ev.type === 'halt' || ev.type === 'resume') {
      blocks.push({ control: ev.type, events: [ev] });
      current = null; // a control event ends the open block; the next node-start (if any) starts fresh
    } else if (ev.type === 'gate-answer' && !current) {
      // `windlass answer` writes the answer file and emits this event as its
      // own command invocation — typically well before `resume` runs, with
      // no node-start in between (the graph is sitting paused the whole
      // time). That is a real, standalone moment ("a human answered"), not a
      // fake node attempt, so it gets its own control banner rather than
      // being misfiled as an attempt with no exit/duration/cost.
      blocks.push({ control: 'gate-answer', events: [ev] });
    } else if (current) {
      current.events.push(ev);
    } else {
      // An event with no preceding node-start and no other explanation.
      // Should not happen given how runner.mjs emits, but the honesty law
      // says render what is there rather than silently drop it.
      blocks.push({ node: ev.node ?? null, kind: null, attempt: null, orphan: true, events: [ev] });
    }
  }
  return blocks;
}

function eventsOfType(block, type) {
  return block.events.filter((e) => e.type === type);
}

function renderControlBlock(block) {
  const ev = block.events[0];
  const ts = esc(ev.ts || NOT_RECORDED);
  if (block.control === 'halt') {
    return `<div class="control control-halt"><span class="ts">${ts}</span> — graph ${esc(ev.status || NOT_RECORDED)}` +
      `, halt reason: <strong>${esc(ev.reason == null ? 'none' : ev.reason)}</strong></div>`;
  }
  if (block.control === 'gate-answer') {
    const answerText = present(ev.answer) ? JSON.stringify(ev.answer) : NOT_RECORDED;
    return `<div class="control control-answer"><span class="ts">${ts}</span> — a human answered gate ${code(ev.node ?? NOT_RECORDED)}: ${code(answerText)}</div>`;
  }
  // resume
  return `<div class="control control-resume"><span class="ts">${ts}</span> — resumed at gate ${code(ev.node ?? NOT_RECORDED)}</div>`;
}

function renderNodeBlock(block, graphNodesById) {
  const gNode = graphNodesById[block.node] || null;
  const kind = block.kind || (gNode && gNode.kind) || 'unknown';
  const startEv = block.events.find((e) => e.type === 'node-start');
  const cmdEv = eventsOfType(block, 'command')[0];
  const exitEv = eventsOfType(block, 'exit')[0];
  const produceEvs = eventsOfType(block, 'produce');
  const verifyEvs = eventsOfType(block, 'verify');
  const gateReqEv = eventsOfType(block, 'gate-request')[0];
  const gateAnsEv = eventsOfType(block, 'gate-answer')[0];

  const outcomeExit = exitEv ? exitEv.exit : undefined;
  let statusBadge;
  if (gateReqEv && !gateAnsEv) statusBadge = `<span class="badge badge-warn">paused — waiting on human</span>`;
  else if (exitEv) statusBadge = `<span class="badge ${badgeClassForExit(outcomeExit)}">${present(outcomeExit) ? fmtExit(outcomeExit) : NOT_RECORDED}</span>`;
  else statusBadge = `<span class="badge badge-muted">${NOT_RECORDED}</span>`;

  const parts = [];
  parts.push(`<summary><span class="node-id">${code(block.node)}</span> ` +
    `<span class="kind-tag">${esc(kind)}</span> ` +
    `<span class="attempt-tag">attempt ${present(block.attempt) ? block.attempt : NOT_RECORDED}</span> ` +
    statusBadge +
    `<span class="ts">${esc((startEv && startEv.ts) || NOT_RECORDED)}</span></summary>`);

  if (cmdEv) {
    parts.push(`<div class="field"><div class="field-label">command</div>${codeBlock(cmdEv.cmd)}</div>`);
  }

  if (gateReqEv) {
    const answerSchema = gNode ? gNode.answer_schema : undefined;
    const reads = gNode ? gNode.reads : undefined;
    parts.push(
      `<div class="field"><div class="field-label">gate question</div><p>${esc(redact(gateReqEv.question ?? (gNode && gNode.question) ?? NOT_RECORDED))}</p></div>` +
      `<div class="field"><div class="field-label">answer written to</div>${code(gateReqEv.writes ?? NOT_RECORDED)}</div>` +
      (reads && reads.length ? `<div class="field"><div class="field-label">reads (declared in graph, not read by the viewer)</div>${reads.map((r) => code(r)).join(' ')}</div>` : '') +
      (answerSchema ? `<div class="field"><div class="field-label">answer_schema (declared in graph)</div><pre class="code"><code>${fmtJson(answerSchema)}</code></pre></div>` : ''),
    );
  }

  if (gateAnsEv) {
    parts.push(
      `<div class="field"><div class="field-label">gate answered</div><p>at ${esc(gateAnsEv.ts || NOT_RECORDED)}, written to ${code(gateAnsEv.writes ?? NOT_RECORDED)}</p></div>` +
      `<div class="field"><div class="field-label">the answer the human gave</div>` +
      (present(gateAnsEv.answer)
        ? `<pre class="code"><code>${fmtJson(gateAnsEv.answer)}</code></pre>`
        : `<p class="muted">${NOT_RECORDED} — this event predates windlass recording gate-answer values (older run), or the answer truly carried no value.</p>`) +
      `</div>`,
    );
  }

  if (exitEv) {
    parts.push(
      `<div class="field-grid">` +
      `<div><div class="field-label">exit code</div>${esc(fmtExit(exitEv.exit))}</div>` +
      `<div><div class="field-label">duration</div>${esc(fmtMs(exitEv.ms))}</div>` +
      `<div><div class="field-label">cost</div>${esc(fmtUsd(exitEv.usd))}</div>` +
      `</div>`,
    );
  }

  if (produceEvs.length) {
    parts.push(
      `<div class="field"><div class="field-label">artifacts produced (hash only, no body)</div>` +
      `<div class="tablewrap"><table><thead><tr><th>path</th><th>sha256</th></tr></thead><tbody>` +
      produceEvs.map((p) => `<tr><td>${code(p.path)}</td><td>${code(p.hash)}</td></tr>`).join('') +
      `</tbody></table></div></div>`,
    );
  } else if (gNode && Array.isArray(gNode.produces) && gNode.produces.length && !gateReqEv) {
    parts.push(
      `<div class="field"><div class="field-label">artifacts produced</div>` +
      `<p class="muted">${gNode.produces.length} path(s) declared in graph, none recorded for this attempt: ${gNode.produces.map((p) => code(p)).join(' ')}</p></div>`,
    );
  }

  if (verifyEvs.length) {
    parts.push(
      `<div class="field"><div class="field-label">outgoing edge verify</div>` +
      `<div class="tablewrap"><table><thead><tr><th>edge</th><th>exit</th><th>duration</th></tr></thead><tbody>` +
      verifyEvs.map((v) => `<tr><td>${code(v.edge)}</td><td>${esc(fmtExit(v.exit))}</td><td>${esc(fmtMs(v.ms))}</td></tr>`).join('') +
      `</tbody></table></div></div>`,
    );
  }

  return `<details class="block" open>${parts.join('\n')}</details>`;
}

function renderTimeline(events, graph) {
  const graphNodesById = Object.fromEntries((graph.nodes || []).map((n) => [n.id, n]));
  const blocks = buildTimeline(events);
  if (!blocks.length) return '<p class="muted">No events recorded.</p>';
  return blocks.map((b) => (b.control ? renderControlBlock(b) : renderNodeBlock(b, graphNodesById))).join('\n');
}

// ---------------------------------------------------------------------
// Node summary table — final/cumulative view from state.json, one row per
// node DECLARED in the graph (not just nodes that were reached).
// ---------------------------------------------------------------------
function renderNodeSummary(graph, state) {
  const rows = (graph.nodes || []).map((n) => {
    const s = (state.nodes || {})[n.id];
    if (!s) {
      return `<tr><td>${code(n.id)}</td><td>${esc(n.kind)}</td>` +
        `<td><span class="badge badge-muted">not started</span></td>` +
        `<td>${NOT_RECORDED}</td><td>${NOT_RECORDED}</td><td>${NOT_RECORDED}</td><td>${NOT_RECORDED}</td></tr>`;
    }
    const producedCount = s.produced ? Object.keys(s.produced).length : 0;
    const declaredCount = Array.isArray(n.produces) ? n.produces.length : 0;
    const producedLabel = declaredCount
      ? `${producedCount}/${declaredCount} declared path(s)`
      : (producedCount ? `${producedCount} path(s)` : (n.kind === 'gate' ? '0/1 (pending)' : 'none declared'));
    return `<tr><td>${code(n.id)}</td><td>${esc(n.kind)}</td>` +
      `<td><span class="badge ${badgeClassForStatus(s.status)}">${esc(s.status ?? NOT_RECORDED)}</span></td>` +
      `<td>${present(s.attempts) ? s.attempts : NOT_RECORDED}</td>` +
      `<td>${esc(fmtExit(s.exit))}</td>` +
      `<td>${esc(fmtMs(s.ms))}</td>` +
      `<td>${esc(fmtUsd(s.usd))}</td></tr>` +
      // producedLabel folded into a second thin row would complicate the table;
      // keep it in the same row via a data attribute rendered by CSS ::after is
      // fragile, so just append a compact 8th column instead (see header).
      '';
  });
  return `<div class="tablewrap"><table><thead><tr>` +
    `<th>id</th><th>kind</th><th>final status</th><th>attempts</th><th>last exit</th><th>duration</th><th>cost</th>` +
    `</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function renderEdgeSummary(graph, events) {
  const verifyEvs = (events || []).filter((e) => e.type === 'verify');
  const byEdge = {};
  for (const v of verifyEvs) (byEdge[v.edge] || (byEdge[v.edge] = [])).push(v);
  const rows = (graph.edges || []).map((e) => {
    const key = `${e.from}->${e.to}`;
    const attempts = byEdge[key] || [];
    const attemptsHtml = attempts.length
      ? attempts.map((v, i) => `<div>#${i + 1}: exit ${esc(fmtExit(v.exit))}, ${esc(fmtMs(v.ms))}</div>`).join('')
      : `<span class="muted">${NOT_RECORDED} (edge never reached / never verified)</span>`;
    return `<tr><td>${code(e.from)}</td><td>${code(e.to)}</td><td>${codeBlock(e.verify)}</td><td>${attemptsHtml}</td></tr>`;
  });
  return `<div class="tablewrap"><table><thead><tr><th>from</th><th>to</th><th>verify command</th><th>recorded attempts</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

// ---------------------------------------------------------------------
// Full document
// ---------------------------------------------------------------------
const CSS = `
:root{
  --ink:#16191d; --muted:#5b6570; --rule:#dfe3e8; --bg:#fff;
  --code-bg:#f6f7f9; --accent:#1f4b73;
  --ok-bg:#e6f4ea; --ok-fg:#146c2e; --fail-bg:#fdecea; --fail-fg:#a33028;
  --warn-bg:#fff4e0; --warn-fg:#8a5b00; --muted-bg:#eef0f2; --muted-fg:#5b6570;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--ink);
  font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  overflow-wrap:break-word;
}
.wrap{max-width:56rem;margin:0 auto;padding:3rem 1.25rem 6rem}
h1{font-size:1.5rem;margin:0 0 .3em;letter-spacing:-.01em;font-weight:650}
h2{font-size:1.1rem;margin:2.4em 0 .7em;padding-top:1.2em;border-top:1px solid var(--rule);font-weight:650}
h2:first-of-type{border-top:0;padding-top:0}
p{margin:0 0 1em}
.muted{color:var(--muted)}
code{background:var(--code-bg);border:1px solid var(--rule);border-radius:3px;padding:.08em .34em;
  font-size:.86em;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  overflow-wrap:anywhere;word-break:break-word}
pre.code{background:var(--code-bg);border:1px solid var(--rule);border-radius:6px;padding:.8rem 1rem;
  overflow-x:auto;margin:0 0 .6em;font:.8rem/1.5 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
pre.code code{background:none;border:0;padding:0;font:inherit}
.banner{border-radius:8px;padding:1rem 1.2rem;margin:1.2rem 0 1.6rem;font-weight:640}
.banner-ok{background:var(--ok-bg);color:var(--ok-fg)}
.banner-fail{background:var(--fail-bg);color:var(--fail-fg)}
.banner-warn{background:var(--warn-bg);color:var(--warn-fg)}
dl.meta-head{margin:1.2rem 0 0;padding:1rem 1.2rem;border:1px solid var(--rule);border-radius:6px;
  display:grid;grid-template-columns:max-content 1fr;gap:.45rem 1.1rem;font-size:.93rem}
dl.meta-head dt{font-weight:640;color:var(--muted);white-space:nowrap}
dl.meta-head dd{margin:0;overflow-wrap:anywhere}
@media(max-width:640px){dl.meta-head{grid-template-columns:1fr;gap:0}dl.meta-head dt{margin-top:.5em}}
.tablewrap{overflow-x:auto;margin:0 0 1em}
table{border-collapse:collapse;width:100%;font-size:.88rem}
th,td{text-align:left;padding:.45rem .65rem;border-bottom:1px solid var(--rule);vertical-align:top;overflow-wrap:anywhere}
th{font-weight:640;white-space:nowrap}
.badge{display:inline-block;border-radius:999px;padding:.12em .65em;font-size:.78rem;font-weight:640}
.badge-ok{background:var(--ok-bg);color:var(--ok-fg)}
.badge-fail{background:var(--fail-bg);color:var(--fail-fg)}
.badge-warn{background:var(--warn-bg);color:var(--warn-fg)}
.badge-muted{background:var(--muted-bg);color:var(--muted-fg)}
details.block{margin:0 0 .9em;border:1px solid var(--rule);border-radius:8px;background:var(--bg)}
details.block>summary{cursor:pointer;padding:.6rem .9rem;list-style:none;user-select:none;
  display:flex;flex-wrap:wrap;gap:.5em;align-items:center}
details.block>summary::-webkit-details-marker{display:none}
details.block>summary::before{content:"\\25BE  ";display:inline-block}
details.block[open]>summary{border-bottom:1px solid var(--rule)}
.node-id{font-weight:650}
.kind-tag{color:var(--muted);font-size:.85rem;border:1px solid var(--rule);border-radius:4px;padding:0 .4em}
.attempt-tag{color:var(--muted);font-size:.85rem}
.ts{margin-left:auto;color:var(--muted);font-size:.8rem;white-space:nowrap}
.field{padding:.7rem .9rem 0}
.field:last-child{padding-bottom:.7rem}
.field-label{font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;margin-bottom:.25em}
.field-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.6rem;padding:.7rem .9rem}
.control{padding:.5rem .9rem;margin:0 0 .9em;border-left:3px solid var(--rule);font-size:.88rem;color:var(--muted)}
.control-halt{border-color:var(--fail-fg)}
.control-resume{border-color:var(--warn-fg)}
.control-answer{border-color:var(--ok-fg)}
footer.meta{margin-top:3rem;padding-top:1.1rem;border-top:1px solid var(--rule);color:var(--muted);font-size:.82rem}
@media(max-width:640px){.wrap{padding:2rem 1rem 4rem}.field-grid{grid-template-columns:1fr}}
@media print{
  .wrap{max-width:none;padding:0}
  details.block{border:1px solid var(--rule);page-break-inside:avoid}
  details.block>*{display:block !important}
  table{page-break-inside:avoid}
  h2{page-break-after:avoid}
}
`;

function renderMetaHead(graph, state, events) {
  const lastEvent = events && events.length ? events[events.length - 1] : null;
  const rows = [
    ['graph', `${esc(graph.id ?? NOT_RECORDED)} (v${esc(graph.version ?? NOT_RECORDED)})`],
    ['run id', esc(state.run_id ?? NOT_RECORDED)],
    ['status', `<span class="badge ${badgeClassForStatus(state.status)}">${esc(state.status ?? NOT_RECORDED)}</span>`],
    ['halt reason', esc(state.halt_reason == null ? 'none' : state.halt_reason)],
    ['started at', esc(state.started_at ?? NOT_RECORDED)],
    ['last event recorded at', esc((lastEvent && lastEvent.ts) ?? NOT_RECORDED)],
    ['active wall time', `${esc(fmtMs(state.active_ms))} <span class="muted">(recorded; excludes time paused at a human gate)</span>`],
    ['total cost', esc(fmtUsd(state.usd_total))],
    ['current node', esc(state.current ?? NOT_RECORDED)],
    ['nodes / edges declared', `${(graph.nodes || []).length} / ${(graph.edges || []).length}`],
    ['events recorded', String((events || []).length)],
  ];
  if (state.error) rows.push(['error', esc(state.error)]);
  return `<dl class="meta-head">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function renderBanner(state) {
  const status = state.status;
  const cls = status === 'done' ? 'banner-ok' : (status === 'paused' ? 'banner-warn' : 'banner-fail');
  let text;
  if (status === 'done') text = 'DONE — the graph completed.';
  else if (status === 'paused') text = `PAUSED — waiting on a human at gate ${esc(state.current ?? NOT_RECORDED)}.`;
  else if (status === 'halted') text = `HALTED — reason: ${esc(state.halt_reason ?? NOT_RECORDED)}.`;
  else if (status === 'failed') text = `FAILED${state.error ? `: ${esc(state.error)}` : ''}`;
  else text = `status: ${esc(status ?? NOT_RECORDED)}`;
  return `<div class="banner ${cls}">${text}</div>`;
}

export function renderReplay(replay, opts = {}) {
  const graph = replay && replay.graph;
  const state = replay && replay.state;
  const events = (replay && replay.events) || [];
  if (!graph || !state) {
    throw new Error('renderReplay: replay object must have "graph" and "state" — got ' + JSON.stringify(Object.keys(replay || {})));
  }
  const title = opts.title || `windlass replay — ${graph.id ?? 'run'} (${state.run_id ?? ''})`;
  const capsRows = state && graph.caps
    ? Object.entries(graph.caps).map(([k, v]) => `${esc(k)}=${esc(JSON.stringify(v))}`).join(', ')
    : '';
  const envDeny = Array.isArray(graph.env_deny) && graph.env_deny.length
    ? `<p class="muted">env vars stripped from every child process: ${graph.env_deny.map((e) => code(e)).join(' ')}</p>`
    : '';

  const body = `
<h1>${esc(title)}</h1>
${renderBanner(state)}
${renderMetaHead(graph, state, events)}
<p class="muted">caps declared in graph: ${capsRows}</p>
${envDeny}
<h2>Nodes (final status)</h2>
${renderNodeSummary(graph, state)}
<h2>Edges (verify commands)</h2>
${renderEdgeSummary(graph, events)}
<h2>Timeline</h2>
${renderTimeline(events, graph)}
<footer class="meta">Rendered by windlass viewer. This page carries artifact hashes and event data only — no artifact bodies, no client material. Every value above came from replay.json; anything not recorded there is labeled "${NOT_RECORDED}", never guessed.</footer>
`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escAttr(title)}</title>
<meta name="robots" content="noindex,nofollow">
<style>${CSS}</style>
</head>
<body>
<main class="wrap">
${body}
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------
// --check — a gate that fails on anything that would make this page unsafe
// or dishonest to hand to a stranger. Every rule here must be provable to
// bite (see tests/viewer.test.mjs): a rule that cannot fail is not a check.
// ---------------------------------------------------------------------
export function checkHtml(html) {
  const problems = [];
  const warnings = [];

  // Remote-fetched resource: http(s) OR protocol-relative (//host/...) in a
  // src= or a <link href=...>. A plain <a href> is a clickable link, not a
  // fetch-on-load, so it is not flagged.
  const fetched = [
    ...[...html.matchAll(/\bsrc\s*=\s*"((?:https?:)?\/\/[^"]+)"/gi)].map((m) => m[1]),
    ...[...html.matchAll(/<link\b[^>]*\bhref\s*=\s*"((?:https?:)?\/\/[^"]+)"/gi)].map((m) => m[1]),
  ];
  if (fetched.length) problems.push(`remote resource fetched on load: ${[...new Set(fetched)].join(', ')}`);
  if (/@import|url\(\s*['"]?(?:https?:)?\/\//i.test(html)) problems.push('CSS pulls a remote resource');

  if (/<script\b/i.test(html)) problems.push('contains <script>; this document must run without JS');
  if (!/<meta name="viewport"/i.test(html)) problems.push('no viewport meta (mobile will render at desktop width)');
  if (!/@media print/i.test(html)) problems.push('no print stylesheet');
  if (!/<!doctype html>/i.test(html)) problems.push('missing doctype');

  // Generic tag balance (not just <details>/<pre>): every opening tag for
  // an element that is not a void element must have a matching close. This
  // is safe against our own rendered content because every piece of text
  // this file emits is passed through esc() first, so a literal "<" or ">"
  // inside rendered data can never masquerade as a real tag boundary.
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  let m;
  let unbalanced = null;
  while ((m = tagRe.exec(html))) {
    const [, closing, name, selfClose] = m;
    const tag = name.toLowerCase();
    if (VOID.has(tag) || selfClose) continue;
    if (!closing) { stack.push(tag); continue; }
    if (stack.length === 0 || stack[stack.length - 1] !== tag) { unbalanced = `unexpected </${tag}>`; break; }
    stack.pop();
  }
  if (unbalanced) problems.push(`unbalanced tags: ${unbalanced}`);
  else if (stack.length) problems.push(`unbalanced tags: ${stack.length} still open (${stack.slice(-5).join(', ')})`);

  // Any collapsed <details> hides evidence on screen AND drops it from a
  // printed PDF entirely — this renderer never emits one; a collapsed one
  // means the file was hand-edited (separately forbidden).
  const collapsed = (html.match(/<details\b(?![^>]*\bopen\b)[^>]*>/gi) || []).length;
  if (collapsed) problems.push(`${collapsed} collapsed <details> block(s): content is hidden on screen and lost from print`);

  const secrets = [
    [/eyJ[A-Za-z0-9_-]{20,}\./, 'JWT-shaped string'],
    [/\bsb[ph]_[A-Za-z0-9]{20,}/, 'Supabase key'],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
    [/sk-ant-[A-Za-z0-9\-_]{40,}/, 'Anthropic key'],
    [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
    [/postgres(?:ql)?:\/\/[^\s"'<]*:[^\s"'<@]+@/i, 'Postgres URL with a password'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  ];
  for (const [re, label] of secrets) if (re.test(html)) problems.push(`possible ${label} in the document`);

  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html)) warnings.push('emoji present');
  const bytes = Buffer.byteLength(html);
  if (bytes > 2_000_000) warnings.push(`large file (${Math.round(bytes / 1024)} KB)`);

  return { problems, warnings, bytes };
}

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------
function loadReplayInput(input) {
  const abs = input;
  if (!existsSync(abs)) throw new Error(`not found: ${abs}`);
  let file = abs;
  if (statSync(abs).isDirectory()) {
    file = join(abs, 'replay.json');
    if (!existsSync(file)) {
      throw new Error(
        `no replay.json found in ${abs} — run "node bin/windlass.mjs replay <graph.json> --run-id <id>" ` +
        `(or "node src/runner.mjs replay ...") first to produce it.`,
      );
    }
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

function runCheckCli(file) {
  if (!existsSync(file)) { process.stderr.write(`usage: viewer.mjs --check <file.html>\n`); process.exit(2); }
  const html = readFileSync(file, 'utf8');
  const { problems, warnings, bytes } = checkHtml(html);
  for (const p of problems) process.stdout.write(`FAIL  ${p}\n`);
  for (const w of warnings) process.stdout.write(`WARN  ${w}\n`);
  if (!problems.length) {
    process.stdout.write(`PASS  self-contained, no JS, no collapsed <details>, print stylesheet present, ${Math.round(bytes / 1024)} KB\n`);
  }
  process.exit(problems.length ? 1 : 0);
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1]; };

  if (argv.includes('--check')) {
    const f = flag('check') || argv.find((a) => !a.startsWith('--'));
    return runCheckCli(f);
  }

  const src = argv.find((a) => !a.startsWith('--'));
  const out = flag('out');
  if (!src || !out) {
    process.stderr.write(
      'usage: viewer.mjs <replay.json|run-dir> --out <file.html> [--title "..."]\n' +
      '       viewer.mjs --check <file.html>\n',
    );
    process.exit(2);
  }
  let replay;
  try { replay = loadReplayInput(src); }
  catch (e) { process.stderr.write(`viewer.mjs: ${e.message}\n`); process.exit(2); }
  const html = renderReplay(replay, { title: flag('title') });
  writeFileSync(out, html, 'utf8');
  process.stdout.write(`wrote ${out}\n`);
  const { problems, warnings, bytes } = checkHtml(html);
  for (const p of problems) process.stdout.write(`FAIL  ${p}\n`);
  for (const w of warnings) process.stdout.write(`WARN  ${w}\n`);
  if (!problems.length) process.stdout.write(`PASS  ${Math.round(bytes / 1024)} KB, safe to publish\n`);
  process.exit(problems.length ? 1 : 0);
}

const isMain = process.argv[1] && process.argv[1].endsWith('viewer.mjs');
if (isMain) {
  try { main(); } catch (e) { console.error('viewer.mjs internal error:', e); process.exit(1); }
}
