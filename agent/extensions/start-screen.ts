/**
 * Start Screen Widget
 *
 * Shows a themed welcome widget on session start with:
 *   - ASCII art logo
 *   - Current working project + git branch
 *   - 7-day cost summary (total, by date sparkline, top models)
 *
 * Auto-dismisses after the first turn begins.
 *
 * Usage: pi -e extensions/start-screen.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { basename } from "node:path";
import { gatherCosts, formatCost } from "./lib/costUtils.ts";
import { applyExtensionDefaults } from "./lib/themeMap.ts";

const LOGO = [
	" ██████╗ ██╗    █████╗  ██████╗ ███████╗███╗  ██╗████████╗",
	" ██╔══██╗██║   ██╔══██╗██╔════╝ ██╔════╝████╗ ██║╚══██╔══╝",
	" ██████╔╝██║   ███████║██║  ███╗█████╗  ██╔██╗██║   ██║   ",
	" ██╔═══╝ ██║   ██╔══██║██║   ██║██╔══╝  ██║╚████║   ██║   ",
	" ██║     ██║   ██║  ██║╚██████╔╝███████╗██║ ╚███║   ██║   ",
	" ╚═╝     ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚══╝   ╚═╝   ",
];

const COST_DAYS = 7;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		applyExtensionDefaults(import.meta.url, ctx);

		// Gather cost data (file I/O — do it once up front)
		const costs = gatherCosts(COST_DAYS);

		// Git branch via footer data isn't available here, so read it from ctx if possible
		const project = basename(ctx.cwd);
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";

		ctx.ui.setWidget("start-screen", (_tui, theme) => {
			return {
				render(width: number): string[] {
					const lines: string[] = [];
					const hr = theme.fg("borderMuted", "─".repeat(width));

					lines.push(hr);

					// ── Logo ──
					for (const row of LOGO) {
						lines.push(theme.fg("accent", row));
					}
					lines.push("");

					// ── Project info ──
					const projectLine =
						theme.fg("muted", "  project  ") +
						theme.fg("text", theme.bold(project));
					const modelLine =
						theme.fg("muted", "  model    ") +
						theme.fg("text", model);
					const cwdLine =
						theme.fg("muted", "  cwd      ") +
						theme.fg("dim", ctx.cwd);

					lines.push(projectLine);
					lines.push(modelLine);
					lines.push(cwdLine);
					lines.push("");

					// ── Cost summary (7 days) ──
					lines.push(
						theme.fg("accent", theme.bold("  Cost Summary")) +
						theme.fg("dim", ` (last ${COST_DAYS} days)`),
					);
					lines.push("");

					if (costs.totalSessions === 0) {
						lines.push(theme.fg("dim", "  No session data found."));
					} else {
						// Total line
						lines.push(
							theme.fg("muted", "  total      ") +
							theme.fg("warning", theme.bold(formatCost(costs.total))) +
							theme.fg("dim", `  across ${costs.totalSessions} sessions`),
						);

						// Main vs subagent
						lines.push(
							theme.fg("muted", "  main       ") +
							theme.fg("text", formatCost(costs.mainCost)) +
							theme.fg("dim", ` (${costs.mainSessions})`) +
							theme.fg("muted", "  ·  subagents  ") +
							theme.fg("text", formatCost(costs.subagentCost)) +
							theme.fg("dim", ` (${costs.subagentSessions})`),
						);
						lines.push("");

						// By date — sparkline bar chart
						const dates = Object.keys(costs.byDate).sort();
						if (dates.length > 0) {
							lines.push(theme.fg("muted", "  by date"));
							const maxCost = Math.max(...Object.values(costs.byDate));
							for (const d of dates) {
								const val = costs.byDate[d];
								const barLen = maxCost > 0 ? Math.max(1, Math.round((val / maxCost) * 20)) : 1;
								lines.push(
									theme.fg("dim", `    ${d}  `) +
									theme.fg("text", formatCost(val).padStart(8)) +
									theme.fg("dim", "  ") +
									theme.fg("success", "█".repeat(barLen)),
								);
							}
							lines.push("");
						}

						// Top 5 models
						const models = Object.entries(costs.byModel)
							.sort((a, b) => b[1] - a[1])
							.slice(0, 5);
						if (models.length > 0) {
							lines.push(theme.fg("muted", "  top models"));
							for (const [name, cost] of models) {
								const shortName = name.length > 35 ? name.slice(0, 32) + "…" : name;
								lines.push(
									theme.fg("dim", "    ") +
									theme.fg("text", shortName.padEnd(36)) +
									theme.fg("warning", formatCost(cost).padStart(8)),
								);
							}
							lines.push("");
						}

						// Top 5 projects
						const projects = Object.entries(costs.byProject)
							.sort((a, b) => b[1] - a[1])
							.slice(0, 5);
						if (projects.length > 0) {
							lines.push(theme.fg("muted", "  top projects"));
							for (const [name, cost] of projects) {
								const shortName = name.length > 35 ? name.slice(0, 32) + "…" : name;
								lines.push(
									theme.fg("dim", "    ") +
									theme.fg("text", shortName.padEnd(36)) +
									theme.fg("warning", formatCost(cost).padStart(8)),
								);
							}
							lines.push("");
						}
					}

					lines.push(hr);
					return lines.map((l) => truncateToWidth(l, width, ""));
				},
				invalidate() {},
			};
		});
	});

	// Dismiss the start screen once the user begins working
	pi.on("turn_start", async (_event, ctx) => {
		ctx.ui.setWidget("start-screen", undefined);
	});
}
