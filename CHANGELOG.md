# Changelog

## [Unreleased]

### Added

- `site/`: a public page for the rendered replay. It leads with the three
  things the runner refuses to do and names the test behind each, embeds
  verbatim slices of `examples/demo-replay.html`, and states how to reproduce
  exit code 3. Plain HTML and CSS, no JavaScript, no build step at serve time.
- `bin/build-site.mjs`: re-renders the demo replay with the README's own
  `windlass view` command, copies it into `site/`, and writes every number on
  the page from its source. `tests/site.test.mjs` derives each number again and
  fails on any disagreement.
- `bin/build-assets.mjs`: renders the favicon family and the Open Graph image
  from `site/favicon.svg` and `bin/assets/og.html` (needs a Playwright install
  named on the command line; the repo itself still has zero dependencies).
- `tests/redaction.test.mjs`: a permanent negative control. A copy of the
  runner with the redaction line removed must let a planted token through, so
  the redaction test is proven to bite on every run, not once in a commit
  message.
- `tests/no-model.test.mjs`: pins "no model inside the runner" to three static
  facts that fail if the source grows an HTTP client, a model SDK, or a
  dependency.
- `vercel.json`: static hosting config with security headers and a CSP that
  allows inline styles only on the replay page, which carries its own.

### Fixed

- The selftest printed a hardcoded `21/21` while running 25 checks; four checks
  had been added without the total. The total is now counted as checks run.
  The README, the CLI help and the writeup no longer state that number.

## [0.1.0] - 2026-09-05

- Runner, replay viewer with a `--check` gate, CLI dispatcher, committed demo
  run and its rendered replay. Not tagged.
