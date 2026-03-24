/**
 * Help Extension
 *
 * Provides a /help command that opens a scrollable overlay showing all
 * registered slash commands, keyboard shortcuts, and extension features.
 *
 * Usage: /help or Ctrl+/
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
	function buildHelpMarkdown(): string {
		const commands = pi.getCommands();

		// Group by source
		const extCmds = commands.filter((c) => c.source === "extension");
		const promptCmds = commands.filter((c) => c.source === "prompt");
		const skillCmds = commands.filter((c) => c.source === "skill");

		const lines: string[] = [];

		// --- Custom Slash Commands ---
		lines.push("## Slash Commands");
		lines.push("");

		if (extCmds.length > 0) {
			lines.push("### Extensions");
			lines.push("");
			for (const cmd of extCmds) {
				const desc = cmd.description || "No description";
				lines.push(`- \`/${cmd.name}\` — ${desc}`);
			}
			lines.push("");
		}

		if (promptCmds.length > 0) {
			lines.push("### Prompt Templates");
			lines.push("");
			for (const cmd of promptCmds) {
				const desc = cmd.description || "No description";
				lines.push(`- \`/${cmd.name}\` — ${desc}`);
			}
			lines.push("");
		}

		if (skillCmds.length > 0) {
			lines.push("### Skills");
			lines.push("");
			for (const cmd of skillCmds) {
				const desc = cmd.description || "No description";
				lines.push(`- \`/${cmd.name}\` — ${desc}`);
			}
			lines.push("");
		}

		// --- Keyboard Shortcuts ---
		lines.push("## Keyboard Shortcuts");
		lines.push("");
		lines.push("### Custom");
		lines.push("");
		lines.push("- `Ctrl+X` — Cycle theme forward");
		lines.push("- `Ctrl+Q` — Cycle theme backward");
		lines.push("- `Ctrl+Alt+P` — Toggle plan mode");
		lines.push("- `Ctrl+/` — Show this help");
		lines.push("");
		lines.push("### Built-in");
		lines.push("");
		lines.push("- `Enter` — Submit message");
		lines.push("- `Escape` — Cancel current generation");
		lines.push("- `Ctrl+D` — Exit pi");
		lines.push("- `Ctrl+L` — Clear screen");
		lines.push("- `Up/Down` — Scroll input history");
		lines.push("");

		// --- Built-in Commands ---
		lines.push("## Built-in Commands");
		lines.push("");
		lines.push("- `/model` — Switch AI model");
		lines.push("- `/settings` — Open settings");
		lines.push("- `/compact` — Trigger context compaction");
		lines.push("- `/resume` — Resume a previous session");
		lines.push("- `/clear` — Clear current session");
		lines.push("- `/reload` — Hot-reload extensions");
		lines.push("");

		// --- Active Extensions Summary ---
		lines.push("## Active Extensions");
		lines.push("");
		lines.push("- **Custom Compaction** — Bedrock Haiku summarization with editable summaries");
		lines.push("- **Protected Paths** — Blocks writes to .env/.git and confirms `rm` commands");
		lines.push("- **Cost Tracker** — API spend tracking with `/cost`");
		lines.push("- **Plan Mode** — Read-only exploration with `/plan` and `/todos`");
		lines.push("- **Theme Cycler** — Cycle themes with Ctrl+X/Q or `/theme`");
		lines.push("- **Tools Manager** — Enable/disable tools with `/tools`");
		lines.push("- **Diff Review** — Native diff viewer with `/diff-review`");
		lines.push("- **Handoff** — Transfer context to new session with `/handoff`");
		lines.push("- **System Select** — Switch system prompts with `/system`");
		lines.push("- **Confirm Destructive** — Confirms session clear/switch/fork");
		lines.push("- **Cross Agent** — Multi-agent commands and skills");
		lines.push("");

		return lines.join("\n");
	}

	const showHelp = async (_args: string, ctx: any) => {
		if (!ctx.hasUI) return;

		const content = buildHelpMarkdown();

		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				const md = new Markdown(content, 1, 1, getMarkdownTheme());
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
						contentLines = md.render(innerW - 2);

						const maxScroll = Math.max(0, contentLines.length - VIEWPORT_HEIGHT);
						scrollOffset = Math.min(scrollOffset, maxScroll);

						const visible = contentLines.slice(scrollOffset, scrollOffset + VIEWPORT_HEIGHT);

						const pos = `${scrollOffset + 1}-${Math.min(scrollOffset + VIEWPORT_HEIGHT, contentLines.length)}/${contentLines.length}`;
						const pct = maxScroll > 0 ? `${Math.round((scrollOffset / maxScroll) * 100)}%` : "100%";

						const row = (c: string): string => {
							return theme.fg("border", "│") + " " + truncateToWidth(c, innerW - 2, "...", true) + " " + theme.fg("border", "│");
						};

						const titleText = " ⌘ Help ";
						const titleW = visibleWidth(titleText);
						const leftDash = "─".repeat(Math.floor((innerW - titleW) / 2));
						const rightDash = "─".repeat(Math.max(0, innerW - titleW - leftDash.length));
						const topBorder =
							theme.fg("border", "╭" + leftDash) +
							theme.fg("accent", theme.bold(titleText)) +
							theme.fg("border", rightDash + "╮");

						const scrollInfo = `${pos} ${pct}`;
						const scrollLeft = " ↑↓/j/k · PgUp/PgDn · Home/End · q/Esc close";
						const scrollPad = " ".repeat(Math.max(1, innerW - 2 - visibleWidth(scrollLeft) - visibleWidth(scrollInfo)));
						const helpContent = theme.fg("dim", scrollLeft) + scrollPad + theme.fg("dim", scrollInfo);

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
	};

	pi.registerCommand("help", {
		description: "Show all commands, shortcuts, and extensions",
		handler: showHelp,
	});

	pi.registerShortcut(Key.ctrl("/"), {
		description: "Show help",
		handler: async (ctx) => {
			await showHelp("", ctx);
		},
	});
}
