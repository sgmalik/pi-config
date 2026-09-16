## Tool Discipline
- Search: `ffgrep`/`fffind` first, not raw `bash grep -r`/`find` — frecency-ranked and capped by `limit`, avoids dumping unfiltered noise into context.
- Read Go: outline first (default), then `symbol=` for one body. Avoid `raw: true` unless you need byte-for-byte source.
- Impact analysis: use `gitnexus_impact({summaryOnly: true})` when you only need the risk level, not the full caller/flow list.
- Subagents/experts: constrain report length explicitly in the task prompt (e.g. "report back in <15 lines") — their final output lands in your context same as any tool result.
