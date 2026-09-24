/**
 * GitNexus — Code Intelligence Tools
 *
 * Exposes four tools backed by the local `gitnexus` CLI:
 *
 *   gitnexus_query          Search execution flows by concept
 *   gitnexus_impact         Blast radius before editing a symbol
 *   gitnexus_context        360° callers/callees/flows for a symbol
 *   gitnexus_detect_changes Map current git diff to affected symbols
 *
 * The index is repo-aware: `npx gitnexus analyze` must be run once per
 * repo to build it. After that, all tools operate automatically against
 * the right index based on cwd.
 *
 * To re-index: npx gitnexus analyze
 * To check status: npx gitnexus status
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Run a gitnexus CLI command, returns stdout. Throws on non-zero exit
// with stderr included in the error message.
async function gn(cwd: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync("npx", ["gitnexus", ...args], {
			cwd,
			timeout: 30_000,
			maxBuffer: 4 * 1024 * 1024, // 4 MiB
		});
		return stdout.trim();
	} catch (err: any) {
		// execFile puts stderr in err.stderr, stdout in err.stdout
		const detail = err.stderr?.trim() || err.message || String(err);
		throw new Error(detail);
	}
}

export default function (pi: ExtensionAPI) {

	// ── gitnexus_query ────────────────────────────────────────────────────────

	pi.registerTool({
		name: "gitnexus_query",
		label: "GitNexus Query",
		description:
			"Search the GitNexus knowledge graph for execution flows related to a concept. " +
			"Returns process-grouped results ranked by relevance. Use this instead of grepping " +
			"when you need to understand how a feature or concept flows end-to-end through the codebase.",
		promptSnippet:
			"Search the code knowledge graph for execution flows related to a concept",
		promptGuidelines: [
			"Use gitnexus_query to understand how a feature flows through the codebase before editing it.",
			"Use gitnexus_query with a concept name (e.g. 'skill execution', 'audit log write') rather than a symbol name — it searches flows, not just identifiers.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Concept or feature to search for (e.g. 'skill execution', 'audit log write', 'LLM provider call')",
			}),
			limit: Type.Optional(Type.Number({
				description: "Max execution flows to return (default 5)",
			})),
			context: Type.Optional(Type.String({
				description: "Task context to improve ranking — what you are trying to build or fix",
			})),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const args = ["query", params.query];
			if (params.limit) args.push("--limit", String(params.limit));
			if (params.context) args.push("--context", params.context);

			try {
				const out = await gn(ctx.cwd, args);
				return {
					content: [{ type: "text", text: out || "(no results)" }],
					details: { query: params.query },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `gitnexus query failed: ${err.message}` }],
					details: { error: err.message },
				};
			}
		},
	});

	// ── gitnexus_impact ───────────────────────────────────────────────────────

	pi.registerTool({
		name: "gitnexus_impact",
		label: "GitNexus Impact",
		description:
			"Blast radius analysis: what breaks if you change a symbol. " +
			"Run this BEFORE editing any function, method, or type. " +
			"Reports direct callers, affected execution flows, and risk level (LOW / MEDIUM / HIGH / CRITICAL).",
		promptSnippet:
			"Blast radius analysis — what breaks if you change a symbol",
		promptGuidelines: [
			"Use gitnexus_impact before modifying any function, method, or type to understand the blast radius.",
			"If gitnexus_impact returns HIGH or CRITICAL risk, report this to the user before proceeding.",
			"Pass file to disambiguate common symbol names (e.g. 'handleConn' exists in multiple files).",
		],
		parameters: Type.Object({
			target: Type.String({
				description: "Symbol name to analyse (function, method, type, or interface)",
			}),
			direction: Type.Optional(Type.String({
				description: "'upstream' (who calls this — default) or 'downstream' (what this calls)",
			})),
			file: Type.Optional(Type.String({
				description: "File path to disambiguate when the symbol name is common",
			})),
			depth: Type.Optional(Type.Number({
				description: "Max relationship depth (default 3)",
			})),
			summaryOnly: Type.Optional(Type.Boolean({
				description: "Return counts and risk level only, omit full symbol list (faster)",
			})),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const args = ["impact", params.target];
			if (params.direction) args.push("--direction", params.direction);
			if (params.file) args.push("--file", params.file);
			if (params.depth) args.push("--depth", String(params.depth));
			if (params.summaryOnly) args.push("--summary-only");

			try {
				const out = await gn(ctx.cwd, args);
				return {
					content: [{ type: "text", text: out || "(no results)" }],
					details: { target: params.target },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `gitnexus impact failed: ${err.message}` }],
					details: { error: err.message },
				};
			}
		},
	});

	// ── gitnexus_context ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "gitnexus_context",
		label: "GitNexus Context",
		description:
			"360-degree view of a code symbol: its callers, what it calls, and which " +
			"execution flows it participates in. Use when you need full context on a specific " +
			"symbol before refactoring or extending it.",
		promptSnippet:
			"360° view of a symbol — callers, callees, execution flows",
		promptGuidelines: [
			"Use gitnexus_context to get full caller/callee/flow context for a specific symbol before refactoring.",
		],
		parameters: Type.Object({
			name: Type.String({
				description: "Symbol name (function, method, type, or interface)",
			}),
			file: Type.Optional(Type.String({
				description: "File path to disambiguate when the symbol name is common",
			})),
			includeSource: Type.Optional(Type.Boolean({
				description: "Include the symbol's full source code in the response",
			})),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const args = ["context", params.name];
			if (params.file) args.push("--file", params.file);
			if (params.includeSource) args.push("--content");

			try {
				const out = await gn(ctx.cwd, args);
				return {
					content: [{ type: "text", text: out || "(no results)" }],
					details: { name: params.name },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `gitnexus context failed: ${err.message}` }],
					details: { error: err.message },
				};
			}
		},
	});

	// ── gitnexus_detect_changes ───────────────────────────────────────────────

	pi.registerTool({
		name: "gitnexus_detect_changes",
		label: "GitNexus Detect Changes",
		description:
			"Map the current git diff to indexed symbols and affected execution flows. " +
			"Run this before committing to verify your changes only touch expected symbols " +
			"and to surface any unintended blast radius.",
		promptSnippet:
			"Map git diff to affected symbols and execution flows",
		promptGuidelines: [
			"Use gitnexus_detect_changes before committing to verify changes only affect expected symbols.",
		],
		parameters: Type.Object({
			scope: Type.Optional(Type.String({
				description: "'unstaged' (default), 'staged', 'all', or 'compare'",
			})),
			baseRef: Type.Optional(Type.String({
				description: "Branch or commit to compare against when scope is 'compare' (e.g. 'main')",
			})),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const args = ["detect-changes"];
			if (params.scope) args.push("--scope", params.scope);
			if (params.baseRef) args.push("--base-ref", params.baseRef);

			try {
				const out = await gn(ctx.cwd, args);
				return {
					content: [{ type: "text", text: out || "(no changes detected)" }],
					details: { scope: params.scope ?? "unstaged" },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `gitnexus detect-changes failed: ${err.message}` }],
					details: { error: err.message },
				};
			}
		},
	});

	// ── /gitnexus command — status + quick help ───────────────────────────────

	pi.registerCommand("gitnexus", {
		description: "Show GitNexus index status for the current repo. Usage: /gitnexus",
		handler: async (_args, ctx) => {
			try {
				const out = await gn(ctx.cwd, ["status"]);
				ctx.ui.notify(out || "GitNexus status unavailable", "info");
			} catch (err: any) {
				ctx.ui.notify(
					`GitNexus: ${err.message}\n\nTo index this repo: npx gitnexus analyze`,
					"error",
				);
			}
		},
	});
}
