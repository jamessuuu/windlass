# graph-runner — interface spec (v0.1, 2026-09-03)

The executable form of an attended pipeline. Today the ecosystem's pipelines
are prose graphs inside skills (nodes, gates, verifiers, caps written for a
model to follow). This runner makes the same graph a JSON artifact a program
executes: every edge is a command that can fail, every human gate is a real
stop, every run leaves a replayable record. It contains no model; agent
nodes are Claude Code headless calls it spawns and verifies.

Sibling of `loop-runner.mjs` (harness component 3): a `loop` node delegates
to it. Nothing here replaces the world guards or the permission floor.

## Design laws (each traces to evidence)

1. **Agent nodes exchange file paths, never free text.** An agent node's
   prompt names input artifacts by path and demands output artifacts by
   path; the runner never pastes one agent's output into another's context
   and never summarises. Hub nodes (fan-in points) are scripts. Source:
   "From Spark to Fire" (arXiv:2603.04474) — a fabricated fact at a hub node
   cascades to 100% failure in shared-state graphs, 9.7–15.9% from a leaf.
2. **Every edge is a command that can fail** (constitution law 10). An edge
   with no `verify` is a spec error, not a default-pass.
3. **Caps are declared before the run and enforced by the runner**, not the
   agent: wall-clock (≤ 240 min hard, counting ACTIVE runner time only — the
   time a run sits paused at a human gate is excluded, or the cap would
   answer the gate), attempts per node (default 2), USD per agent node and
   per run, `attended: true` required. A cap trip halts with exit 3 and a
   named reason; it never re-loops.
4. **Two halt classes are distinguished**: `stall` (identical failure
   signature twice) and `budget-while-working` (cap expired with the node
   still producing). Source: Long-Horizon-Terminal-Bench (arXiv:2607.08964),
   79% of unresolved runs die the second way.
5. **Runner-owned state on disk**, JSON (agents rewrite Markdown "helpfully";
   they do not get to edit state). Resume from state, never from chat.
6. **Replay is a first-class output**: an append-only `events.jsonl` that
   records every command, exit code, duration, cost, and artifact hash —
   and no artifact bodies, so a replay of a client engagement carries no
   client material.
7. **Human gates are real stops.** A gate node writes a request file and
   exits 3 (`paused`). The human answers with a small command; the next
   `--resume` continues. No timeout answers a gate.

## Layout

```
~/.claude/tools/graph-runner/
  SPEC.md
  graph-runner.mjs          run | validate | answer | resume | replay | --selftest
  schema.json               JSON schema for *.graph.json
  examples/
    echo/pipeline.graph.json  script-only fixture graph used by --selftest
    echo/prompts/...
```

Runtime: Node ≥ 22, ESM, no dependencies. Runs from a plain terminal (a
nested `claude -p` from inside a live Claude Code session has been observed
to time out; the runner refuses to start when `CLAUDECODE` is set unless
`--allow-nested` is passed, and says why).

## Graph file (`*.graph.json`)

```jsonc
{
  "id": "supabase-security-review",
  "version": 1,
  "cwd": ".",                                   // resolved against the graph file's directory
  "artifacts_dir": "docs/trial",
  "caps": {
    "attended": true,                           // required, must be true
    "max_wall_minutes": 240,                    // ≤ 240
    "max_attempts_per_node": 2,
    "max_usd_per_agent_node": 3,
    "max_usd_total": 20
  },
  "env_deny": ["SUPABASE_SERVICE_ROLE_KEY"],    // names the runner strips from every child env
  "nodes": [
    { "id": "G0", "kind": "script",
      "run": "node ~/.claude/tools/supabase-review/preflight.mjs --world . --json > docs/trial/PREFLIGHT.json",
      "produces": ["docs/trial/PREFLIGHT.json"], "timeout_minutes": 5 },
    // `~/` is expanded by the runner before the shell sees it (Windows never
    // does), so graphs stay portable between machines. `preflight --json`
    // prints to stdout: redirect it, or `produces` can never be satisfied.
    // Never write placeholders as <name>: angle brackets are shell redirects
    // on every platform; use REPLACE_WITH_… tokens.

    { "id": "N2", "kind": "agent",
      "agent": "supabase-rls-auditor",          // ~/.claude/agents/<name>.md → --append-system-prompt-file
      "model": "opus",
      "prompt_file": "prompts/N2-rank.md",      // may reference {{inputs}} / {{produces}} placeholders
      "inputs":   ["docs/trial/recon.json", "docs/trial/RECON.md", "docs/trial/SCOPE.md"],
      "produces": ["docs/trial/CANDIDATES.md"],
      "tools": "Read,Glob,Grep",                // --tools allowlist for the child
      "max_usd": 3, "timeout_minutes": 20 },

    { "id": "GATE1", "kind": "gate",
      "question": "Pick ONE candidate id from CANDIDATES.md",
      "reads": ["docs/trial/CANDIDATES.md"],
      "answer_schema": { "type": "object", "required": ["pick"], "properties": { "pick": { "type": "string" } } },
      "writes": "docs/trial/GATE1.json" },

    { "id": "N4", "kind": "script",
      "run": "node ~/.claude/tools/supabase-review/rig.mjs --repo repos/x --seed docs/trial/seed.json --probes docs/trial/probes --lint --out docs/trial/base",
      "produces": ["docs/trial/base/PROBE-RESULTS.md"],
      "on_fail": { "goto": "N3", "max": 2 } },  // bounded back-edge; counts toward max_attempts_per_node

    { "id": "N5", "kind": "loop",
      "config": "loops/patch.loop.json",        // handed to loop-runner.mjs verbatim
      "optional": true }
  ],
  "edges": [
    { "from": "G0",    "to": "N1",   "verify": "node -e \"process.exit(require('./docs/trial/PREFLIGHT.json').ok?0:1)\"" },
    { "from": "N2",    "to": "GATE1", "verify": "test -s docs/trial/CANDIDATES.md" },
    { "from": "GATE1", "to": "N3",   "verify": "node -e \"JSON.parse(require('fs').readFileSync('docs/trial/GATE1.json','utf8')).pick||process.exit(1)\"" }
  ]
}
```

