/**
 * Shared cost utilities for extensions that need to read historical session costs.
 *
 * Used by: cost.ts (command), start-screen.ts (widget)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface CostEntry {
	cost: number;
	model: string;
	date: string;
}

export interface CostSummary {
	total: number;
	mainCost: number;
	subagentCost: number;
	mainSessions: number;
	subagentSessions: number;
	totalSessions: number;
	byDate: Record<string, number>;
	byModel: Record<string, number>;
	byProject: Record<string, number>;
}

export function extractCosts(filePath: string): CostEntry[] {
	const entries: CostEntry[] = [];
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (
					entry.type === "message" &&
					entry.message?.role === "assistant" &&
					entry.message?.usage?.cost?.total
				) {
					const date = path.basename(filePath).slice(0, 10);
					entries.push({
						cost: entry.message.usage.cost.total,
						model: entry.message.model ?? "unknown",
						date,
					});
				}
			} catch {}
		}
	} catch {}
	return entries;
}

export function findJsonlFiles(dir: string): string[] {
	const files: string[] = [];
	try {
		if (!fs.existsSync(dir)) return files;
		const walk = (d: string) => {
			for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
				const full = path.join(d, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.name.endsWith(".jsonl")) files.push(full);
			}
		};
		walk(dir);
	} catch {}
	return files;
}

export function getCutoffDate(days: number): string {
	const d = new Date();
	d.setDate(d.getDate() - days);
	return d.toISOString().slice(0, 10);
}

export function formatCost(n: number): string {
	return `$${n.toFixed(2)}`;
}

/**
 * Cache for resolved project names — avoids repeated filesystem probing.
 */
const projectNameCache = new Map<string, string>();

/**
 * Reconstruct the real filesystem path from a dash-encoded session directory name,
 * then return the basename as the project name.
 *
 * The encoding replaces "/" with "-", which is ambiguous when directory names
 * contain dashes (e.g. "BMS-POC"). We resolve the ambiguity by walking the
 * segments and probing the filesystem to find which combinations form real directories.
 *
 * e.g. "Users-sm-syc-Sycamore-agents-BMS-POC" → "/Users/sm-syc/Sycamore/agents/BMS-POC" → "BMS-POC"
 */
function resolveProjectName(encoded: string): string {
	if (projectNameCache.has(encoded)) return projectNameCache.get(encoded)!;

	const segments = encoded.split("-");
	const resolved = resolveSegments(segments, 0, "/");
	const project = (resolved ? path.basename(resolved) : segments[segments.length - 1]) || "other";
	projectNameCache.set(encoded, project);
	return project;
}

/**
 * Recursively try consuming segments as directory names, probing the filesystem
 * to resolve dash ambiguity. Returns the full resolved path, or null if no
 * valid path could be found.
 */
function resolveSegments(segments: string[], start: number, base: string): string | null {
	if (start >= segments.length) return base;

	// Try progressively longer dash-joined candidates starting from segments[start]
	let candidate = "";
	for (let end = start; end < segments.length; end++) {
		candidate = candidate ? candidate + "-" + segments[end] : segments[end];
		const candidatePath = path.join(base, candidate);

		// If this is the last segment(s), it's the leaf — accept it without stat
		if (end === segments.length - 1) {
			return candidatePath;
		}

		// Otherwise, check if this candidate exists as a directory
		let isDir = false;
		try { isDir = fs.statSync(candidatePath).isDirectory(); } catch {}

		if (isDir) {
			// Try to resolve the remaining segments from here
			const result = resolveSegments(segments, end + 1, candidatePath);
			if (result) return result;
			// If remaining segments couldn't resolve, try extending this candidate further
		}
	}

	return null;
}

/**
 * Gather cost data across all sessions for the last N days.
 */
export function gatherCosts(days: number): CostSummary {
	const cutoff = getCutoffDate(days);
	const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
	const tmpDir = process.env.TMPDIR ?? "/tmp";

	const mainFiles = findJsonlFiles(sessionsDir);

	const subagentDirs: string[] = [];
	try {
		for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
			if (entry.isDirectory() && entry.name.startsWith("pi-subagent-session-")) {
				subagentDirs.push(path.join(tmpDir, entry.name));
			}
		}
	} catch {}
	const subagentFiles = subagentDirs.flatMap(findJsonlFiles);

	let mainCost = 0;
	let subagentCost = 0;
	let mainSessions = 0;
	let subagentSessions = 0;
	const byDate: Record<string, number> = {};
	const byModel: Record<string, number> = {};
	const byProject: Record<string, number> = {};

	const processFile = (filePath: string, isSubagent: boolean) => {
		const basename = path.basename(filePath);
		const datePart = basename.slice(0, 10);
		if (datePart < cutoff) return;

		const entries = extractCosts(filePath);
		if (entries.length === 0) return;

		let sessionCost = 0;
		for (const e of entries) {
			sessionCost += e.cost;
			byDate[e.date] = (byDate[e.date] ?? 0) + e.cost;
			byModel[e.model] = (byModel[e.model] ?? 0) + e.cost;
		}

		if (isSubagent) {
			subagentCost += sessionCost;
			subagentSessions++;
		} else {
			mainCost += sessionCost;
			mainSessions++;
			// Extract project name from session directory
			// Directory names encode the cwd path with - as separator, wrapped in --
			// e.g. "--Users-sm-syc-Sycamore-agents-study_protocol_design--"
			// We reconstruct the real path by probing the filesystem to handle
			// ambiguous dashes (path separator vs part of a directory name like "BMS-POC")
			const dirName = path.basename(path.dirname(filePath));
			const encoded = dirName.replace(/^--/, "").replace(/--$/, "");
			const project = resolveProjectName(encoded);
			byProject[project] = (byProject[project] ?? 0) + sessionCost;
		}
	};

	for (const f of mainFiles) processFile(f, false);
	for (const f of subagentFiles) processFile(f, true);

	const total = mainCost + subagentCost;
	const totalSessions = mainSessions + subagentSessions;

	return { total, mainCost, subagentCost, mainSessions, subagentSessions, totalSessions, byDate, byModel, byProject };
}
