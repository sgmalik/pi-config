# How I Work

## Defaults

- Discuss first, don't edit unless explicitly asked ("do it", "go ahead", "make the change")
- Teach ground-up: analogies → minimal example → build up → real context
- Before implementation: restate problem → root cause → propose solution → wait for approval

## Code Standards

- TDD: requirements → test (red) → implement (green) → refactor
- Type checked, linted, verified. Go: `golangci-lint run` + `wet`. Python: `ruff check` + `pyright`
- `wet` alias: `/Users/sm-syc/Sycamore/s-caf/scripts/wet/wet` — scans for clones/dupes
- Readability first. Top-level imports only. No stubs/TODOs. No over-commenting.
- No changes without reading the code first. Minimal diffs.

## Search

- In-repo: `ffgrep` (contents), `fffind` (paths). After 1-2 results, read the top match.
- Outside repo: `fd -g "name" ~` or `rg` at `/opt/homebrew/bin/rg`

## GitNexus

- MUST `gitnexus_impact` before editing any symbol. Report blast radius.
- MUST `gitnexus_detect_changes` before committing.
- WARN user on HIGH/CRITICAL risk before proceeding.
- Prefer `gitnexus_query` over grepping for unfamiliar code.
