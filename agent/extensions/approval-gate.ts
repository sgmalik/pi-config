import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

interface ApprovalState {
	enabled: boolean;
}

const STATE_TYPE = "approval-gate-config";
const MAX_ARGS_LENGTH = 3000;

function latestState(ctx: ExtensionContext): ApprovalState | undefined {
	const entries = ctx.sessionManager.getBranch();
	let state: ApprovalState | undefined;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === STATE_TYPE) {
			const data = entry.data as Partial<ApprovalState> | undefined;
			if (typeof data?.enabled === "boolean") state = { enabled: data.enabled };
		}
	}
	return state;
}

function formatArgs(input: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(input ?? {}, null, 2);
	} catch {
		text = String(input);
	}
	if (text.length <= MAX_ARGS_LENGTH) return text;
	return `${text.slice(0, MAX_ARGS_LENGTH)}\n… truncated ${text.length - MAX_ARGS_LENGTH} chars`;
}

export default function approvalGate(pi: ExtensionAPI) {
	let enabled = false;

	function persist(value: boolean) {
		enabled = value;
		pi.appendEntry<ApprovalState>(STATE_TYPE, { enabled });
	}

	function restore(ctx: ExtensionContext) {
		enabled = latestState(ctx)?.enabled ?? false;
	}

	pi.registerCommand("approval", {
		description: "Require confirmation before tool calls. Usage: /approval [on|off|status]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (!arg || arg === "status") {
				ctx.ui.notify(`Approval gate is ${enabled ? "ON" : "OFF"}.`, enabled ? "warning" : "info");
				return;
			}
			if (arg === "on" || arg === "enable" || arg === "enabled") {
				persist(true);
				ctx.ui.notify("Approval gate ON — every tool call requires confirmation.", "warning");
				return;
			}
			if (arg === "off" || arg === "disable" || arg === "disabled") {
				persist(false);
				ctx.ui.notify("Approval gate OFF.", "info");
				return;
			}
			ctx.ui.notify("Usage: /approval [on|off|status]", "warning");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return undefined;
		if (!ctx.hasUI) {
			return { block: true, reason: "Approval gate is enabled, but no interactive UI is available." };
		}

		const ok = await ctx.ui.confirm(
			`Allow tool call: ${event.toolName}?`,
			formatArgs(event.input),
		);
		if (ok) return undefined;
		return { block: true, reason: `Tool call '${event.toolName}' denied by user.` };
	});

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("session_fork", async (_event, ctx) => restore(ctx));
}
