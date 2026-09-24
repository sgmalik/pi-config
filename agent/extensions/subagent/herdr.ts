import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const commandOptions = { encoding: "utf8" as const, timeout: 5000 };

export interface PaneRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LayoutPane {
	pane_id: string;
	rect: PaneRect;
}

function command(args: string[]): any {
	const output = execFileSync("herdr", args, commandOptions).trim();
	if (!output) return undefined;
	const response = JSON.parse(output);
	if (response.error) throw new Error(response.error.message ?? "Herdr command failed");
	return response.result;
}

export function isHerdrAvailable(): boolean {
	return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_PANE_ID);
}

export function getHerdrLayout(parentPane: string): LayoutPane[] {
	const panes = command(["pane", "layout", "--pane", parentPane])?.layout?.panes;
	if (!Array.isArray(panes)) throw new Error("Herdr did not return pane layout information");
	return panes;
}

export function createHerdrPane(targetPane: string, direction: "right" | "down", cwd: string, name: string): string {
	const paneId = command(["pane", "split", targetPane, "--direction", direction, "--cwd", cwd, "--no-focus"])?.pane?.pane_id;
	if (typeof paneId !== "string" || !paneId) throw new Error("Herdr did not return the new pane ID");
	try {
		command(["pane", "rename", paneId, name]);
	} catch {
		// Labels are cosmetic.
	}
	return paneId;
}

export function runHerdrCommand(paneId: string, text: string): void {
	command(["pane", "run", paneId, text]);
}

export async function herdrPaneExists(paneId: string): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync("herdr", ["pane", "get", paneId], commandOptions);
		const response = JSON.parse(stdout);
		if (response.result?.pane?.pane_id !== paneId) throw new Error("Invalid Herdr pane response");
		return true;
	} catch (error: any) {
		for (const output of [error?.stderr, error?.stdout]) {
			try {
				const code = JSON.parse(output)?.error?.code;
				if (code === "pane_not_found" || code === "not_found") return false;
			} catch {
				// Non-JSON errors remain failures, not proof the pane disappeared.
			}
		}
		throw error;
	}
}

export function closeHerdrPane(paneId: string): void {
	command(["pane", "close", paneId]);
}
