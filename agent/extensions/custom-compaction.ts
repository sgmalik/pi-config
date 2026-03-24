/**
 * Custom Compaction Extension
 *
 * Replaces the default compaction behavior with a full summary of the entire context.
 * Instead of keeping the last 20k tokens of conversation turns, this extension:
 * 1. Summarizes ALL messages (messagesToSummarize + turnPrefixMessages)
 * 2. Discards all old turns completely, keeping only the summary
 *
 * This example also demonstrates using a different model (AWS Bedrock Haiku) for summarization,
 * which can be cheaper/faster than the main conversation model.
 *
 * Usage:
 *   pi --extension ~/.pi/agent/extensions/custom-compaction.ts
 */

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { Container, Key, Markdown, matchesKey, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// Store the last compaction result for the /compaction command
let lastCompaction: { summary: string; source: string; tokensBefore: string; summaryLength: number; timestamp: string } | undefined;

export default function (pi: ExtensionAPI) {
	// Restore last compaction from session entries on startup/resume
	const restoreCompaction = (entries: any[]) => {
		lastCompaction = undefined;
		// Scan for the last compaction entry (built into the session format, type: "compaction")
		for (const entry of entries) {
			if (entry.type === "compaction" && entry.summary) {
				const source = entry.fromHook ? "custom (Bedrock Haiku)" : "built-in";
				const tokensBefore = typeof entry.tokensBefore === "number" ? entry.tokensBefore.toLocaleString() : String(entry.tokensBefore);
				lastCompaction = {
					summary: entry.summary,
					source,
					tokensBefore,
					summaryLength: entry.summary.length,
					timestamp: new Date(entry.timestamp).toLocaleTimeString(),
				};
			}
			// Check for user edits to the compaction summary
			if (entry.type === "custom" && entry.customType === "compaction-edit" && entry.data?.summary) {
				const data = entry.data;
				lastCompaction = {
					summary: data.summary,
					source: data.source ?? lastCompaction?.source ?? "unknown",
					tokensBefore: data.tokensBefore ?? lastCompaction?.tokensBefore ?? "?",
					summaryLength: data.summary.length,
					timestamp: data.timestamp ?? lastCompaction?.timestamp ?? "?",
				};
			}
		}
	};

	const restoreAndNotify = async (_event: any, ctx: any) => {
		restoreCompaction(ctx.sessionManager.getEntries());
		if (lastCompaction && ctx.hasUI) {
			ctx.ui.notify(
				`Previous compaction available (${lastCompaction.tokensBefore} tokens → ${lastCompaction.summaryLength} chars). Use /compaction to view.`,
				"info",
			);
		}
	};

	pi.on("session_start", restoreAndNotify);
	pi.on("session_switch", restoreAndNotify);
	pi.on("session_fork", restoreAndNotify);
	pi.on("session_tree", restoreAndNotify);

	// Post-compaction: show compact stats widget + store full summary for /compaction
	pi.on("session_compact", (event, ctx) => {
		if (!ctx.hasUI) return;

		const { compactionEntry, fromExtension } = event;
		const source = fromExtension ? "custom (Bedrock Haiku)" : "built-in";
		const summaryLength = compactionEntry.summary.length;
		const tokensBefore = compactionEntry.tokensBefore.toLocaleString();
		const timestamp = new Date(compactionEntry.timestamp).toLocaleTimeString();

		// Store for /compaction command
		lastCompaction = { summary: compactionEntry.summary, source, tokensBefore, summaryLength, timestamp };

		ctx.ui.notify(
			`✓ Compaction complete — ${tokensBefore} tokens via ${source}. Use /compaction to view full summary.`,
			"info",
		);

		// Show compact stats widget
		ctx.ui.setWidget("compaction-summary", (_tui, theme) => ({
			render() {
				return [
					theme.fg("borderMuted", "─────────────────────────────────────────────"),
					theme.fg("accent", theme.bold("  ✓ Compaction Complete")),
					theme.fg("muted", "  source  ") + theme.fg("text", source),
					theme.fg("muted", "  tokens  ") + theme.fg("warning", tokensBefore) + theme.fg("dim", " before"),
					theme.fg("muted", "  summary ") + theme.fg("text", `${summaryLength} chars`),
					theme.fg("muted", "  time    ") + theme.fg("dim", timestamp),
					theme.fg("dim", "  /compaction to view full summary"),
					theme.fg("borderMuted", "─────────────────────────────────────────────"),
				];
			},
			invalidate() {},
		}));

		setTimeout(() => {
			ctx.ui.setWidget("compaction-summary", undefined);
		}, 10_000);
	});

	// /compaction — scrollable overlay showing the full compaction summary
	pi.registerCommand("compaction", {
		description: "View the last compaction summary in a scrollable overlay",
		handler: async (_args, ctx) => {
			if (!lastCompaction) {
				ctx.ui.notify("No compaction has occurred yet in this session.", "warning");
				return;
			}

			const { summary, source, tokensBefore, summaryLength, timestamp } = lastCompaction;

			const header = [
				`> **Source:** ${source}  ·  **Tokens before:** ${tokensBefore}  ·  **Summary:** ${summaryLength} chars  ·  **Time:** ${timestamp}`,
				"",
				"---",
				"",
			].join("\n");

			const fullContent = header + summary;

			// Result: undefined = closed, "edit" = user wants to edit
			const action = await ctx.ui.custom<"edit" | undefined>(
				(tui, theme, _kb, done) => {
					let currentContent = fullContent;
					let md = new Markdown(currentContent, 1, 1, getMarkdownTheme());
					let scrollOffset = 0;
					let contentLines: string[] = [];
					let cachedWidth: number | undefined;
					let cachedOutput: string[] | undefined;
					const VIEWPORT_HEIGHT = 30;

					return {
						handleInput(data: string) {
							const maxScroll = Math.max(0, contentLines.length - VIEWPORT_HEIGHT);
							const pageSize = Math.max(1, VIEWPORT_HEIGHT - 2);
							let changed = false;

							if (matchesKey(data, Key.escape) || data === "q") {
								done(undefined);
								return;
							} else if (data === "e") {
								done("edit");
								return;
							} else if (matchesKey(data, Key.up) || data === "k") {
								scrollOffset = Math.max(0, scrollOffset - 1);
								changed = true;
							} else if (matchesKey(data, Key.down) || data === "j") {
								scrollOffset = Math.min(maxScroll, scrollOffset + 1);
								changed = true;
							} else if (matchesKey(data, "pageup") || matchesKey(data, Key.ctrl("u"))) {
								scrollOffset = Math.max(0, scrollOffset - pageSize);
								changed = true;
							} else if (matchesKey(data, "pagedown") || matchesKey(data, Key.ctrl("d"))) {
								scrollOffset = Math.min(maxScroll, scrollOffset + pageSize);
								changed = true;
							} else if (matchesKey(data, Key.home)) {
								scrollOffset = 0;
								changed = true;
							} else if (matchesKey(data, Key.end)) {
								scrollOffset = maxScroll;
								changed = true;
							}

							if (changed) {
								cachedWidth = undefined;
								cachedOutput = undefined;
								tui.requestRender();
							}
						},

						render(width: number): string[] {
							if (cachedOutput && cachedWidth === width) return cachedOutput;

							const innerW = Math.max(1, width - 2);

							// Render full markdown
							contentLines = md.render(innerW - 2); // leave room for │ + space padding

							// Clamp scroll
							const maxScroll = Math.max(0, contentLines.length - VIEWPORT_HEIGHT);
							scrollOffset = Math.min(scrollOffset, maxScroll);

							// Visible slice
							const visible = contentLines.slice(scrollOffset, scrollOffset + VIEWPORT_HEIGHT);

							// Scroll indicator
							const pos = `${scrollOffset + 1}-${Math.min(scrollOffset + VIEWPORT_HEIGHT, contentLines.length)}/${contentLines.length}`;
							const pct = maxScroll > 0 ? `${Math.round((scrollOffset / maxScroll) * 100)}%` : "100%";

							// Helper: wrap a content line in box borders with padding
							const row = (content: string): string => {
								return theme.fg("border", "│") + " " + truncateToWidth(content, innerW - 2, "...", true) + " " + theme.fg("border", "│");
							};

							// Title bar
							const titleText = " Compaction Summary ";
							const titleW = visibleWidth(titleText);
							const leftDash = "─".repeat(Math.floor((innerW - titleW) / 2));
							const rightDash = "─".repeat(Math.max(0, innerW - titleW - leftDash.length));
							const topBorder = theme.fg("border", "╭" + leftDash) + theme.fg("accent", theme.bold(titleText)) + theme.fg("border", rightDash + "╮");

							// Scroll info row
							const scrollInfo = `${pos} ${pct}`;
							const scrollLeft = " ↑↓/j/k · PgUp/PgDn · Home/End · e edit · q/Esc close";
							const scrollPad = " ".repeat(Math.max(1, innerW - 2 - visibleWidth(scrollLeft) - visibleWidth(scrollInfo)));
							const helpContent = theme.fg("dim", scrollLeft) + scrollPad + theme.fg("dim", scrollInfo);

							// Bottom border
							const bottomBorder = theme.fg("border", "╰" + "─".repeat(innerW) + "╯");

							const output = [
								topBorder,
								...visible.map(row),
								theme.fg("border", "├" + "─".repeat(innerW) + "┤"),
								row(helpContent),
								bottomBorder,
							];

							cachedWidth = width;
							cachedOutput = output;
							return output;
						},

						invalidate() {
							cachedWidth = undefined;
							cachedOutput = undefined;
							md.invalidate();
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "80%",
						minWidth: 60,
						maxHeight: "85%",
					},
				},
			);

			// If user pressed 'e', open the editor with the raw summary
			if (action === "edit") {
				const edited = await ctx.ui.editor("Edit Compaction Summary", summary);

				if (edited !== undefined && edited !== summary) {
					// Update in-memory state
					lastCompaction = { ...lastCompaction, summary: edited, summaryLength: edited.length };

					// Persist the edit to the session so it survives resume
					pi.appendEntry("compaction-edit", {
						summary: edited,
						source: lastCompaction.source,
						tokensBefore: lastCompaction.tokensBefore,
						timestamp: lastCompaction.timestamp,
						editedAt: new Date().toISOString(),
					});

					ctx.ui.notify(`Compaction summary updated (${edited.length} chars)`, "info");
				} else if (edited === undefined) {
					ctx.ui.notify("Edit cancelled", "info");
				}
			}
		},
	});

	pi.on("session_before_compact", async (event, ctx) => {
		ctx.ui.notify("Custom compaction extension triggered", "info");

		const { preparation, branchEntries: _, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

		// Use AWS Bedrock Haiku for summarization (cheaper/faster than most conversation models)
		const model = ctx.modelRegistry.find("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0");
		if (!model) {
			ctx.ui.notify(`Could not find AWS Bedrock Haiku model, using default compaction`, "warning");
			return;
		}

		// Even for Bedrock, getApiKey() returns the resolved AWS credential/token
		// that complete() needs internally to authenticate the request
		const apiKey = await ctx.modelRegistry.getApiKey(model);
		if (!apiKey) {
			ctx.ui.notify("Could not get AWS Bedrock credentials, using default compaction", "warning");
			return;
		}

		// Combine all messages for full summary
		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

		if (allMessages.length === 0) {
			ctx.ui.notify("Nothing to compact — all messages fit within the keep-recent threshold.", "info");
			return { cancel: true };
		}

		ctx.ui.notify(
			`Custom compaction: summarizing ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens) with AWS Bedrock Haiku...`,
			"info",
		);

		// Convert messages to readable text format
		const conversationText = serializeConversation(convertToLlm(allMessages));

		// Include previous summary context if available
		const previousContext = previousSummary ? `\n\nPrevious session summary for context:\n${previousSummary}` : "";

		// Build messages that ask for a comprehensive summary
		const summaryMessages = [
			{
				role: "user" as const,
				content: [
					{
						type: "text" as const,
						text: `You are a conversation summarizer. Create a comprehensive summary of this conversation that captures:${previousContext}

1. The main goals and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file modifications, or technical details
4. Current state of any ongoing work
5. Any blockers, issues, or open questions
6. Next steps that were planned or suggested

Be thorough but concise. The summary will replace the ENTIRE conversation history, so include all information needed to continue the work effectively.

Format the summary as structured markdown with clear sections.

<conversation>
${conversationText}
</conversation>`,
					},
				],
				timestamp: Date.now(),
			},
		];

		try {
			// Pass signal to honor abort requests (e.g., user cancels compaction)
			const response = await complete(model, { messages: summaryMessages }, { apiKey, maxTokens: 8192, signal });

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) {
				if (!signal.aborted) ctx.ui.notify("Compaction summary was empty, using default compaction", "warning");
				return;
			}

			// Return compaction content - SessionManager adds id/parentId
			// Use firstKeptEntryId from preparation to keep recent messages
			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Compaction failed: ${message}`, "error");
			// Fall back to default compaction on error
			return;
		}
	});
}
