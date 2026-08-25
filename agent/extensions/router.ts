/**
 * Model Router Extension — floor-based deterministic routing
 *
 * Routing is driven by explicit mechanisms only — no per-prompt scoring:
 *
 *   1. /plan <task>  — pin opus, produce a task manifest, and let opus judge
 *                      the implementation complexity. It emits an
 *                      IMPLEMENTATION_FLOOR, we drop to that floor, and
 *                      auto-routing resumes anchored to it.
 *   2. Floor         — the base tier for the current task. Clamps the minimum
 *                      so mid-task clarifying prompts can't downgrade you.
 *   3. Slash pins    — /nova /haiku /sonnet pin a tier (sticky, until
 *                      /router auto). /router escalate moves up one tier.
 *   4. /opus         — one-shot spike: runs the next turn on opus, then falls
 *                      back to the floor (or the active pin).
 *
 * Tiers (command name → model):
 *   nova   → Nova Micro        $0.035/$0.14 (cached: ~$0.004/M)
 *   haiku  → Claude Haiku 4.5  $0.80/$4.00  (cached: $0.08/M)
 *   sonnet → Claude Sonnet 5   $3.00/$15.00 (cached: $0.30/M)
 *   opus   → Claude Opus 4.8   $15.00/$75.00 (cached: $1.50/M)
 *
 * Commands:
 *   /plan <task>        Plan on opus, then downgrade to the assessed floor
 *   /nova /haiku /sonnet  Pin a tier (sticky)
 *   /opus [prompt]      One-shot opus spike (this turn only)
 *   /router [status|on|off|escalate|floor <name>|auto|log|reset]
 *   /routes             Full command reference
 *
 * Usage: pi -e extensions/router.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── Model Tier Definitions ─────────────────────────────────────────────────

type Tier = "nova" | "haiku" | "sonnet" | "opus";

const TIER_ORDER: Tier[] = ["nova", "haiku", "sonnet", "opus"];

// Ad-hoc base tier when no plan is active.
const DEFAULT_FLOOR: Tier = "haiku";

// Floor the planner may pick (opus is never a floor — it's plan/spike only).
const FLOOR_CHOICES: Tier[] = ["nova", "haiku", "sonnet"];

const TIER_MODELS: Record<Tier, string> = {
	nova: "amazon.nova-micro-v1:0",
	haiku: "arn:aws:bedrock:us-east-1:472598590798:application-inference-profile/1xd0f80p0sob",
	sonnet: "arn:aws:bedrock:us-east-1:472598590798:application-inference-profile/ov5vdsffeznl",
	opus: "arn:aws:bedrock:us-east-1:472598590798:application-inference-profile/xsahe8qo68zv",
};

const TIER_LABELS: Record<Tier, string> = {
	nova: "⚡ Nova Micro",
	haiku: "🧠 Claude Haiku 4.5",
	sonnet: "🎵 Claude Sonnet 5",
	opus: "🎭 Claude Opus 4.8",
};

const TIER_COST_HINT: Record<Tier, string> = {
	nova: "$0.035/$0.14 per M (cached: ~$0.004/M)",
	haiku: "$0.80/$4.00 per M (cached: $0.08/M)",
	sonnet: "$3.00/$15.00 per M (cached: $0.30/M)",
	opus: "$15.00/$75.00 per M (cached: $1.50/M)",
};

const TIER_MODEL_OVERRIDES: Record<Tier, Record<string, any>> = {
	nova: { reasoning: false, name: "Nova Micro" },
	haiku: { reasoning: true, name: "claude-haiku-4-5" },
	// HACK: Pi only sends adaptive thinking for models whose name contains "opus-4-8" or "sonnet-4-6".
	// Our AIPs are Sonnet 5 and Opus 4.8, but Pi doesn't know Sonnet 5's ARN yet.
	// Without these names, thinking breaks with "thinking.type.enabled is not supported".
	sonnet: { reasoning: true, name: "claude-sonnet-4-6" },
	opus: { reasoning: true, name: "claude-opus-4-8" },
};

// ─── Planning framing ────────────────────────────────────────────────────────

const PLAN_FRAMING = `[PLANNING MODE — opus]
Analyze the user's intent and produce a task manifest. Do NOT edit or write any files yet — this turn is planning only.

1. Restate the goal and any hard constraints in plain terms.
2. Investigate the relevant code as needed (read-only tools).
3. Produce a numbered implementation plan under a "Plan:" header.
4. On the FINAL line, emit exactly one of the following, choosing the MINIMUM model tier the implementation work will require:
     IMPLEMENTATION_FLOOR: nova     (trivial edits, renames, boilerplate, docs)
     IMPLEMENTATION_FLOOR: haiku    (routine implementation, straightforward debugging)
     IMPLEMENTATION_FLOOR: sonnet   (architecture, security, concurrency, cross-cutting or multi-file changes)

The floor anchors the model used during implementation, so pick honestly based on the hardest step in the plan.`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nextTier(from: Tier): Tier | null {
	const idx = TIER_ORDER.indexOf(from);
	if (idx < 0 || idx >= TIER_ORDER.length - 1) return null;
	return TIER_ORDER[idx + 1];
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

function parseFloor(text: string): Tier | null {
	const m = text.match(/IMPLEMENTATION_FLOOR:\s*(nova|haiku|sonnet)/i);
	if (!m) return null;
	const tier = m[1].toLowerCase() as Tier;
	return FLOOR_CHOICES.includes(tier) ? tier : null;
}

// ─── Extension Entry Point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let currentTier: Tier = DEFAULT_FLOOR;
	let floorTier: Tier = DEFAULT_FLOOR;
	let pinnedTier: Tier | null = null; // sticky pin via /nova /haiku /sonnet /router escalate
	let opusOneShot = false; // armed by /opus, consumed on the next turn
	let planningActive = false; // true while the /plan turn is running
	let routerEnabled = true;
	let consecutiveErrors = 0;
	let sessionRouteLog: Array<{ time: string; from: Tier; to: Tier; reason: string }> = [];

	// ─── Helper: switch to a tier ──────────────────────────────────────────

	async function setTier(tier: Tier, reason: string, ctx: any): Promise<boolean> {
		if (tier === currentTier) return true;
		if (!ctx.model) {
			ctx.ui?.notify?.("Router: no ctx.model available", "warning");
			return false;
		}

		const model = { ...ctx.model, id: TIER_MODELS[tier], ...TIER_MODEL_OVERRIDES[tier] };

		try {
			const result = await pi.setModel(model);
			if (result === false) {
				ctx.ui?.notify?.(
					`Router: setModel returned false for ${TIER_LABELS[tier]} (auth?). ID: ${model.id?.slice(0, 40)}`,
					"warning",
				);
				return false;
			}
			const oldTier = currentTier;
			currentTier = tier;
			sessionRouteLog.push({ time: new Date().toLocaleTimeString(), from: oldTier, to: tier, reason });
			return true;
		} catch (err: any) {
			ctx.ui?.notify?.(`Router setModel failed: ${err?.message || err}`, "warning");
			return false;
		}
	}

	// The resting tier the router falls back to: an active pin, else the floor.
	function restingTier(): Tier {
		return pinnedTier ?? floorTier;
	}

	// ─── Session Start ─────────────────────────────────────────────────────

	pi.on("session_start", (_event: any, ctx: any) => {
		consecutiveErrors = 0;
		pinnedTier = null;
		opusOneShot = false;
		planningActive = false;
		floorTier = DEFAULT_FLOOR;
		sessionRouteLog = [];

		const modelId = ctx.model?.id ?? "";
		const launch = (Object.entries(TIER_MODELS) as [Tier, string][]).find(([, id]) => modelId === id);
		currentTier = launch ? launch[0] : ("__unknown__" as Tier);
	});

	// ─── Before Agent Start: apply resting tier, or consume a one-shot ──────

	pi.on("before_agent_start", async (_event: any, ctx: any) => {
		if (!routerEnabled) return;
		if (planningActive) return; // stay on opus during the plan turn

		consecutiveErrors = 0;

		// One-shot opus: applies to THIS turn only, then falls back to the
		// resting tier (pin or floor). Consume the flag so it doesn't persist.
		const spike = opusOneShot;
		opusOneShot = false;

		const target: Tier = spike ? "opus" : restingTier();
		const reason = spike ? "opus one-shot" : pinnedTier ? `pinned (${pinnedTier})` : `floor (${floorTier})`;

		const switched = await setTier(target, reason, ctx);
		if (switched) ctx.ui?.setStatus?.("router", TIER_LABELS[target]);
	});

	// ─── Agent End: on a planning turn, parse the floor and downgrade ───────

	pi.on("agent_end", async (event: any, ctx: any) => {
		if (!planningActive) return;
		planningActive = false;

		const text = extractLastAssistantText(event.messages ?? []);
		const parsed = parseFloor(text);
		// If the planner forgot the marker, default to sonnet — planned work is
		// rarely trivial, and we'd rather over- than under-provision here.
		floorTier = parsed ?? "sonnet";
		pinnedTier = null;

		const switched = await setTier(floorTier, `plan floor: ${floorTier}`, ctx);
		ctx.ui?.notify?.(
			`📋 Plan ready. Floor → ${TIER_LABELS[floorTier]}${parsed ? "" : " (default — no marker found)"}. Auto-routing resumed.`,
			"info",
		);
		if (switched) ctx.ui?.setStatus?.("router", TIER_LABELS[floorTier]);
	});

	// ─── Tool Result: escalate one tier on repeated failures ────────────────

	pi.on("tool_result", async (event: any, ctx: any) => {
		if (!routerEnabled || pinnedTier || planningActive) return;

		if (event.isError) {
			consecutiveErrors++;
			if (consecutiveErrors >= 2) {
				const next = nextTier(currentTier);
				if (next) {
					const switched = await setTier(next, `${consecutiveErrors} consecutive errors`, ctx);
					if (switched) {
						ctx.ui?.notify?.(`⬆️ Escalated → ${TIER_LABELS[next]} (${consecutiveErrors} errors)`, "warning");
						consecutiveErrors = 0;
					}
				}
			}
		} else {
			consecutiveErrors = Math.max(0, consecutiveErrors - 1);
		}
	});

	// ─── /plan ────────────────────────────────────────────────────────────

	pi.registerCommand("plan", {
		description: "Plan a task on opus, then auto-downgrade to the assessed implementation floor. Usage: /plan <task>",
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

			planningActive = true;
			pinnedTier = null;
			opusOneShot = false;
			await setTier("opus", "planning", ctx);
			ctx.ui?.setStatus?.("router", `${TIER_LABELS["opus"]} (planning)`);

			pi.sendUserMessage([PLAN_FRAMING, "", `Task: ${task}`].join("\n"));
		},
	});

	// ─── Model slash pins ───────────────────────────────────────────────────

	function registerPin(command: Tier) {
		pi.registerCommand(command, {
			description: `Pin to ${TIER_LABELS[command]} (sticky — /router auto to resume)`,
			handler: async (_args, ctx) => {
				pinnedTier = command;
				opusOneShot = false;
				await setTier(command, `manual /${command}`, ctx);
				ctx.ui.notify(`🎯 Pinned to ${TIER_LABELS[command]} — auto-routing paused (/router auto to resume)`, "info");
			},
		});
	}
	registerPin("nova");
	registerPin("haiku");
	registerPin("sonnet");

	// ─── /opus — one-shot spike ──────────────────────────────────────────────

	pi.registerCommand("opus", {
		description: "One-shot opus spike: next turn runs on opus, then back to floor. Usage: /opus [prompt]",
		handler: async (args, ctx) => {
			opusOneShot = true;
			const task = (args || "").trim();
			if (task) {
				if (!ctx.isIdle()) {
					ctx.ui.notify("Agent is busy. Wait for the current task to finish.", "warning");
					opusOneShot = false;
					return;
				}
				ctx.ui.notify(`🎭 One-shot opus — this turn only, then back to ${TIER_LABELS[restingTier()]}`, "info");
				pi.sendUserMessage(task);
			} else {
				ctx.ui.notify(
					`🎭 One-shot opus armed — your next prompt runs on opus, then back to ${TIER_LABELS[restingTier()]}`,
					"info",
				);
			}
		},
	});

	// ─── /router control ─────────────────────────────────────────────────────

	pi.registerCommand("router", {
		description: "Model router controls. Usage: /router [status|on|off|escalate|floor <name>|auto|log|reset]",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase() || "status";

			switch (subcommand) {
				case "status": {
					const mode = planningActive
						? "planning (opus)"
						: opusOneShot
							? "opus one-shot armed"
							: pinnedTier
								? `pinned (${TIER_LABELS[pinnedTier]})`
								: routerEnabled
									? "auto"
									: "paused";
					const lines = [
						`🔀 **Model Router**`,
						``,
						`   Mode:   ${mode}`,
						`   Tier:   ${TIER_LABELS[currentTier]}`,
						`   Floor:  ${TIER_LABELS[floorTier]}`,
						`   Cost:   ${TIER_COST_HINT[currentTier]}`,
						`   Errors: ${consecutiveErrors} consecutive`,
						`   Routes: ${sessionRouteLog.length} this session`,
						``,
						`   Tiers:`,
						...TIER_ORDER.map(
							(t) =>
								`     ${t === currentTier ? "→" : " "} ${t.padEnd(6)} ${TIER_LABELS[t].padEnd(22)} ${TIER_COST_HINT[t]}`,
						),
					];
					ctx.ui.notify(lines.join("\n"), "info");
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
						ctx.ui.notify("Already at highest tier (opus)", "warning");
						return;
					}
					pinnedTier = next;
					opusOneShot = false;
					await setTier(next, "manual /router escalate", ctx);
					ctx.ui.notify(`⬆️ ${TIER_LABELS[next]} — auto-routing paused (/router auto to resume)`, "info");
					break;
				}

				case "floor": {
					const tierName = parts[1]?.toLowerCase() as Tier;
					if (!FLOOR_CHOICES.includes(tierName)) {
						ctx.ui.notify(`Floor must be one of: ${FLOOR_CHOICES.join(", ")}`, "error");
						return;
					}
					floorTier = tierName;
					pinnedTier = null;
					await setTier(tierName, "manual /router floor", ctx);
					ctx.ui.notify(`🧱 Floor set to ${TIER_LABELS[tierName]} — auto-routing anchored here`, "info");
					break;
				}

				case "auto":
					pinnedTier = null;
					opusOneShot = false;
					planningActive = false;
					routerEnabled = true;
					floorTier = DEFAULT_FLOOR;
					await setTier(DEFAULT_FLOOR, "manual /router auto", ctx);
					ctx.ui.notify(`🔀 Auto-routing resumed — floor ${TIER_LABELS[DEFAULT_FLOOR]}`, "info");
					break;

				case "log": {
					if (sessionRouteLog.length === 0) {
						ctx.ui.notify("No routing decisions this session.", "info");
						return;
					}
					const lines = sessionRouteLog.map(
						(r) => `  ${r.time}  ${TIER_LABELS[r.from]} → ${TIER_LABELS[r.to]}  (${r.reason})`,
					);
					ctx.ui.notify(`📋 Routing log:\n${lines.join("\n")}`, "info");
					break;
				}

				case "reset":
					pinnedTier = null;
					opusOneShot = false;
					planningActive = false;
					consecutiveErrors = 0;
					floorTier = DEFAULT_FLOOR;
					await setTier(DEFAULT_FLOOR, "manual /router reset", ctx);
					ctx.ui.notify(`🔄 Reset — floor ${TIER_LABELS[DEFAULT_FLOOR]}, auto-routing on`, "info");
					break;

				default:
					ctx.ui.notify("Usage: /router [status|on|off|escalate|floor <name>|auto|log|reset]", "info");
			}
		},
	});

	// ─── /routes — reference ──────────────────────────────────────────────────

	pi.registerCommand("routes", {
		description: "Show all router commands and the routing model",
		handler: async (_args, ctx) => {
			const mode = planningActive
				? "planning"
				: opusOneShot
					? "opus one-shot armed"
					: pinnedTier
						? `pinned (${TIER_LABELS[pinnedTier]})`
						: routerEnabled
							? "auto"
							: "paused";
			const help = [
				`🔀 **Model Router — Command Reference**`,
				``,
				`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
				`  PLANNING`,
				`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
				`  /plan <task>      Plan on opus → set floor → downgrade & resume`,
				``,
				`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
				`  MODEL PINS (sticky until /router auto)`,
				`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
				`  /nova             Pin to Nova Micro`,
				`  /haiku            Pin to Claude Haiku 4.5`,
				`  /sonnet           Pin to Claude Sonnet 5`,
				`  /router escalate  Move up one tier`,
				``,
				`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
				`  ONE-SHOT`,
				`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
				`  /opus [prompt]    Run one turn on opus, then back to the floor`,
				``,
				`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
				`  ROUTER`,
				`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
				`  /router status    Current mode, tier, floor, cost`,
				`  /router escalate  Move up one tier (sticky)`,
				`  /router floor X   Set floor to nova|haiku|sonnet`,
				`  /router auto      Clear pin + floor, back to default`,
				`  /router log       Routing decisions this session`,
				`  /router on|off    Enable / pause routing`,
				`  /router reset     Reset floor to default, auto on`,
				``,
				`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
				`  TIER MAP`,
				`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
				`  nova     ⚡ Nova Micro         $0.035/$0.14 (cached: ~$0.004/M)`,
				`  haiku    🧠 Claude Haiku 4.5  $0.80/$4.00  (cached: $0.08/M)`,
				`  sonnet   🎵 Claude Sonnet 5   $3.00/$15.00 (cached: $0.30/M)`,
				`  opus     🎭 Claude Opus 4.8   $15.00/$75.00 (cached: $1.50/M)`,
				``,
				`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
				`  HOW ROUTING WORKS`,
				`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
				`  • The FLOOR is the base tier for the current task. Every`,
				`    prompt runs at the floor — clarifying questions can't`,
				`    downgrade you mid-task.`,
				`  • /plan lets opus assess the work and SET the floor, then`,
				`    drops to it automatically.`,
				`  • /opus is a ONE-SHOT spike — one turn, then back to the floor.`,
				`  • /nova /haiku /sonnet /router escalate are STICKY pins`,
				`    (until /router auto).`,
				`  • 2 consecutive tool errors auto-escalate one tier (falls back`,
				`    to floor next prompt).`,
				``,
				`  Default floor (no plan): ${TIER_LABELS[DEFAULT_FLOOR]}`,
				`  Current: ${TIER_LABELS[currentTier]} | Floor: ${TIER_LABELS[floorTier]} | Mode: ${mode}`,
			];
			ctx.ui.notify(help.join("\n"), "info");
		},
	});
}
