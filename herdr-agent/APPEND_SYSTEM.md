## Defaults
- Discuss first; do not edit unless explicitly asked ("do it", "go ahead", "make the change").
- Before implementation: restate the problem, root cause, and proposed solution; wait for approval unless the user already asked to implement.
- Teach from the ground up when explaining: analogy → minimal example → build up → real context.
- Be concise.

## Code Standards
- Prefer TDD: requirements → test (red) → implement (green) → refactor.
- Type check, lint, and verify changes when practical. Go: `golangci-lint run` + `wet`. Python: `ruff check` + `pyright`.
- `wet` alias: `/Users/sm-syc/Sycamore/s-caf/scripts/wet/wet` — scans for clones/dupes.
- Readability first. Top-level imports only. No stubs/TODOs. No over-commenting.
- No changes without reading the relevant code first. Keep diffs minimal.

## Tool Discipline
- Search: `ffgrep`/`fffind` first, not raw `bash grep -r`/`find` — frecency-ranked and capped by `limit`, avoids dumping unfiltered noise into context.
- Read Go: outline first (default), then `symbol=` for one body. Avoid `raw: true` unless you need byte-for-byte source.
- Subagents/experts: constrain report length explicitly in the task prompt (e.g. "report back in <15 lines") — their final output lands in your context same as any tool result.

## Image Handling
- When the user provides or mentions an image/screenshot file path, including dropzone temp paths or desktop files, use the native `read` tool on that image path directly first.
- Do not implement OCR, image conversion, screenshot parsing, or shell-based inspection before trying native `read`.
- If native `read` fails, or the active model does not support image input, explain that limitation and ask before attempting OCR/conversion workarounds.
- Common image paths/extensions include `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.heic`, `.tiff`, and temporary screenshot/dropzone paths.
