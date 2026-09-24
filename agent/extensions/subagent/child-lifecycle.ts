import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface ChildArtifact {
	version: 1;
	kind: "result" | "progress";
	exitCode: number;
	messages: Message[];
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

function writeArtifact(filePath: string, artifact: ChildArtifact): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporary = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(artifact)}\n`, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(temporary, filePath);
}

export default function (pi: ExtensionAPI) {
	const artifactPath = process.env.PI_SUBAGENT_RESULT_FILE;
	if (!artifactPath) return;

	const messages: Message[] = [];
	const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	let model: string | undefined;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let written = false;
	pi.on("session_start", () => {
		fs.writeFileSync(path.join(path.dirname(artifactPath), "ready"), "ready", { mode: 0o600 });
	});

	const finish = (fallbackError?: string) => {
		if (written) return;
		const failed = stopReason === "error" || stopReason === "aborted" || Boolean(fallbackError);
		writeArtifact(artifactPath, {
			version: 1,
			kind: "result",
			exitCode: failed ? 1 : 0,
			messages,
			usage,
			...(model ? { model } : {}),
			...(stopReason ? { stopReason } : {}),
			...(errorMessage || fallbackError ? { errorMessage: errorMessage || fallbackError } : {}),
		});
		written = true;
	};

	pi.on("message_end", (event) => {
		const message = event.message as Message | undefined;
		if (!message || message.role === "user") return;
		messages.push(message);
		if (message.role === "assistant") {
			usage.turns++;
			const current = message.usage;
			if (current) {
				usage.input += current.input || 0;
				usage.output += current.output || 0;
				usage.cacheRead += current.cacheRead || 0;
				usage.cacheWrite += current.cacheWrite || 0;
				usage.cost += current.cost?.total || 0;
				usage.contextTokens = current.totalTokens || 0;
			}
			if (message.model) model = message.model;
			if (message.stopReason) stopReason = message.stopReason;
			errorMessage = message.errorMessage;
		}
		writeArtifact(path.join(path.dirname(artifactPath), "progress.json"), {
			version: 1, kind: "progress", exitCode: 0, messages, usage, model, stopReason, errorMessage,
		});
	});

	pi.on("agent_settled", (_event, ctx) => {
		// Keep the interactive child open for inspection. Ctrl-D with an empty
		// editor exits Pi; the parent runner then closes this owned Herdr pane.
		finish();
		ctx.ui?.notify?.("Subagent complete — inspect the output above. Press Ctrl-D with an empty editor to close this pane.", "info");
	});

	pi.on("session_shutdown", (event) => {
		finish(`Subagent session closed before completion (${event.reason ?? "unknown"}).`);
	});
}
