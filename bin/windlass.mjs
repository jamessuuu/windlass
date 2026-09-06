#!/usr/bin/env node
// windlass — thin CLI dispatcher. `validate | run | answer | resume | replay`
// and `--selftest` delegate to src/runner.mjs UNCHANGED (spawned as a child
// process running the exact same file, so behaviour is byte-identical — this
// file does not reimplement any of that logic). `view` is the one new
// command: it renders a run's replay.json to a self-contained HTML page via
// src/viewer.mjs.
//
// Usage:
//   windlass validate <graph.json>
//   windlass run <graph.json> [--run-id <id>] [--allow-nested]
//   windlass answer <graph.json> <GATE_ID> '<json>' [--run-id <id>]
//   windlass resume <graph.json> --run-id <id> [--allow-nested]
//   windlass replay <graph.json> --run-id <id> [--out replay.json]
//   windlass view <run-dir|replay.json> --out <file.html> [--title "..."]
//   windlass --selftest
//   windlass --version
//   windlass --help
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(BIN_DIR, '..');
const RUNNER = join(PKG_DIR, 'src', 'runner.mjs');
const VIEWER = join(PKG_DIR, 'src', 'viewer.mjs');

const HELP = `windlass — pipelines as typed graphs with verifier edges and human gates.

Commands (delegated to the runner unchanged):
  validate <graph.json>                       schema + rules; exit 2 on error
  run <graph.json> [--run-id <id>] [--allow-nested]
  answer <graph.json> <GATE_ID> '<json>' [--run-id <id>]
  resume <graph.json> --run-id <id> [--allow-nested]
  replay <graph.json> --run-id <id> [--out replay.json]

New command:
  view <run-dir|replay.json> --out <file.html> [--title "..."]
       renders a run's replay (graph + state + events) to one self-contained
       HTML file, then runs the same --check gate the file must pass.

  --selftest    runs the runner's selftest (examples/echo, zero model calls); prints passed/total
  --version     print the installed windlass version
  --help        this message
`;

function delegateToRunner(argv) {
  const r = spawnSync(process.execPath, [RUNNER, ...argv], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

function cmdView(argv) {
  // Delegate to viewer.mjs as its own process too — it is the one file that
  // owns both the render and the --check gate, and running it this way
  // means `windlass view` and `node src/viewer.mjs ...` behave identically.
  const r = spawnSync(process.execPath, [VIEWER, ...argv], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    process.stdout.write(HELP);
    process.exit(argv.length === 0 ? 2 : 0);
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
    process.stdout.write(`${pkg.version}\n`);
    process.exit(0);
  }
  if (argv.includes('--selftest')) return delegateToRunner(['--selftest']);

  const cmd = argv[0];
  if (['validate', 'run', 'answer', 'resume', 'replay'].includes(cmd)) {
    return delegateToRunner(argv);
  }
  if (cmd === 'view') return cmdView(argv.slice(1));

  process.stderr.write(`windlass: unknown command "${cmd}"\n\n${HELP}`);
  process.exit(2);
}

main();
