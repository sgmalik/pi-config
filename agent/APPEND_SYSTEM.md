## Tool Discipline
- Search: `ffgrep`/`fffind` first, not raw `bash grep -r`/`find` — frecency-ranked and capped by `limit`, avoids dumping unfiltered noise into context.
- Read Go: outline first (default), then `symbol=` for one body. Avoid `raw: true` unless you need byte-for-byte source.
- Impact analysis: use `gitnexus_impact({summaryOnly: true})` when you only need the risk level, not the full caller/flow list.
- Subagents/experts: constrain report length explicitly in the task prompt (e.g. "report back in <15 lines") — their final output lands in your context same as any tool result.

## Image Handling
- When the user provides or mentions an image/screenshot file path, including dropzone temp paths or desktop files, use the native `read` tool on that image path directly first.
- Do not implement OCR, image conversion, screenshot parsing, or shell-based inspection before trying native `read`.
- If native `read` fails, or the active model does not support image input, explain that limitation and ask before attempting OCR/conversion workarounds.
- Common image paths/extensions include `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.heic`, `.tiff`, and temporary screenshot/dropzone paths.
