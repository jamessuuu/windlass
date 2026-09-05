# windlass

Pipelines as typed graphs with verifier edges and human gates, run by a
runner with no model inside it. Every run is replayable in a browser as one
static HTML file.

A windlass graph is a `*.graph.json` file: a small set of nodes (script,
agent, gate, loop) connected by edges. Every edge names a `verify` command
that has to exit 0 before the run advances. A `gate` node is a real stop: it
writes a question to disk and halts until a human answers it. The runner
executes the graph, writes an append-only event log as it goes, and never
calls a model itself, agent nodes spawn a headless `claude -p` and the
runner checks what came back the same way it checks a script's exit code.

## Why it is built this way

Each design choice traces to a documented failure mode, not a preference.

1. **Agent nodes exchange file paths, never free text.** An agent node's
   prompt names input artifacts by path and demands output artifacts by
   path. The runner never pastes one agent's output into another's context
   and never summarizes it. A prompt file that tries to embed a prior
   artifact's contents is refused at `validate`. Source: "From Spark to
   Fire" (arXiv:2603.04474) found that a fabricated fact at a hub node
   cascades to 100% failure in shared-state graphs, versus 9.7-15.9% when
   the same fabrication starts at a leaf.
2. **Every edge is a command that can fail.** An edge with no `verify` is a
   spec error, not a default pass, and `validate` rejects it.
3. **Caps are declared before the run and enforced by the runner, not the
   agent:** wall clock (240 minutes hard, counting only active runner time,
   a run parked at a human gate does not burn the clock), attempts per node
   (default 2), USD per agent node and per run, and `attended: true` is
   required on every graph. A cap trip halts the run with exit 3 and a named
   reason. It never re-loops on its own.
4. **Two halt classes are distinguished:** `stall` (the same failure
   signature twice in a row) and `budget-while-working` (a cap expired while
   the node was still producing something). Source:
   Long-Horizon-Terminal-Bench (arXiv:2607.08964) reports that 79% of
   unresolved long-horizon runs die the second way, not the first, so
   collapsing the two into one generic "timed out" would hide which failure
   actually happened.
5. **State lives in one runner-owned JSON file**, rewritten after every
   node. Agents do not get to edit it. Resume reads from that file, never
   from a chat transcript.
6. **Replay is a first-class output.** `events.jsonl` is append-only and
   records every command, exit code, duration, cost, and artifact hash, and
   nothing else, no artifact bodies. A replay of a client engagement carries
   hashes and control decisions, never the client's actual content.
7. **Human gates are real stops.** A gate node writes a request file and
   exits 3. Only `answer` followed by `resume` moves it forward. Nothing
   times out into an assumed answer.

## Install

```
npm install
```

Zero runtime dependencies. Node 22 or newer.

To use the CLI from anywhere:

```
npm link
windlass --help
```

Or just run it in place with `node bin/windlass.mjs ...` from the repo.

## Usage

```
windlass validate <graph.json>
windlass run <graph.json> [--run-id <id>] [--allow-nested]
windlass answer <graph.json> <GATE_ID> '<json>' [--run-id <id>]
windlass resume <graph.json> --run-id <id> [--allow-nested]
windlass replay <graph.json> --run-id <id> [--out replay.json]
windlass view <run-dir|replay.json> --out <file.html> [--title "..."]
windlass --selftest
windlass --version
```

`validate`, `run`, `answer`, `resume`, and `replay` delegate to
`src/runner.mjs` unchanged, the CLI does not reimplement any of that logic.
`view` is the one new command: point it at a run's directory (the one
`replay` wrote to) or directly at a `replay.json` file, and it renders a
self-contained HTML page, then runs its own `--check` gate against the
file it just wrote and exits non-zero if that gate fails.

`--allow-nested` is only needed when running from inside an existing Claude
Code session (the runner refuses to spawn a nested `claude -p` there by
default, because that has been observed to hang). A script-only graph like
the example below has nothing to spawn, so it is safe either way, but the
flag is still required because the runner cannot tell in advance that a
given graph will never reach an agent node.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The run reached the end of the graph, or the command did what it was asked (`validate` found no errors, `view` wrote a page). |
| `1` | A node failed and the graph has no edge left to try, or `--check` found a violation in a rendered replay. The pipeline has an answer and the answer is no. |
| `2` | Usage or config error: an unreadable graph file, a node that references an id that does not exist, an edge with no `verify`. Nothing ran. |
| `3` | **The run stopped and is waiting for you.** Either a gate node paused for a human answer, or a declared cap tripped (`stall`, `budget-while-working`, `cap:attempts`, `cap:wall`, `cap:usd`). Never an error: `state.json` carries `halt_reason`, and `resume` continues from it. |

