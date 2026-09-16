/**
 * Tools Extension
 *
 * Provides a /tools command to enable/disable tools interactively, and to
 * move extension files between each scope's active extensions/ directory and
 * its optional-extensions/ staging directory. Covers both project (.pi/) and
 * global (~/.pi/agent/) scopes, project shown first.
 *
 * Sections shown in /tools:
 * 1. Tools                          - built-in / package tools, not backed by
 *                                      a movable file in either scope.
 *                                      Toggling here only changes the active-
 *                                      tools list (no I/O).
 * 2. Project Active Extensions      - tools backed by a file in <cwd>/.pi/extensions/.
 * 3. Project Optional Extensions    - files sitting in <cwd>/.pi/optional-extensions/.
 * 4. Global Active Extensions       - tools backed by a file in ~/.pi/agent/extensions/.
 * 5. Global Optional Extensions     - files sitting in ~/.pi/agent/optional-extensions/.
 * 6. Project Active Agents          - .md agents in <cwd>/.pi/agents/.
 * 7. Project Optional Agents        - .md agents sitting in <cwd>/.pi/optional-agents/.
 * 8. Global Active Agents           - .md agents in ~/.pi/agent/agents/.
 * 9. Global Optional Agents         - .md agents sitting in ~/.pi/agent/optional-agents/.
 *
 * For each Active Extensions section, per-tool toggles work like section 1
 * (no I/O), and each file also gets a "move to optional" action that
 * relocates the whole file to that scope's optional-extensions/ and reloads.
 *
 * For each Optional Extensions section, a "move to active" action relocates
 * the file into that scope's extensions/ and reloads. Newly registered tools
 * default to inactive (zero context cost) until toggled on individually in
 * the matching Active section.
 *
 * Agent sections work the same way but one level simpler: each .md file is
 * exactly one agent (no per-tool sub-toggle), so "move to optional"/"move to
 * active" is the only action. The subagent tool's built-in agent discovery
 * (~/.pi/agent/agents or <cwd>/.pi/agents) only ever sees whatever .md files
 * are physically present, so moving a file out of the active dir removes it
 * from the subagent tool's schema description on next reload at zero code
 * cost, and moving it back restores it.
 *
 * Tool selection persists across session reloads and respects branch navigation.
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface ScopeDirs {
	key: "project" | "global";
	label: string;
	extDir: string;
	optionalDir: string;
}

function scopesFor(cwd: string): ScopeDirs[] {
	return [
		{
			key: "project",
			label: "Project",
			extDir: path.join(cwd, ".pi", "extensions"),
			optionalDir: path.join(cwd, ".pi", "optional-extensions"),
		},
		{
			key: "global",
			label: "Global",
			extDir: path.join(os.homedir(), ".pi", "agent", "extensions"),
			optionalDir: path.join(os.homedir(), ".pi", "agent", "optional-extensions"),
		},
	];
}

function tildeify(p: string): string {
	const home = os.homedir();
	return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

interface AgentScopeDirs {
	key: "project" | "global";
	label: string;
	agentsDir: string;
	optionalAgentsDir: string;
}

function agentScopesFor(cwd: string): AgentScopeDirs[] {
	return [
		{
			key: "project",
			label: "Project",
			agentsDir: path.join(cwd, ".pi", "agents"),
			optionalAgentsDir: path.join(cwd, ".pi", "optional-agents"),
		},
		{
			key: "global",
			label: "Global",
			agentsDir: path.join(os.homedir(), ".pi", "agent", "agents"),
			optionalAgentsDir: path.join(os.homedir(), ".pi", "agent", "optional-agents"),
		},
	];
}

function isAgentFile(name: string): boolean {
	return name.endsWith(".md") && !name.startsWith(".");
}

function listAgentFiles(dir: string): string[] {
	try {
		return fs.readdirSync(dir).filter(isAgentFile).sort();
	} catch {
		return [];
	}
}

// Best-effort read of an agent .md file's frontmatter name/description, for
// display only - the move action still operates on the whole file.
function scanAgentMeta(filePath: string): { name?: string; description?: string } {
	try {
		const src = fs.readFileSync(filePath, "utf8");
		const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
		if (!fm) return {};
		const nameMatch = /^name:\s*(.+)$/m.exec(fm[1]);
		const descMatch = /^description:\s*(.+)$/m.exec(fm[1]);
		return {
			name: nameMatch?.[1]?.trim(),
			description: descMatch?.[1]?.trim(),
		};
	} catch {
		return {};
	}
}

// State persisted to session
interface ToolsState {
	enabledTools: string[];
}

// Tools disabled by default on a brand-new session/branch with no prior
// tools-config entry. Currently: Context7 doc lookups, which cost schema
// tokens every turn and can inject large doc-snippet payloads into history
// on top of that - opt in per-session via /tools when actually needed.
const DEFAULT_DISABLED_TOOLS = new Set(["resolve-library-id", "query-docs"]);

function isExtensionFile(name: string): boolean {
	return (name.endsWith(".ts") || name.endsWith(".js")) && !name.startsWith(".");
}

function listDirFiles(dir: string): string[] {
	try {
		return fs.readdirSync(dir).filter(isExtensionFile).sort();
	} catch {
		return [];
	}
}

// Best-effort static scan of an unloaded file to label what it would register,
// without executing it. Purely cosmetic - the move action still operates on
// the whole file regardless of what this finds.
function scanProvides(filePath: string): string[] {
	try {
		const src = fs.readFileSync(filePath, "utf8");
		const names = new Set<string>();
		const toolRe = /registerTool\(\s*\{[^}]*?name:\s*["'`]([^"'`]+)["'`]/gs;
		const cmdRe = /registerCommand\(\s*["'`]([^"'`]+)["'`]/g;
		let m: RegExpExecArray | null;
		while ((m = toolRe.exec(src))) names.add(m[1]);
		while ((m = cmdRe.exec(src))) names.add(`/${m[1]}`);
		return Array.from(names);
	} catch {
		return [];
	}
}

function moveFile(from: string, to: string) {
	fs.mkdirSync(path.dirname(to), { recursive: true });
	fs.renameSync(from, to);
}

export default function toolsExtension(pi: ExtensionAPI) {
	// Track enabled tools
	let enabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];

	// Persist current state
	function persistState() {
		pi.appendEntry<ToolsState>("tools-config", {
			enabledTools: Array.from(enabledTools),
		});
	}

	// Apply current tool selection
	function applyTools() {
		pi.setActiveTools(Array.from(enabledTools));
	}

	// Find the last tools-config entry in the current branch
	function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools();

		// Get entries in current branch only
		const branchEntries = ctx.sessionManager.getBranch();
		let savedTools: string[] | undefined;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && entry.customType === "tools-config") {
				const data = entry.data as ToolsState | undefined;
				if (data?.enabledTools) {
					savedTools = data.enabledTools;
				}
			}
		}

		if (savedTools) {
			// Restore saved tool selection (filter to only tools that still exist)
			const allToolNames = allTools.map((t) => t.name);
			enabledTools = new Set(savedTools.filter((t: string) => allToolNames.includes(t)));
			applyTools();
		} else {
			// No saved state - sync with currently active tools, minus defaults-off
			enabledTools = new Set(pi.getActiveTools().filter((t) => !DEFAULT_DISABLED_TOOLS.has(t)));
			applyTools();
			persistState();
		}
	}

	// Group currently-registered tools by the extensions/ file (within extDir) that provides them.
	// Excludes built-ins and package-sourced tools (anything not under extDir).
	function fileBackedToolsByPath(extDir: string): Map<string, ToolInfo[]> {
		const map = new Map<string, ToolInfo[]>();
		for (const tool of allTools) {
			const p = tool.sourceInfo?.path;
			if (!p) continue;
			const resolved = path.resolve(p);
			if (resolved !== extDir && !resolved.startsWith(extDir + path.sep)) continue;
			const list = map.get(resolved) ?? [];
			list.push(tool);
			map.set(resolved, list);
		}
		return map;
	}

	// Register /tools command
	pi.registerCommand("tools", {
		description: "Enable/disable tools, move extension files between active/optional (project + global)",
		handler: async (_args, ctx) => {
			// Refresh tool list
			allTools = pi.getAllTools();
			const scopes = scopesFor(ctx.cwd);
			const agentScopes = agentScopesFor(ctx.cwd);

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const header = (label: string): SettingItem => ({
					id: `__header__${label}`,
					label,
					currentValue: "",
				});

				function buildItems(): SettingItem[] {
					const items: SettingItem[] = [];

					const perScopeFileBacked = new Map<string, Map<string, ToolInfo[]>>();
					const fileBackedNames = new Set<string>();
					for (const s of scopes) {
						const map = fileBackedToolsByPath(s.extDir);
						perScopeFileBacked.set(s.key, map);
						for (const list of map.values()) {
							for (const t of list) fileBackedNames.add(t.name);
						}
					}

					items.push(header("── Tools ──"));
					for (const tool of allTools.filter((t) => !fileBackedNames.has(t.name))) {
						items.push({
							id: tool.name,
							label: tool.name,
							currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
							values: ["enabled", "disabled"],
						});
					}

					for (const s of scopes) {
						const fileBacked = perScopeFileBacked.get(s.key)!;

						items.push(header(`── ${s.label} Active Extensions (${tildeify(s.extDir)}) ──`));
						if (fileBacked.size === 0) {
							items.push({ id: `__none_active_${s.key}__`, label: "(none)", currentValue: "" });
						}
						for (const [filePath, tools] of fileBacked) {
							const fileName = path.basename(filePath);
							for (const tool of tools) {
								items.push({
									id: `active-tool::${tool.name}`,
									label: `  ${fileName} → ${tool.name}`,
									currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
									values: ["enabled", "disabled"],
								});
							}
							items.push({
								id: `move-to-optional::${s.key}::${fileName}`,
								label: `  ↳ ${fileName} (whole file)`,
								currentValue: "active",
								values: ["active", "move to optional"],
							});
						}

						items.push(header(`── ${s.label} Optional Extensions (${tildeify(s.optionalDir)}) ──`));
						const optionalFiles = listDirFiles(s.optionalDir);
						if (optionalFiles.length === 0) {
							items.push({ id: `__none_optional_${s.key}__`, label: "(none)", currentValue: "" });
						}
						for (const fileName of optionalFiles) {
							const fullPath = path.join(s.optionalDir, fileName);
							const provides = scanProvides(fullPath);
							const label = provides.length
								? `${fileName} (provides: ${provides.join(", ")})`
								: fileName;
							items.push({
								id: `move-to-active::${s.key}::${fileName}`,
								label,
								currentValue: "inactive",
								values: ["inactive", "move to active"],
							});
						}
					}

					for (const s of agentScopes) {
						items.push(header(`── ${s.label} Active Agents (${tildeify(s.agentsDir)}) ──`));
						const activeAgentFiles = listAgentFiles(s.agentsDir);
						if (activeAgentFiles.length === 0) {
							items.push({ id: `__none_active_agents_${s.key}__`, label: "(none)", currentValue: "" });
						}
						for (const fileName of activeAgentFiles) {
							const fullPath = path.join(s.agentsDir, fileName);
							const meta = scanAgentMeta(fullPath);
							const label = meta.name
								? `${meta.name}${meta.description ? ` — ${meta.description}` : ""}`
								: fileName;
							items.push({
								id: `agent-move-to-optional::${s.key}::${fileName}`,
								label,
								currentValue: "active",
								values: ["active", "move to optional"],
							});
						}

						items.push(header(`── ${s.label} Optional Agents (${tildeify(s.optionalAgentsDir)}) ──`));
						const optionalAgentFiles = listAgentFiles(s.optionalAgentsDir);
						if (optionalAgentFiles.length === 0) {
							items.push({ id: `__none_optional_agents_${s.key}__`, label: "(none)", currentValue: "" });
						}
						for (const fileName of optionalAgentFiles) {
							const fullPath = path.join(s.optionalAgentsDir, fileName);
							const meta = scanAgentMeta(fullPath);
							const label = meta.name
								? `${meta.name}${meta.description ? ` — ${meta.description}` : ""}`
								: fileName;
							items.push({
								id: `agent-move-to-active::${s.key}::${fileName}`,
								label,
								currentValue: "inactive",
								values: ["inactive", "move to active"],
							});
						}
					}

					return items;
				}

				const container = new Container();
				container.addChild(
					new (class {
						render(_width: number) {
							return [theme.fg("accent", theme.bold("Tool Configuration")), ""];
						}
						invalidate() {}
					})(),
				);

				function onChange(id: string, newValue: string) {
					if (id.startsWith("agent-move-to-optional::") || id.startsWith("agent-move-to-active::")) {
						const toOptional = id.startsWith("agent-move-to-optional::");
						const [, scopeKey, fileName] = id.split("::");
						const s = agentScopes.find((sc) => sc.key === scopeKey);
						if (!s) return;

						const from = toOptional ? path.join(s.agentsDir, fileName) : path.join(s.optionalAgentsDir, fileName);
						const to = toOptional ? path.join(s.optionalAgentsDir, fileName) : path.join(s.agentsDir, fileName);

						try {
							moveFile(from, to);
							done(undefined);
							ctx.ui.notify(
								`${toOptional ? "Deactivated" : "Activated"} agent ${fileName} (${s.label}). Reloading extensions…`,
								"info",
							);
							void ctx.reload().then(() => {
								ctx.ui.notify(`Reloaded. Run /tools again to review agents.`, "info");
							});
						} catch (err) {
							ctx.ui.notify(`Failed to move ${fileName}: ${(err as Error).message}`, "error");
						}
						return;
					}

					if (id.startsWith("move-to-optional::") || id.startsWith("move-to-active::")) {
						const toOptional = id.startsWith("move-to-optional::");
						const [, scopeKey, fileName] = id.split("::");
						const s = scopes.find((sc) => sc.key === scopeKey);
						if (!s) return;

						const from = toOptional ? path.join(s.extDir, fileName) : path.join(s.optionalDir, fileName);
						const to = toOptional ? path.join(s.optionalDir, fileName) : path.join(s.extDir, fileName);

						try {
							if (toOptional) {
								// Drop this file's tools from the active set before it disappears.
								for (const [filePath, tools] of fileBackedToolsByPath(s.extDir)) {
									if (path.basename(filePath) === fileName) {
										for (const t of tools) enabledTools.delete(t.name);
									}
								}
								persistState();
							}
							moveFile(from, to);
							done(undefined);
							ctx.ui.notify(
								`${toOptional ? "Deactivated" : "Activated"} ${fileName} (${s.label}). Reloading extensions…`,
								"info",
							);
							void ctx.reload().then(() => {
								ctx.ui.notify(`Reloaded. Run /tools again to review ${fileName}'s tools.`, "info");
							});
						} catch (err) {
							ctx.ui.notify(`Failed to move ${fileName}: ${(err as Error).message}`, "error");
						}
						return;
					}

					const toolName = id.startsWith("active-tool::") ? id.slice("active-tool::".length) : id;
					if (newValue === "enabled") {
						enabledTools.add(toolName);
					} else {
						enabledTools.delete(toolName);
					}
					applyTools();
					persistState();
				}

				const items = buildItems();
				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 20),
					getSettingsListTheme(),
					onChange,
					() => done(undefined),
				);

				container.addChild(settingsList);

				const component = {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};

				return component;
			});
		},
	});

	// Restore state on session start
	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	// Restore state when navigating the session tree
	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	// Restore state after forking
	pi.on("session_fork", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
}
