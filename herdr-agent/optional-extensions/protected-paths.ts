/**
 * Protected Paths Extension
 *
 * - Blocks write and edit operations to protected paths (.env, .git/, node_modules/)
 * - Requires user confirmation before any `rm` command in bash
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const protectedPaths = [".env", ".git/", "node_modules/"];

	pi.on("tool_call", async (event, ctx) => {
		// --- Guard: require confirmation for any rm command ---
		if (event.toolName === "bash") {
			const command = event.input.command as string;

			// Match rm commands (rm, rm -f, rm -rf, rm -r, etc.)
			if (/\brm\s/.test(command)) {
				if (!ctx.hasUI) {
					return { block: true, reason: "rm commands require user confirmation (no UI available)" };
				}

				const confirmed = await ctx.ui.confirm(
					"⚠️ File Deletion",
					`Allow this rm command?\n\n  $ ${command}`,
				);

				if (!confirmed) {
					ctx.ui.notify("rm command blocked by user", "info");
					return { block: true, reason: "rm command blocked by user" };
				}
			}

			return undefined;
		}

		// --- Guard: block writes/edits to protected paths ---
		if (event.toolName !== "write" && event.toolName !== "edit") {
			return undefined;
		}

		const path = event.input.path as string;
		const isProtected = protectedPaths.some((p) => path.includes(p));

		if (isProtected) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
			}
			return { block: true, reason: `Path "${path}" is protected` };
		}

		return undefined;
	});
}