`3` is the code that matters and the reason the runner exists. A pipeline that
silently answered its own gate, or quietly looped past its cap, would be
cheaper to build and worth nothing. Exit 3 is the runner refusing to do that.

## Worked example

`examples/echo/pipeline.graph.json` is the fixture the selftest uses: four
nodes, script, script, gate, script, wired with a bounded retry and one
human gate. `examples/demo/` is a separate copy of the same graph, kept
apart from the selftest fixture on purpose (see Limitations), used to
produce the committed demo run:

```
windlass validate examples/demo/pipeline.graph.json
windlass run examples/demo/pipeline.graph.json --run-id demo --allow-nested
# GRAPH PAUSED, halt_reason: gate, current: gate1

windlass answer examples/demo/pipeline.graph.json gate1 '{"ok":true}' --run-id demo
windlass resume examples/demo/pipeline.graph.json --run-id demo --allow-nested
# GRAPH DONE

windlass replay examples/demo/pipeline.graph.json --run-id demo
windlass view examples/demo/.graph-runner/demo --out examples/demo-replay.html
```

The demo, [`examples/demo-replay.html`](examples/demo-replay.html), is the
actual output of that sequence, not a mock-up. Open it in a browser (it
fetches nothing, so it works offline): it shows the graph's caps,
a node-by-node timeline with each command, exit code, duration and cost,
the two edges that had to fail once before the `bump` node's `on_fail`
retry sent it back to `seed`, the exact question `gate1` asked, and the
exact answer (`{"ok": true}`) a human gave it, read straight out of
`events.jsonl`. Nothing on that page was typed in by hand.

## What the viewer will and will not show

The viewer renders only what `events.jsonl` and the graph definition
actually recorded. If a field was never written, the page says
"not recorded". It never computes a duration or a cost that was not
measured, and it never reads an artifact's contents off disk to fill in a
gap, artifact bodies are deliberately excluded from the event log by design
law 6 above, on the theory that a replay of a client engagement should
never be able to leak client material even by accident. So a node's
declared output paths show up as hashes, never as content, and a gate's
`reads` list shows the paths a human was told to look at, not what was in
them.

## Limitations

- The runner spawns `claude -p` for agent nodes and shells out for script
  and loop nodes. It has been tested against `examples/echo`, which is
  script-only and makes zero model calls. It has not been run at scale
  against a graph with many agent nodes.
- `windlass view` currently expects a `replay.json` in the shape
  `src/runner.mjs replay` produces. It does not (yet) reconstruct a replay
  from a bare `state.json` and `events.jsonl` without the original graph
  file, because the graph's own text (`run`, `verify`, `question`) is part
  of what the page shows and that text lives only in the graph file, not
  in the event log.
- `examples/echo/` is left untouched on purpose: `--selftest` copies it
  verbatim into a temp directory rather than checking it out fresh, so any
  run artifacts left inside it (a `state.json`, a `DONE.txt`) would corrupt
  the fixture's assumption that `bump` needs exactly two attempts. The
  committed demo run lives in `examples/demo/` instead, a separate copy of
  the same graph, specifically so it can carry its own run output without
  touching the fixture.
- `gate-answer` events only carry an `answer` field for runs produced after
  this repo's first commit. A `replay.json` from an older run (or from a
  hand-built one) that lacks it renders "not recorded" for that gate's
  answer rather than guessing.
- There is no dashboard, no server, and no way to watch a run live from the
  browser. `view` is a one-shot renderer of a finished (or paused) run's
  state, nothing more.
- Windows paths and a leading `~/` in a graph's `run`/`verify` strings are
  handled (the runner expands `~/` itself since the Windows shell will
  not), but this has only been exercised on Windows with Git Bash and
  PowerShell, not on Linux or macOS.

## License

MIT, see `LICENSE`.
