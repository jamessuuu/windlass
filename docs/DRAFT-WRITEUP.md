# The runner has no model inside it

**Reproduce this:** `npm test` — the runner's own selftest (21 assertions, zero
model calls, run against committed fixtures) plus 24 tests, no dependencies.
Then open `examples/demo-replay.html`, which is the rendered output of a real
`run → answer → resume → replay` sequence, not a mock-up.

Windlass runs a pipeline described as a typed graph. Nodes are scripts, agents,
or human gates. Every edge carries a `verify` command that can fail. The runner
itself contains no model, no prompt, and no judgment: it starts processes, reads
exit codes, enforces caps, and writes an append-only log.

That sounds like a limitation. It is the entire point.

## The finding that matters most: exit 3

Most of what goes wrong in agent pipelines is not a wrong answer. It is a
pipeline that kept going when it should have stopped — looped past its budget,
or answered its own approval step, or quietly retried until something passed.

Windlass has four exit codes. `0` finished, `1` a node failed and no edge is
left to try, `2` the graph is malformed and nothing ran. The one that matters is
`3`: **the run stopped and is waiting for you.** A gate node paused for a human
answer, or a declared cap tripped — `stall`, `budget-while-working`,
`cap:attempts`, `cap:wall`, `cap:usd`. `state.json` records which, and `resume`
continues from disk rather than from a conversation.

There is a test whose only job is to prove the gate stops the run, because a
runner that cannot prove it stops at a gate is not a runner with human gates. A
cap that can be talked out of is not a cap. No timeout ever answers a gate.

## Two halt classes, not one

A stalled run and a run that ran out of budget while still making progress look
identical from outside, and they need opposite responses. Windlass distinguishes
`stall` (the same failure signature twice — stop, something is wrong) from
`budget-while-working` (the cap expired while the node was still producing —
the work was fine, the budget was not). The design notes cite the
long-horizon-agent literature for why the second case dominates unresolved runs;
what this repo can show you is that the two are separate halt classes with
separate reasons in `state.json`, and the selftest exercises both.

## Agent nodes exchange file paths, never text

An agent node's prompt names its inputs by path and demands its outputs by path.
The runner never pastes one agent's output into another's context and never
summarises. `validate` refuses a prompt template that tries to inline another
node's output (`{{cat ...}}`, `$(cat ...)`) — that is a spec error, caught before
the run, not a runtime surprise.

The reasoning, cited in `docs/SPEC.md`: a fabricated fact injected at a fan-in
node propagates far more damagingly than the same fabrication at a leaf. So
fan-in points are scripts, not agents, and the currency between nodes is a path
plus a hash.

## The replay, and the one exception I had to write down

`events.jsonl` is append-only: every command, exit code, duration, cost, and
artifact hash. Deliberately **not** artifact bodies — so a replay of a client
engagement carries hashes, not content.

While building the viewer I hit a real conflict. The whole demo is "here is an
attended pipeline, and here is the gate a human answered" — but the answer value
was never logged, only the path it was written to. Reading the artifact off disk
to fill the gap would have defeated the point of not logging bodies.

So the event now carries the answer value, and design law 6 has a named
exception with a boundary: **what a node PRODUCED is a hash, what a human
DECIDED is a value.** A decision is control data, the same class of thing as an
exit code, and it is redacted leaf by leaf before it is written.

That is a privacy guarantee, and a guarantee that is not tested is a promise.
`tests/redaction.test.mjs` runs the real runner end to end, plants a
GitHub-token-shaped string in a gate answer, and asserts it never reaches
`events.jsonl` — and asserts the decision itself still survives, because a
redaction blunt enough to eat the answer would make the replay worthless. I
verified the test bites by removing the redaction and watching it fail.

The honest caveat is in the spec: this guarantee is only as strong as
`answer_schema`. A schema that accepts free text can accept client material.
Keep it narrow.

## What the viewer will not do

It renders only what `events.jsonl` recorded. If a cost was never measured, the
page says "not recorded" — it does not print `0`. It never reads an artifact off
disk to fill a gap. The page is one file with zero JavaScript and zero network
requests, and every `<details>` is open by default, because a collapsed
`<details>` vanishes from a printed PDF and a replay that loses its evidence
when printed is not evidence.

`viewer.mjs --check` enforces all of that mechanically, and every rule has a
planted fixture proving it fails.

## Limitations

- The caps are wall-clock, attempts, and USD. There is no memory or disk cap.
- Cost is tracked per node and rolled into `usd_total`. In the committed demo
  every node reads `$0`, and that is a measured zero rather than a missing one:
  the graph is script-only, script nodes genuinely cost nothing, and the runner
  writes `usd: 0` for each. The "not recorded" marker is for fields the log
  actually lacks. I wrote the opposite in a draft of this paragraph, checked the
  rendered demo against `state.json`, and found I was describing a tool I had
  not looked at closely enough.
- `--allow-nested` exists because the runner refuses to spawn a nested
  `claude -p` from inside a live Claude Code session, which has been observed to
  hang. A script-only graph has nothing to spawn but still needs the flag,
  because the runner cannot know in advance that a graph will never reach an
  agent node.
- The replay viewer has been read on desktop and in print. It has not been
  tested with a screen reader.
- One selftest fixture and one demo graph is not a large corpus. Nothing here
  claims the design holds at fifty nodes; it claims these four nodes, these
  caps, and these halt classes do what the spec says, and gives you the command
  that shows it.