Rules: node ids unique; the graph is a DAG plus bounded `on_fail` back-edges;
exactly one node has no incoming edge (the start); every edge has `verify`;
every `produces` path must exist after the node or the node FAILS; a `gate`
node's `writes` file is the only thing the runner accepts as its answer.

## Node kinds

| kind | executes | passes when |
|---|---|---|
| `script` | `run` via the shell, cwd = graph cwd, env minus `env_deny`, timeout | exit 0 AND every `produces` path exists and is non-empty |
| `agent` | `claude -p` headless: `--permission-mode auto`, `--restricted` (unless the node sets `restricted: false`; restricted mode strips shell/code tools and WebFetch unless named, confines file tools to cwd, refuses bypass — the harness's floor, same as loop-runner), `--tools <allowlist>` passed one tool per argument (`tools` is a comma-separated string in the graph; agent nodes normally need only `Read,Glob,Grep,Write,Edit` — hubs that must run commands are `script` nodes by design law 1), `--append-system-prompt-file <agent charter>`, `--max-budget-usd <max_usd>`, `--output-format json`, cwd = graph cwd; the prompt is `prompt_file` with `{{inputs}}`/`{{produces}}` expanded to paths | exit 0, every `produces` exists and is non-empty, cost ≤ cap |
| `gate` | writes `<writes>.request.json` (question, reads, schema) and halts (exit 3, state `paused`) | on `--resume`, the answer file exists and validates against `answer_schema` |
| `loop` | `node loop-runner.mjs --config <config>` | loop-runner exit 0 |

An `agent` node MUST NOT receive any other node's free-text output: the
runner rejects a prompt file that embeds a previous artifact's contents (it
scans for `{{cat …}}`-style directives and refuses them; only paths expand).

## Commands

```
node graph-runner.mjs validate <graph.json>              # schema + rules; exit 2 on error
node graph-runner.mjs run <graph.json> [--run-id <id>]   # start; exit 0 done · 3 paused/halted · 1 failed · 2 config
node graph-runner.mjs answer <graph.json> <GATE_ID> '<json>'   # writes the gate's answer file after schema check
node graph-runner.mjs resume <graph.json> --run-id <id>  # continue from state
node graph-runner.mjs replay <graph.json> --run-id <id> [--out replay.json]   # self-contained replay (no artifact bodies)
node graph-runner.mjs --selftest                         # examples/echo, zero model calls
```

## State and replay

`<cwd>/.graph-runner/<runId>/state.json` (runner-owned):

```jsonc
{ "graph_id": "...", "run_id": "...", "started_at": "...", "status": "running|paused|halted|done|failed",
  "halt_reason": null | "stall" | "budget-while-working" | "cap:attempts" | "cap:wall" | "cap:usd" | "gate",
  "current": "N2",
  "nodes": { "G0": { "status": "done", "attempts": 1, "exit": 0, "ms": 812, "usd": 0, "produced": { "docs/trial/PREFLIGHT.json": "sha256:…" } },
             "N2": { "status": "running", "attempts": 1 } },
  "usd_total": 0.0 }
```

`events.jsonl`: one line per event — `node-start`, `command`, `exit`,
`verify`, `produce`, `gate-request`, `gate-answer`, `halt`, `resume` — each
with timestamp, node id, command text (secrets-redacted by the same
concat-built patterns the secret-leak guard uses), exit code, duration, cost,
artifact hashes. Never artifact bodies.

`replay.json` = state + events + the graph, with paths relative to cwd. It
is the input for the replay viewer (project S2); a replay of a client
engagement is publishable only because it carries hashes, not content — and
even then only with the client's written permission.

## Halting, resuming, caps

- A node failing its verifier or `produces` check retries up to
  `max_attempts_per_node`; two identical failure signatures (exit code +
  last 200 chars of stderr) halt as `stall` before the cap.
- `on_fail.goto` back-edges count toward the target node's attempts.
- Wall-clock and USD caps are checked before every node and every agent
  spawn; a cap that trips while a node is producing halts as
  `budget-while-working`.
- `resume` re-validates the graph hash; a changed graph refuses to resume
  (start a new run).
- Exit 3 for every halt and pause; the reason is printed and in state.

## Selftest (`examples/echo`)

Script-only graph, zero model calls: a start node that writes a file; an edge
whose verifier fails on the first pass and passes on the second (the node's
`on_fail` back-edge fires once); a gate that pauses (exit 3) and is answered
by the selftest via `answer`; a resume that completes; a cap trip staged by a
node that sleeps past its `timeout_minutes` twice with an identical failure
signature, which halts as `stall` (stall detection runs before the attempts
cap); a `replay` export with no artifact bodies
and every hash matching the file on disk. Negative controls: a graph with an
edge lacking `verify` fails `validate`; a prompt file embedding artifact
contents is refused; `attended: false` is refused; a graph reached from
inside `CLAUDECODE` without `--allow-nested` is refused with the reason.

## What "done" means for the builder

- `--selftest` green with every case above; `validate` rejects the three
  negative controls; no network; no dependencies; Windows paths handled.
- The Supabase-review graph (`skills/supabase-security-review/pipeline.graph.json`,
  written in Wave 1) validates and runs on the fixture to GATE1 from a plain
  terminal.
