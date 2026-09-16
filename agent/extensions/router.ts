/**
 * Provider-aware Model Router Extension
 *
 * Routing uses provider-neutral tiers from ~/.pi/agent/router-models.json:
 *   fast      — cheap/simple work
 *   balanced  — default production work
 *   strong    — complex implementation/security/architecture
 *   planner   — /plan only, highest-reasoning planning tier
 *
 * Commands:
 *   /plan <task>        Plan on configured planner tier, then drop to floor
 *   /fast               Pin fast tier
 *   /balanced           Pin balanced tier
 *   /strong             Pin strong tier
 *   /router ...         status/profile/floor/auto/escalate/reset/validate/log
 *   /routes             Full command reference
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Tier = "fast" | "balanced" | "strong" | "planner";
type FloorTier = Exclude<Tier, "planner">;

interface TierConfig {
	id: string;
	label: string;
	cost?: string;
	overrides?: Record<string, any>;
}

interface ProviderProfile {
	provider: string;
	defaultFloor: FloorTier;
	planningTier: Tier;
	compactionTier?: Tier;
	tiers: Record<Tier, TierConfig>;
}

interface RouterConfig {
	activeProfile: string;
	profiles: Record<string, ProviderProfile>;
}

const CONFIG_PATH = path.join(homedir(), ".pi", "agent", "router-models.json");
const AGENT_DIR = path.join(homedir(), ".pi", "agent", "agents");
const PROVIDER_AGENTS_DIR = path.join(homedir(), ".pi", "agent", "provider-agents");
const TIER_ORDER: Tier[] = ["fast", "balanced", "strong", "planner"];
const FLOOR_CHOICES: FloorTier[] = ["fast", "balanced", "strong"];

function loadConfig(): RouterConfig {
	return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function saveConfig(config: RouterConfig) {
	fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function activeProfile(config = loadConfig()): ProviderProfile {
	const profile = config.profiles[config.activeProfile];
	if (!profile) throw new Error(`Active router profile not found: ${config.activeProfile}`);
	return profile;
}

function tierLabel(tier: Tier, profile = activeProfile()): string {
	return profile.tiers[tier]?.label ?? tier;
}

function tierCost(tier: Tier, profile = activeProfile()): string {
	return profile.tiers[tier]?.cost ?? "cost unknown";
}

function nextTier(from: Tier): Tier | null {
	const idx = TIER_ORDER.indexOf(from);
	if (idx < 0 || idx >= TIER_ORDER.length - 1) return null;
	return TIER_ORDER[idx + 1];
}

function isFloorTier(tier: string): tier is FloorTier {
	return (FLOOR_CHOICES as string[]).includes(tier);
}

function tierIndex(tier: Tier): number {
	return TIER_ORDER.indexOf(tier);
}

function isTierAtOrAbove(tier: Tier, floor: Tier): boolean {
	return tierIndex(tier) >= tierIndex(floor);
}

function extractLastAssistantText(messages: any[]): string {
	const assistant = messages.filter((m) => m?.role === "assistant");
	if (assistant.length === 0) return "";
	const last = assistant[assistant.length - 1];
	if (typeof last.content === "string") return last.content;
	if (Array.isArray(last.content)) {
		return last.content
			.filter((b: any) => b?.type === "text" && b.text)
			.map((b: any) => b.text)
			.join("\n");
	}
	return "";
}

function parseSubagentTasks(text: string): Array<{ agent: Tier; task: string }> {
	const tasks: Array<{ agent: Tier; task: string }> = [];
	for (const line of text.split("\n")) {
		const m = line.match(/SUBAGENT_TASK:\s*agent:(fast|balanced|strong|planner)\s+task:"([^"]+)"/i);
		if (m) tasks.push({ agent: m[1].toLowerCase() as Tier, task: m[2] });
	}
	return tasks;
}

function parseFloor(text: string): FloorTier | null {
	const m = text.match(/IMPLEMENTATION_FLOOR:\s*(fast|balanced|strong)/i);
	if (!m) return null;
	const tier = m[1].toLowerCase();
	return isFloorTier(tier) ? tier : null;
}

function syncActiveTierAgents(profileName: string): string[] {
	const sourceDir = path.join(PROVIDER_AGENTS_DIR, profileName);
	const changed: string[] = [];
	if (!fs.existsSync(sourceDir)) throw new Error(`Provider agent directory not found: ${sourceDir}`);
	fs.mkdirSync(AGENT_DIR, { recursive: true });

	for (const tier of TIER_ORDER) {
		const source = path.join(sourceDir, `${tier}.md`);
		const target = path.join(AGENT_DIR, `${tier}.md`);
		if (!fs.existsSync(source)) throw new Error(`Provider agent missing: ${source}`);
		const sourceContent = fs.readFileSync(source, "utf-8");
		const targetContent = fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : undefined;
		if (sourceContent !== targetContent) {
			fs.writeFileSync(target, sourceContent);
			changed.push(`${tier}.md`);
		}
	}
	return changed;
}

function validationErrors(ctx: any, config = loadConfig(), validateAll = false): string[] {
	const errors: string[] = [];
	if (!config.profiles[config.activeProfile]) errors.push(`activeProfile '${config.activeProfile}' does not exist`);

	const profiles = validateAll
		? Object.entries(config.profiles)
		: Object.entries(config.profiles).filter(([name]) => name === config.activeProfile);
	for (const [profileName, profile] of profiles) {
		if (!profile.provider) errors.push(`${profileName}: provider is missing`);
		if (!isFloorTier(profile.defaultFloor)) errors.push(`${profileName}: defaultFloor must be ${FLOOR_CHOICES.join("|")}`);
		if (!TIER_ORDER.includes(profile.planningTier)) errors.push(`${profileName}: planningTier is invalid`);
		for (const tier of TIER_ORDER) {
			const tierConfig = profile.tiers?.[tier];
			if (!tierConfig?.id) {
				errors.push(`${profileName}.${tier}: id is missing`);
				continue;
			}
			const found = ctx.modelRegistry?.find?.(profile.provider, tierConfig.id);
			if (!found) errors.push(`${profileName}.${tier}: ${profile.provider}/${tierConfig.id} not found in model registry`);
		}
	}
	return errors;
}

function planFraming(profile: ProviderProfile): string {
	return `[PLANNING MODE — ${tierLabel(profile.planningTier, profile)}]
Analyze the user's intent and produce a task manifest. Do NOT edit or write any files yet — this turn is planning only.

1. Restate the goal and any hard constraints in plain terms.
2. Investigate the relevant code as needed (read-only tools).
3. Produce a numbered implementation plan under a "Plan:" header.
4. On the FINAL line, emit exactly one of the following, choosing the MINIMUM model tier the implementation work will require:
     IMPLEMENTATION_FLOOR: fast      (trivial edits, renames, boilerplate, docs, simple recon)
     IMPLEMENTATION_FLOOR: balanced  (routine implementation, straightforward debugging, normal tests)
     IMPLEMENTATION_FLOOR: strong    (architecture, security, concurrency, cross-cutting or multi-file changes)

5. Below the floor marker, suggest specific subagent tasks AT OR ABOVE the floor tier:
     SUBAGENT_TASK: agent:fast task:"<subtask>"      (only if floor is fast)
     SUBAGENT_TASK: agent:balanced task:"<subtask>"  (only if floor is fast or balanced)
     SUBAGENT_TASK: agent:strong task:"<subtask>"    (for complex implementation/review)
     SUBAGENT_TASK: agent:planner task:"<subtask>"   (for planning/risk analysis harder than the floor)
     (one per line, as many as needed)

The floor is the MINIMUM tier for the work. Suggest subagents at or above that tier to parallelize focused aspects. Subagent suggestions weaker than the floor will be ignored.`;
}

export default function (pi: ExtensionAPI) {
	let config = loadConfig();
	let profile = activeProfile(config);
	let currentProfileName = config.activeProfile;
	let currentTier: Tier = profile.defaultFloor;
	let floorTier: FloorTier = profile.defaultFloor;
	let pinnedTier: Tier | null = null;
	let planningActive = false;
	let routerEnabled = true;
	let consecutiveErrors = 0;
	let sessionRouteLog: Array<{ time: string; from: Tier; to: Tier; reason: string }> = [];

	function reloadConfig() {
		config = loadConfig();
		profile = activeProfile(config);
	}

	function modelForTier(tier: Tier, ctx: any): any | null {
		const tierConfig = profile.tiers[tier];
		const found = ctx.modelRegistry?.find?.(profile.provider, tierConfig.id);
		if (!found) return null;
		return { ...found, ...tierConfig.overrides };
	}

	async function setTier(tier: Tier, reason: string, ctx: any): Promise<boolean> {
		reloadConfig();
		if (tier === currentTier && currentProfileName === config.activeProfile) return true;

		const tierConfig = profile.tiers[tier];
		const model = modelForTier(tier, ctx);
		if (!model) {
			ctx.ui?.notify?.(
				`Router: model not found for ${config.activeProfile}.${tier}: ${profile.provider}/${tierConfig.id}. Run /router validate.`,
				"error",
			);
			return false;
		}

		try {
			const result = await pi.setModel(model);
			if (result === false) {
				ctx.ui?.notify?.(`Router: setModel returned false for ${tierLabel(tier, profile)}`, "warning");
				return false;
			}
			const oldTier = currentTier;
			currentTier = tier;
			currentProfileName = config.activeProfile;
			sessionRouteLog.push({ time: new Date().toLocaleTimeString(), from: oldTier, to: tier, reason });
			return true;
		} catch (err: any) {
			ctx.ui?.notify?.(`Router setModel failed: ${err?.message || err}`, "warning");
			return false;
		}
	}

	function restingTier(): Tier {
		return pinnedTier ?? floorTier;
	}

	function setRouterStatus(ctx: any, suffix = "") {
		ctx.ui?.setStatus?.("router", `${tierLabel(currentTier, profile)}${suffix}`);
	}

	pi.on("session_start", (_event: any, ctx: any) => {
		reloadConfig();
		consecutiveErrors = 0;
		planningActive = false;
		sessionRouteLog = [];
		pinnedTier = null;
		floorTier = profile.defaultFloor;

		try {
			const changed = syncActiveTierAgents(config.activeProfile);
			if (changed.length > 0) ctx.ui?.notify?.(`Router synced ${config.activeProfile} tier agents: ${changed.join(", ")}`, "info");
		} catch (err: any) {
			ctx.ui?.notify?.(`Router agent sync failed: ${err?.message || err}`, "warning");
		}

		const modelId = ctx.model?.id ?? "";
		const launch = (Object.entries(profile.tiers) as [Tier, TierConfig][]).find(([, t]) => t.id === modelId)?.[0];
		currentProfileName = config.activeProfile;
		currentTier = launch ?? profile.defaultFloor;
		if (launch && isFloorTier(launch)) {
			floorTier = launch;
			pinnedTier = launch;
		}
		setRouterStatus(ctx);
	});

	pi.on("before_agent_start", async (_event: any, ctx: any) => {
		if (!routerEnabled) return;
		if (planningActive) return;
		consecutiveErrors = 0;

		const target = restingTier();
		const reason = pinnedTier ? `pinned (${pinnedTier})` : `floor (${floorTier})`;
		const switched = await setTier(target, reason, ctx);
		if (switched) setRouterStatus(ctx);
	});

	pi.on("agent_end", async (event: any, ctx: any) => {
		if (!planningActive) return;
		planningActive = false;

		const text = extractLastAssistantText(event.messages ?? []);
		const parsed = parseFloor(text);
		const subagentTasks = parseSubagentTasks(text);

		floorTier = parsed ?? "strong";
		pinnedTier = null;

		const switched = await setTier(floorTier, `plan floor: ${floorTier}`, ctx);
		if (switched) setRouterStatus(ctx);

		const validTasks = subagentTasks.filter(({ agent }) => isTierAtOrAbove(agent, floorTier));
		const floorMsg = `📋 Plan ready. Floor → ${tierLabel(floorTier, profile)}${parsed ? "" : " (default — no marker found)"}.`;

		if (validTasks.length === 0) {
			ctx.ui?.notify?.(`${floorMsg} Auto-routing resumed.`, "info");
			return;
		}

		ctx.ui?.notify?.(floorMsg, "info");
		const summary = validTasks.map((t, i) => `${i + 1}. [${t.agent}] ${t.task}`).join("\n\n");
		const runNow = ctx.ui?.confirm
			? await ctx.ui.confirm(`Run ${validTasks.length} subagent task${validTasks.length > 1 ? "s" : ""} in parallel?`, summary)
			: false;

		if (runNow) {
			const taskLines = validTasks
				.map((t) => `  - agent: "${t.agent}", task: "${t.task.replace(/"/g, '\\"')}"`)
				.join("\n");
			pi.sendUserMessage(
				[
					"Execute the following subagent tasks in PARALLEL using the subagent tool's `tasks` array (one tool call, all tasks together):",
					taskLines,
				].join("\n"),
				{ deliverAs: "followUp" },
			);
		} else {
			ctx.ui?.notify?.("Continuing without subagents.", "info");
		}
	});

	pi.on("tool_result", async (event: any, ctx: any) => {
		if (!routerEnabled || pinnedTier || planningActive) return;
		if (event.isError) {
			consecutiveErrors++;
			if (consecutiveErrors >= 2) {
				const next = nextTier(currentTier);
				if (next) {
					const switched = await setTier(next, `${consecutiveErrors} consecutive errors`, ctx);
					if (switched) {
						ctx.ui?.notify?.(`⬆️ Escalated → ${tierLabel(next, profile)} (${consecutiveErrors} errors)`, "warning");
						consecutiveErrors = 0;
					}
				}
			}
		} else {
			consecutiveErrors = Math.max(0, consecutiveErrors - 1);
		}
	});

	pi.registerCommand("plan", {
		description: "Plan a task on the configured planner tier, then auto-downgrade to the assessed implementation floor. Usage: /plan <task>",
		handler: async (args, ctx) => {
			const task = (args || "").trim();
			if (!task) {
				ctx.ui.notify("Usage: /plan <task>", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy. Wait for the current task to finish.", "warning");
				return;
			}

			reloadConfig();
			planningActive = true;
			pinnedTier = null;
			const switched = await setTier(profile.planningTier, "planning", ctx);
			if (switched) ctx.ui?.setStatus?.("router", `${tierLabel(profile.planningTier, profile)} (planning)`);
			pi.sendUserMessage([planFraming(profile), "", `Task: ${task}`].join("\n"));
		},
	});

	function registerPin(command: FloorTier) {
		pi.registerCommand(command, {
			description: `Pin to ${command} tier (${tierLabel(command, profile)}) — sticky until /router auto`,
			handler: async (_args, ctx) => {
				pinnedTier = command;
				await setTier(command, `manual /${command}`, ctx);
				ctx.ui.notify(`🎯 Pinned to ${tierLabel(command, profile)} — auto-routing paused (/router auto to resume)`, "info");
			},
		});
	}
	registerPin("fast");
	registerPin("balanced");
	registerPin("strong");

	pi.registerCommand("router", {
		description: "Model router controls. Usage: /router [status|profile <name>|profiles|validate|on|off|escalate|floor <name>|auto|log|reset|sync-agents]",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			const subcommand = parts[0]?.toLowerCase() || "status";
			reloadConfig();

			switch (subcommand) {
				case "status": {
					const mode = planningActive
						? "planning"
						: pinnedTier
							? `pinned (${tierLabel(pinnedTier, profile)})`
							: routerEnabled
								? "auto"
								: "paused";
					const lines = [
						`🔀 **Model Router**`,
						``,
						`   Profile: ${config.activeProfile} (${profile.provider})`,
						`   Mode:    ${mode}`,
						`   Tier:    ${tierLabel(currentTier, profile)}`,
						`   Floor:   ${tierLabel(floorTier, profile)}`,
						`   Cost:    ${tierCost(currentTier, profile)}`,
						`   Errors:  ${consecutiveErrors} consecutive`,
						`   Routes:  ${sessionRouteLog.length} this session`,
						``,
						`   Tiers:`,
						...TIER_ORDER.map((t) => {
							const cfg = profile.tiers[t];
							return `     ${t === currentTier ? "→" : " "} ${t.padEnd(8)} ${cfg.label.padEnd(24)} ${cfg.id}`;
						}),
					];
					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}

				case "profiles":
					ctx.ui.notify(`Profiles: ${Object.keys(config.profiles).join(", ")}\nActive: ${config.activeProfile}`, "info");
					break;

				case "profile": {
					const nextProfile = parts[1];
					if (!nextProfile) {
						ctx.ui.notify(`Active profile: ${config.activeProfile}. Available: ${Object.keys(config.profiles).join(", ")}`, "info");
						return;
					}
					if (!config.profiles[nextProfile]) {
						ctx.ui.notify(`Unknown profile '${nextProfile}'. Available: ${Object.keys(config.profiles).join(", ")}`, "error");
						return;
					}
					const previousProfile = config.activeProfile;
					config.activeProfile = nextProfile;
					const errors = validationErrors(ctx, config, false);
					if (errors.length > 0) {
						config.activeProfile = previousProfile;
						ctx.ui.notify(`Cannot switch to '${nextProfile}':\n${errors.map((e) => `  - ${e}`).join("\n")}`, "error");
						return;
					}
					saveConfig(config);
					reloadConfig();
					floorTier = profile.defaultFloor;
					pinnedTier = null;
					planningActive = false;
					const changed = syncActiveTierAgents(nextProfile);
					await setTier(floorTier, `profile ${nextProfile}`, ctx);
					ctx.ui.notify(`✅ Router profile → ${nextProfile}. Synced tier agents${changed.length ? `: ${changed.join(", ")}` : ""}. Restart Pi to refresh the subagent tool description.`, "info");
					break;
				}

				case "validate": {
					const validateAll = parts[1]?.toLowerCase() === "all";
					const errors = validationErrors(ctx, config, validateAll);
					const scope = validateAll ? "all profiles" : config.activeProfile;
					if (errors.length === 0) ctx.ui.notify(`✅ Router config valid (${scope})`, "success");
					else ctx.ui.notify(`❌ Router config issues (${scope}):\n${errors.map((e) => `  - ${e}`).join("\n")}`, "error");
					break;
				}

				case "sync-agents": {
					const changed = syncActiveTierAgents(config.activeProfile);
					ctx.ui.notify(`Synced ${config.activeProfile} tier agents${changed.length ? `: ${changed.join(", ")}` : " (no changes)"}`, "info");
					break;
				}

				case "on":
					routerEnabled = true;
					pinnedTier = null;
					ctx.ui.notify("✅ Router enabled — auto-routing anchored to floor", "info");
					break;

				case "off":
					routerEnabled = false;
					ctx.ui.notify("⏸️ Router paused — staying on current model", "info");
					break;

				case "escalate": {
					const next = nextTier(currentTier);
					if (!next) {
						ctx.ui.notify("Already at highest tier (planner)", "warning");
						return;
					}
					pinnedTier = next;
					await setTier(next, "manual /router escalate", ctx);
					ctx.ui.notify(`⬆️ ${tierLabel(next, profile)} — auto-routing paused (/router auto to resume)`, "info");
					break;
				}

				case "floor": {
					const tierName = parts[1]?.toLowerCase();
					if (!tierName || !isFloorTier(tierName)) {
						ctx.ui.notify(`Floor must be one of: ${FLOOR_CHOICES.join(", ")}`, "error");
						return;
					}
					floorTier = tierName;
					pinnedTier = null;
					await setTier(tierName, "manual /router floor", ctx);
					ctx.ui.notify(`🧱 Floor set to ${tierLabel(tierName, profile)} — auto-routing anchored here`, "info");
					break;
				}

				case "auto":
					pinnedTier = null;
					planningActive = false;
					routerEnabled = true;
					floorTier = profile.defaultFloor;
					await setTier(floorTier, "manual /router auto", ctx);
					ctx.ui.notify(`🔀 Auto-routing resumed — floor ${tierLabel(floorTier, profile)}`, "info");
					break;

				case "log": {
					if (sessionRouteLog.length === 0) {
						ctx.ui.notify("No routing decisions this session.", "info");
						return;
					}
					const lines = sessionRouteLog.map((r) => `  ${r.time}  ${tierLabel(r.from, profile)} → ${tierLabel(r.to, profile)}  (${r.reason})`);
					ctx.ui.notify(`📋 Routing log:\n${lines.join("\n")}`, "info");
					break;
				}

				case "reset":
					pinnedTier = null;
					planningActive = false;
					consecutiveErrors = 0;
					routerEnabled = true;
					floorTier = profile.defaultFloor;
					await setTier(floorTier, "manual /router reset", ctx);
					ctx.ui.notify(`🔄 Reset — floor ${tierLabel(floorTier, profile)}, auto-routing on`, "info");
					break;

				default:
					ctx.ui.notify("Usage: /router [status|profile <name>|profiles|validate|on|off|escalate|floor <fast|balanced|strong>|auto|log|reset|sync-agents]", "info");
			}
		},
	});

	pi.registerCommand("routes", {
		description: "Show router commands and tier map",
		handler: async (_args, ctx) => {
			reloadConfig();
			const help = [
				`🔀 **Model Router — Command Reference**`,
				``,
				`Profile: ${config.activeProfile} (${profile.provider})`,
				``,
				`/plan <task>        Plan on ${tierLabel(profile.planningTier, profile)} → set floor → downgrade`,
				`/fast               Pin fast tier`,
				`/balanced           Pin balanced tier`,
				`/strong             Pin strong tier`,
				`/router status      Current mode, tier, floor, profile`,
				`/router profile X   Switch profile and sync active tier agents`,
				`/router validate    Check configured models exist`,
				`/router floor X     Set floor to fast|balanced|strong`,
				`/router auto        Clear pin and return to default floor`,
				`/router escalate    Move up one tier`,
				`/router log         Routing decisions this session`,
				``,
				`Tiers:`,
				...TIER_ORDER.map((t) => `  ${t.padEnd(8)} ${profile.tiers[t].label} — ${profile.tiers[t].id}`),
				``,
				`Default floor: ${tierLabel(profile.defaultFloor, profile)}`,
				`Planner:       ${tierLabel(profile.planningTier, profile)}`,
				`Compaction:    ${profile.compactionTier ? tierLabel(profile.compactionTier, profile) : "default"}`,
			];
			ctx.ui.notify(help.join("\n"), "info");
		},
	});
}
