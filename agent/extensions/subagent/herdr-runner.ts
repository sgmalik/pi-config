import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import * as herdr from "./herdr.ts";
import type { LayoutPane, PaneRect } from "./herdr.ts";

export interface HerdrArtifact {
	version: 1;
	kind: "result" | "progress";
	exitCode: number;
	messages: Message[];
	usage?: {
		input: number; output: number; cacheRead: number; cacheWrite: number;
		cost: number; contextTokens: number; turns: number;
	};
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface HerdrRunOptions {
	name: string;
	cwd: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	artifactDir: string;
	signal?: AbortSignal;
	onProgress?: (artifact: HerdrArtifact) => void;
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function choosePaneSplit(parentPane: string, owned: Set<string>, layout: LayoutPane[], original: PaneRect) {
	if (!layout.some((pane) => pane.pane_id === parentPane)) throw new Error("Parent Herdr pane is no longer present");
	const candidates = layout.filter((pane) => pane.pane_id === parentPane || owned.has(pane.pane_id));
	const largest = candidates.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0];
	const direction = owned.size === 0 ? "down"
		: largest.rect.width / original.width >= largest.rect.height / original.height ? "right" : "down";
	return { target: largest.pane_id, direction: direction as "down" | "right" };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const onAbort = () => { clearTimeout(timer); reject(new Error("Subagent was aborted")); };
		const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function readArtifact(file: string): HerdrArtifact | undefined {
	if (!fs.existsSync(file)) return undefined;
	const value = JSON.parse(fs.readFileSync(file, "utf8")) as HerdrArtifact;
	if (value.version !== 1 || !["result", "progress"].includes(value.kind) || !Array.isArray(value.messages)) {
		throw new Error("Invalid child result artifact");
	}
	return value;
}

export class HerdrRunner {
	readonly maxChildren = 3;
	private readonly panes = new Set<string>();
	private readonly shutdown = new AbortController();
	private activeSlots = 0;
	private original?: PaneRect;
	private cleanupError?: Error;
	private readonly retained = new Set<string>();

	constructor(
		private readonly api = herdr,
		private readonly parentPane = process.env.HERDR_PANE_ID ?? "",
		private readonly timings = { poll: 250, shellReady: 500, startup: 60_000, queryFailure: 10_000, exit: 10_000 },
	) {}

	closeAll(): void {
		this.shutdown.abort(new Error("Subagent runner shut down"));
		for (const pane of [...this.panes].reverse()) this.closePane(pane);
	}

	private releaseSlot(): void {
		this.activeSlots = Math.max(0, this.activeSlots - 1);
	}

	private closePane(pane: string): void {
		if (!this.panes.has(pane)) return;
		try {
			this.api.closeHerdrPane(pane);
			this.panes.delete(pane);
			this.retained.delete(pane);
		} catch (error) {
			// Keep ownership so shutdown can retry; never silently claim cleanup succeeded.
			this.cleanupError = new Error(`Could not close subagent pane ${pane}: ${String(error)}`);
			console.error(this.cleanupError.message);
		}
	}

	private async createPane(options: HerdrRunOptions, signal: AbortSignal): Promise<string> {
		for (;;) {
			signal.throwIfAborted();
			if (this.cleanupError) throw this.cleanupError;
			const layout = this.api.getHerdrLayout(this.parentPane);
			for (const id of this.panes) if (!layout.some((pane) => pane.pane_id === id)) this.panes.delete(id);
			const parent = layout.find((pane) => pane.pane_id === this.parentPane);
			if (!parent) throw new Error("Parent Herdr pane is no longer present");
			if (this.panes.size === 0) this.original = parent.rect;
			if (layout.length < 4) {
				const split = choosePaneSplit(this.parentPane, this.panes, layout, this.original!);
				const pane = this.api.createHerdrPane(split.target, split.direction, options.cwd, options.name);
				this.panes.add(pane);
				return pane;
			}
			if (this.panes.size === 0) throw new Error("Herdr tab already has four panes; close a pane before delegating");
			await delay(this.timings.poll, signal);
		}
	}

	private retainUntilClosed(pane: string, exitFile: string): void {
		this.retained.add(pane);
		void (async () => {
			try {
				for (;;) {
					if (fs.existsSync(exitFile) || !(await this.api.herdrPaneExists(pane))) break;
					await new Promise((resolve) => setTimeout(resolve, this.timings.poll));
				}
			} catch (error) {
				console.error(`Could not monitor completed subagent pane ${pane}: ${String(error)}`);
			} finally {
				this.closePane(pane);
				try {
					fs.rmSync(path.dirname(exitFile), { recursive: true, force: true });
				} catch (error) {
					console.error(`Could not remove subagent artifacts: ${String(error)}`);
				}
				this.releaseSlot();
			}
		})();
	}

	async run(options: HerdrRunOptions): Promise<HerdrArtifact> {
		const signal = AbortSignal.any([this.shutdown.signal, ...(options.signal ? [options.signal] : [])]);
		while (this.activeSlots >= this.maxChildren) await delay(this.timings.poll, signal);
		signal.throwIfAborted();
		this.activeSlots++;
		let pane: string | undefined;
		let retained = false;
		try {
			const resultFile = path.join(options.artifactDir, "result.json");
			const progressFile = path.join(options.artifactDir, "progress.json");
			const readyFile = path.join(options.artifactDir, "ready");
			const exitFile = path.join(options.artifactDir, "exit");
			const scriptFile = path.join(options.artifactDir, "launch.sh");
			fs.mkdirSync(options.artifactDir, { recursive: true, mode: 0o700 });
			const env = { ...options.env, PI_SUBAGENT_RESULT_FILE: resultFile };
			const assignments = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
			const invocation = [shellQuote(options.command), ...options.args.map(shellQuote)].join(" ");
			fs.writeFileSync(scriptFile, [
				"#!/bin/bash", "set +e", `cd ${shellQuote(options.cwd)} || exit 1`,
				`${assignments} ${invocation}`, "status=$?",
				`printf '%s' "$status" > ${shellQuote(`${exitFile}.tmp`)}`,
				`mv ${shellQuote(`${exitFile}.tmp`)} ${shellQuote(exitFile)}`, "",
			].join("\n"), { mode: 0o700 });

			pane = await this.createPane(options, signal);
			await delay(this.timings.shellReady, signal);
			this.api.runHerdrCommand(pane, `bash ${shellQuote(scriptFile)}`);
			const started = Date.now();
			let resultAt: number | undefined;
			let queryFailureAt: number | undefined;
			let progressText = "";
			for (;;) {
				signal.throwIfAborted();
				if (fs.existsSync(progressFile)) {
					const text = fs.readFileSync(progressFile, "utf8");
					if (text !== progressText) {
						progressText = text;
						const progress = readArtifact(progressFile);
						if (progress) options.onProgress?.(progress);
					}
				}
				const artifact = readArtifact(resultFile);
				if (artifact) resultAt ??= Date.now();
				if (artifact) {
					retained = true;
					this.retainUntilClosed(pane, exitFile);
					return artifact;
				}
				if (fs.existsSync(exitFile)) {
					const exitCode = Number(fs.readFileSync(exitFile, "utf8"));
					throw new Error(`Interactive child exited without a result (exit ${exitCode})`);
				}
				if (resultAt && Date.now() - resultAt > this.timings.exit) throw new Error("Child completed but failed to shut down");
				if (!fs.existsSync(readyFile) && Date.now() - started > this.timings.startup) {
					throw new Error("Interactive child did not start within 60 seconds; inspect Pi startup/trust configuration");
				}
				let exists: boolean;
				try {
					exists = await this.api.herdrPaneExists(pane);
					queryFailureAt = undefined;
				} catch (error) {
					queryFailureAt ??= Date.now();
					if (Date.now() - queryFailureAt > this.timings.queryFailure) throw error;
					await delay(this.timings.poll, signal);
					continue;
				}
				if (!exists) {
					this.panes.delete(pane);
					if (artifact) return artifact;
					throw new Error("Subagent pane was closed before completion");
				}
				await delay(this.timings.poll, signal);
			}
		} finally {
			if (!retained) {
				if (pane) this.closePane(pane);
				this.releaseSlot();
			}
		}
	}
}
