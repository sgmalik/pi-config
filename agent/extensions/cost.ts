import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { gatherCosts, formatCost } from "./lib/costUtils.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("cost", {
		description: "Show API cost summary (default: 7 days). Usage: /cost [days]",
		handler: async (args, ctx) => {
			const days = args?.trim() ? parseInt(args.trim(), 10) : 7;
			if (isNaN(days) || days < 1) {
				ctx.ui.notify("Usage: /cost [days] — e.g. /cost 7", "error");
				return;
			}

			const summary = gatherCosts(days);

			const lines: string[] = [];
			lines.push(`💰 Total: ${formatCost(summary.total)}  (${summary.totalSessions} sessions, last ${days} days)`);
			lines.push(`   Main: ${formatCost(summary.mainCost)} (${summary.mainSessions})  ·  Subagents: ${formatCost(summary.subagentCost)} (${summary.subagentSessions})`);
			lines.push("");

			// By date
			const dates = Object.keys(summary.byDate).sort();
			if (dates.length > 0) {
				lines.push("📅 By date:");
				for (const d of dates) {
					const bar = "█".repeat(Math.max(1, Math.round((summary.byDate[d] / summary.total) * 30)));
					lines.push(`   ${d}  ${formatCost(summary.byDate[d]).padStart(8)}  ${bar}`);
				}
				lines.push("");
			}

			// By project (top 10)
			const projects = Object.entries(summary.byProject)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10);
			if (projects.length > 0) {
				lines.push("📁 By project:");
				for (const [name, cost] of projects) {
					lines.push(`   ${name.padEnd(30)} ${formatCost(cost).padStart(8)}`);
				}
				lines.push("");
			}

			// By model
			const models = Object.entries(summary.byModel).sort((a, b) => b[1] - a[1]);
			if (models.length > 0) {
				lines.push("🤖 By model:");
				for (const [name, cost] of models) {
					lines.push(`   ${name.padEnd(30)} ${formatCost(cost).padStart(8)}`);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
