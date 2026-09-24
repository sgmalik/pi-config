/**
 * Tool Counter — Rich two-line custom footer
 *
 * Line 1: model + context meter on left, tokens in/out + cost + cache hit% on right
 * Line 2: cwd (branch) on left, tool call tally on right
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { basename } from "node:path";
import { applyExtensionDefaults } from "./lib/themeMap.ts";

// Maps AIP profile IDs (last segment of ARN) to friendly names
const AIP_NAMES: Record<string, string> = {
	"1xd0f80p0sob": "haiku-4-5",
	"ijbemdw11wt8": "opus-4-5",
	"3kvz3k0n0omc": "opus-4-6",
	"6u4c1tf3bb5x": "opus-4-7",
	"xsahe8qo68zv": "opus-4-8",
	"j4r6oet02qnx": "sonnet-4",
	"qp7zi66w8hlf": "sonnet-4-5",
	"2zz214l0w3el": "sonnet-4-6",
	"ov5vdsffeznl": "sonnet-5",
	"8qvdt0ezj0gy": "deepseek-v3-2",
	"2uzqen647naq": "glm-5",
};

function friendlyModel(id: string): string {
	// Full ARN: arn:aws:bedrock:...:application-inference-profile/<id>
	if (id.includes("application-inference-profile/")) {
		const profileId = id.split("application-inference-profile/")[1];
		return AIP_NAMES[profileId] ?? profileId;
	}
	// Cross-region inference profile: us.anthropic.claude-sonnet-4-6-...
	return id.replace(/^(us|eu|ap)\./, "").replace(/-\d{8}-v\d+:\d+$/, "");
}

export default function (pi: ExtensionAPI) {
	const counts: Record<string, number> = {};

	pi.on("tool_execution_end", async (event) => {
		counts[event.toolName] = (counts[event.toolName] || 0) + 1;
	});

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					let tokIn = 0;
					let tokOut = 0;
					let cacheRead = 0;
					let cacheWrite = 0;
					let cost = 0;
					for (const entry of ctx.sessionManager.getBranch()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const m = entry.message as AssistantMessage;
							tokIn += m.usage.input;
							tokOut += m.usage.output;
							cacheRead += m.usage.cacheRead ?? 0;
							cacheWrite += m.usage.cacheWrite ?? 0;
							cost += m.usage.cost.total;
						}
					}

					const fmt = (n: number) => n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
					const dir = basename(ctx.cwd);
					const branch = footerData.getGitBranch();

					// Cache hit % = cacheRead / (cacheRead + tokIn), shown only once we have data
					const totalInput = tokIn + cacheRead;
					const cacheHitPct = totalInput > 0 ? Math.round((cacheRead / totalInput) * 100) : null;
					const cacheColor = cacheHitPct === null ? "dim"
						: cacheHitPct >= 70 ? "success"
						: cacheHitPct >= 40 ? "warning"
						: "error";

					// --- Line 1: model + context meter (left), tokens + cost + cache (right) ---
					const usage = ctx.getContextUsage();
					const pct = usage ? usage.percent : 0;
					const filled = Math.round(pct / 10) || 1;
					const model = friendlyModel(ctx.model?.id ?? "no-model");

					const l1Left =
						theme.fg("dim", ` ${model} `) +
						theme.fg("warning", "[") +
						theme.fg("success", "#".repeat(filled)) +
						theme.fg("dim", "-".repeat(10 - filled)) +
						theme.fg("warning", "]") +
						theme.fg("dim", " ") +
						theme.fg("accent", `${Math.round(pct)}%`);

					const cacheStr = cacheHitPct !== null
						? theme.fg("dim", " cache ") + theme.fg(cacheColor, `${cacheHitPct}%`)
						: "";

					const l1Right =
						theme.fg("success", `${fmt(tokIn)}`) +
						theme.fg("dim", " in ") +
						theme.fg("accent", `${fmt(tokOut)}`) +
						theme.fg("dim", " out ") +
						theme.fg("warning", `$${cost.toFixed(4)}`) +
						cacheStr +
						theme.fg("dim", " ");

					const pad1 = " ".repeat(Math.max(1, width - visibleWidth(l1Left) - visibleWidth(l1Right)));
					const line1 = truncateToWidth(l1Left + pad1 + l1Right, width, "");

					// --- Line 2: cwd + branch (left), tool tally (right) ---
					const l2Left =
						theme.fg("dim", ` ${dir}`) +
						(branch
							? theme.fg("dim", " ") + theme.fg("warning", "(") + theme.fg("success", branch) + theme.fg("warning", ")")
							: "");

					const entries = Object.entries(counts);
					const l2Right = entries.length === 0
						? theme.fg("dim", "waiting for tools ")
						: entries.map(
							([name, count]) =>
								theme.fg("accent", name) + theme.fg("dim", " ") + theme.fg("success", `${count}`)
						).join(theme.fg("warning", " | ")) + theme.fg("dim", " ");

					const pad2 = " ".repeat(Math.max(1, width - visibleWidth(l2Left) - visibleWidth(l2Right)));
					const line2 = truncateToWidth(l2Left + pad2 + l2Right, width, "");

					return [line1, line2];
				},
			};
		});
	});
}
