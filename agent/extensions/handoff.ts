/**
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters
 * for your next task and creates a new session with a generated prompt.
 *
 * The new session receives:
 * 1. A repo context snapshot (directory structure, key config files, README)
 *    injected as a synthetic message pair — gives the model spatial awareness
 * 2. The generated handoff prompt as the user's first real message
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *   /handoff check other places that need this fix
 *
 * The generated prompt appears as a draft in the editor for review/editing.
 */

import { completeSimple, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const SYSTEM_PROMPT = `You are a session handoff specialist. Your job is to create a comprehensive, self-contained briefing document that allows a fresh AI session to continue work seamlessly — as if it had been present for the entire previous conversation.

The receiving session will have ZERO context beyond what you provide. It cannot reference the old conversation. Everything it needs must be in your output.

## Output Structure (follow exactly)

### ## Background
A 2-4 sentence summary of the project/feature being worked on. What is it? Why does it exist? What problem does it solve?

### ## Key Decisions & Findings
Bullet list of every important decision, discovery, or conclusion reached during the conversation. Include the *reasoning* behind decisions, not just the decision itself. Flag any decisions that were contentious or might need revisiting.

### ## Current State
What's done, what's in progress, what's broken. Be specific:
- [DONE] Completed items (with brief note on approach taken)
- [WIP] In-progress items (what's left to do)
- [BLOCKED] Blocked/broken items (what the issue is)
- [WARN] Known issues or tech debt introduced

### ## Architecture & Approach
How the solution is structured. Include:
- High-level design (components, data flow, patterns used)
- Important constraints or requirements that shaped the design
- Rejected alternatives and why they were rejected

### ## Files & Locations
Every file that was created, modified, or is relevant. Group by:
- **Created**: New files made in this session
- **Modified**: Existing files changed
- **Key references**: Files not changed but important for understanding

### ## Code Patterns & Conventions
Specific patterns established that the next session must follow:
- Naming conventions used
- Error handling approach
- API patterns
- Testing patterns

### ## Environment & Setup
Any setup, configuration, or environment details needed:
- Required env vars
- Build/run commands
- Dependencies added

### ## Task for Next Session
Clear, actionable description of what to do next. Include:
1. Specific steps in priority order
2. Acceptance criteria — how to know each step is done
3. Gotchas or pitfalls to watch out for
4. Any open questions that need answering

### ## Context the Next Session Should Verify
Things the next session should check/read before proceeding:
- Files to read first to understand current state
- Commands to run to verify environment
- Tests to run to confirm nothing is broken

## Rules
- Be THOROUGH over brief. A too-long handoff is better than one missing critical context.
- Include exact file paths, function names, variable names — specifics matter.
- If the conversation had errors/debugging, summarize the root cause and fix, not the whole journey.
- If code snippets are essential for understanding (e.g., key interfaces, schemas), include them.
- Do NOT include pleasantries, meta-commentary, or "Here's your handoff" preambles.
- Do NOT use emojis.
- Output the handoff document directly, starting with ## Background.`;

// -------------------------------------------------------------------
// Repo context gathering — builds a snapshot of the repository layout
// -------------------------------------------------------------------

/**
 * Generate a repo context snapshot: tree, key config files, README excerpt.
 * Designed to be fast (<2s) and stay within reasonable token limits.
 */
function gatherRepoContext(cwd: string): string {
	const sections: string[] = [];

	// 1. Directory tree (depth-limited)
	try {
		// Prefer 'tree' if available, fall back to 'find'
		let tree: string;
		try {
			tree = execSync(
				"tree -L 3 --dirsfirst --noreport -I 'node_modules|.git|dist|build|__pycache__|.next|vendor|target|.venv|venv' 2>/dev/null | head -120",
				{ encoding: "utf-8", timeout: 5000, cwd },
			).trim();
		} catch {
			tree = execSync(
				"find . -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/vendor/*' -not -path '*/__pycache__/*' | sort | head -120",
				{ encoding: "utf-8", timeout: 5000, cwd },
			).trim();
		}
		if (tree) {
			sections.push(`## Directory Structure\n\`\`\`\n${tree}\n\`\`\``);
		}
	} catch {}

	// 2. README (first 80 lines)
	const readmeNames = ["README.md", "README", "readme.md", "README.rst"];
	for (const name of readmeNames) {
		const readmePath = join(cwd, name);
		if (existsSync(readmePath)) {
			try {
				const content = readFileSync(readmePath, "utf-8");
				const lines = content.split("\n").slice(0, 80);
				const excerpt = lines.join("\n");
				const truncated = content.split("\n").length > 80 ? "\n[...truncated]" : "";
				sections.push(`## README (${name})\n\`\`\`markdown\n${excerpt}${truncated}\n\`\`\``);
			} catch {}
			break;
		}
	}

	// 3. Package/project config (detect project type)
	const configFiles = [
		{ file: "package.json", label: "package.json (Node/JS)" },
		{ file: "go.mod", label: "go.mod (Go)" },
		{ file: "Cargo.toml", label: "Cargo.toml (Rust)" },
		{ file: "pyproject.toml", label: "pyproject.toml (Python)" },
		{ file: "requirements.txt", label: "requirements.txt (Python)" },
		{ file: "pom.xml", label: "pom.xml (Java/Maven)" },
		{ file: "build.gradle", label: "build.gradle (Java/Gradle)" },
		{ file: "mix.exs", label: "mix.exs (Elixir)" },
		{ file: "Gemfile", label: "Gemfile (Ruby)" },
	];

	for (const { file, label } of configFiles) {
		const filePath = join(cwd, file);
		if (existsSync(filePath)) {
			try {
				const content = readFileSync(filePath, "utf-8");
				// For large files like package.json, just show key fields
				if (file === "package.json") {
					const pkg = JSON.parse(content);
					const summary = {
						name: pkg.name,
						description: pkg.description,
						scripts: pkg.scripts ? Object.keys(pkg.scripts) : undefined,
						dependencies: pkg.dependencies ? Object.keys(pkg.dependencies) : undefined,
						devDependencies: pkg.devDependencies ? Object.keys(pkg.devDependencies) : undefined,
					};
					sections.push(`## ${label}\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``);
				} else {
					const lines = content.split("\n").slice(0, 40).join("\n");
					sections.push(`## ${label}\n\`\`\`\n${lines}\n\`\`\``);
				}
			} catch {}
			break; // Only show the first matching config
		}
	}

	// 4. Makefile / justfile targets
	const buildFiles = ["Makefile", "justfile", "Justfile"];
	for (const name of buildFiles) {
		const filePath = join(cwd, name);
		if (existsSync(filePath)) {
			try {
				const content = readFileSync(filePath, "utf-8");
				// Extract target names (lines starting with word followed by colon, or just recipes for justfile)
				const lines = content.split("\n");
				const targets = lines
					.filter((l) => /^[a-zA-Z_][\w-]*[: ]/.test(l) && !l.startsWith("\t") && !l.startsWith(" "))
					.slice(0, 30)
					.map((l) => l.replace(/:.*/, "").trim());
				if (targets.length > 0) {
					sections.push(`## ${name} targets\n\`\`\`\n${targets.join("\n")}\n\`\`\``);
				}
			} catch {}
			break;
		}
	}

	// 5. Key source entry points
	const entryPoints = [
		"src/index.ts",
		"src/main.ts",
		"src/app.ts",
		"main.go",
		"cmd/main.go",
		"src/main.rs",
		"src/lib.rs",
		"app/main.py",
		"main.py",
		"src/index.js",
	];
	const foundEntries: string[] = [];
	for (const entry of entryPoints) {
		if (existsSync(join(cwd, entry))) {
			foundEntries.push(entry);
		}
	}
	if (foundEntries.length > 0) {
		sections.push(`## Entry Points\n${foundEntries.map((e) => `- \`${e}\``).join("\n")}`);
	}

	return sections.join("\n\n");
}

/**
 * Gather git context to supplement the conversation
 */
function gatherGitContext(cwd?: string): string {
	const opts = { encoding: "utf-8" as const, timeout: 5000, cwd };
	const sections: string[] = [];

	try {
		const branch = execSync("git branch --show-current 2>/dev/null", opts).trim();
		if (branch) {
			sections.push(`Current branch: \`${branch}\``);
		}
	} catch {}

	try {
		const log = execSync("git log --oneline -10 2>/dev/null", opts).trim();
		if (log) {
			sections.push(`### Recent Commits\n\`\`\`\n${log}\n\`\`\``);
		}
	} catch {}

	try {
		const status = execSync("git status --short 2>/dev/null", opts).trim();
		if (status) {
			sections.push(`### Uncommitted Changes\n\`\`\`\n${status}\n\`\`\``);
		}
	} catch {}

	try {
		const diffStat = execSync("git diff --stat 2>/dev/null", opts).trim();
		if (diffStat) {
			sections.push(`### Working Tree Diff\n\`\`\`\n${diffStat}\n\`\`\``);
		}
	} catch {}

	try {
		const stagedStat = execSync("git diff --cached --stat 2>/dev/null", opts).trim();
		if (stagedStat) {
			sections.push(`### Staged Changes\n\`\`\`\n${stagedStat}\n\`\`\``);
		}
	} catch {}

	return sections.length > 0 ? `## Git State\n\n${sections.join("\n\n")}` : "";
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
				return;
			}

			// Gather conversation context from current branch
			const branch = ctx.sessionManager.getBranch();
			const messages = branch
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message);

			if (messages.length === 0) {
				ctx.ui.notify("No conversation to hand off", "error");
				return;
			}

			// Convert to LLM format and serialize
			const llmMessages = convertToLlm(messages);
			let conversationText = serializeConversation(llmMessages);

			// Truncate to avoid blowing context window — keep last ~80k chars
			const MAX_CONTEXT_CHARS = 80000;
			if (conversationText.length > MAX_CONTEXT_CHARS) {
				const truncatedNote = `[...earlier conversation truncated -- ${Math.round((conversationText.length - MAX_CONTEXT_CHARS) / 1000)}k chars omitted...]\n\n`;
				conversationText = truncatedNote + conversationText.slice(-MAX_CONTEXT_CHARS);
			}

			// Gather supplementary context
			const cwd = process.cwd();
			const gitContext = gatherGitContext(cwd);
			const repoContext = gatherRepoContext(cwd);

			const currentSessionFile = ctx.sessionManager.getSessionFile();

			// Generate the handoff prompt with loader UI
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Generating handoff prompt...`);
				loader.onAbort = () => done(null);

				const doGenerate = async () => {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
					if (!auth.ok) {
						throw new Error(`Auth error: ${auth.error}`);
					}
					const apiKey = auth.apiKey;

					const userContent = [
						`## User's Goal for New Session\n\n${goal}`,
						gitContext,
						`## Conversation History\n\n${conversationText}`,
					]
						.filter(Boolean)
						.join("\n\n---\n\n");

					const userMessage: Message = {
						role: "user",
						content: [{ type: "text", text: userContent }],
						timestamp: Date.now(),
					};

					const response = await completeSimple(
						ctx.model!,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{ apiKey, headers: auth.headers, signal: loader.signal, maxTokens: 8192, reasoning: "low" },
					);

					if (response.stopReason === "aborted") {
						return null;
					}

					// Extract text from response
					const textParts = response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");

					if (!textParts) {
						console.error(
							"Handoff: response had no text content. Content types:",
							response.content.map((c) => c.type),
						);
						console.error("Response stopReason:", response.stopReason);
					}

					return textParts;
				};

				doGenerate()
					.then(done)
					.catch((err) => {
						console.error("Handoff generation failed:", err);
						done(null);
					});

				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			if (!result.trim()) {
				ctx.ui.notify("Handoff generation returned empty result -- check console for details", "error");
				return;
			}

			// Let user edit the generated prompt
			const editedPrompt = await ctx.ui.editor("Edit handoff prompt (enter=submit, ctrl+g=external editor)", result);

			if (editedPrompt === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Create new session with repo context seeded as a synthetic exchange,
			// then place the handoff prompt in the editor for the user to submit.
			const newSessionResult = await ctx.newSession({
				parentSession: currentSessionFile,
				setup: async (sm) => {
					// Inject repo context as a user/assistant pair so the model
					// has spatial awareness of the repository without the user
					// needing to manually explore. This lives in the session
					// history (not on disk as a separate file).
					sm.appendMessage({
						role: "user",
						content: [
							{
								type: "text",
								text: `Before we begin, here is a snapshot of the repository structure and configuration for reference:\n\n${repoContext}`,
							},
						],
						timestamp: Date.now(),
					});
					sm.appendMessage({
						role: "assistant",
						content: [
							{
								type: "text",
								text: "Understood. I have reviewed the repository structure, configuration, and key files. I am ready to work on this codebase. What would you like me to do?",
							},
						],
						timestamp: Date.now(),
						usage: { input: 0, output: 0, cost: { total: 0 } },
					});
				},
				withSession: async (newCtx) => {
					newCtx.ui.setEditorText(editedPrompt);
					newCtx.ui.notify("Handoff ready -- review and submit.", "info");
				},
			});

			if (newSessionResult.cancelled) {
				return;
			}
		},
	});
}
