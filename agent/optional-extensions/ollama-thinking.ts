/**
 * Ollama Thinking Block Parser
 *
 * When using Ollama models via the OpenAI-compatible API, thinking/reasoning
 * is often returned as raw <think>...</think> tags in the text content rather
 * than as structured thinking content blocks.
 *
 * This extension intercepts assistant messages at finalization, extracts any
 * <think>...</think> tags, and converts them into proper `thinking` content
 * blocks that Pi's built-in renderer handles natively (italic thinkingText
 * color, collapsible via Ctrl+T, etc.).
 *
 * Usage:
 *   pi -e extensions/ollama-thinking.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;

		const content = event.message.content;
		if (!Array.isArray(content)) return;

		// Check if any text parts contain <think> tags
		const hasThinkTags = content.some(
			(part: any) => part.type === "text" && /<think[\s>]/i.test(part.text)
		);
		if (!hasThinkTags) return;

		// Build new content array, expanding <think> blocks into thinking content parts
		const newContent: any[] = [];

		for (const part of content) {
			if (part.type !== "text") {
				newContent.push(part);
				continue;
			}

			const text: string = part.text;
			const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
			let lastIndex = 0;
			let match: RegExpExecArray | null;

			while ((match = thinkRegex.exec(text)) !== null) {
				// Add any text before this <think> block
				const before = text.slice(lastIndex, match.index).trim();
				if (before) {
					newContent.push({ type: "text", text: before });
				}

				// Add the thinking content as a proper thinking block
				const thinkingText = match[1].trim();
				if (thinkingText) {
					newContent.push({ type: "thinking", thinking: thinkingText });
				}

				lastIndex = match.index + match[0].length;
			}

			// Add any remaining text after the last </think>
			const remaining = text.slice(lastIndex).trim();
			if (remaining) {
				newContent.push({ type: "text", text: remaining });
			}
		}

		// Only return modified message if we actually transformed something
		if (newContent.length === 0) return;

		return {
			message: {
				...event.message,
				content: newContent,
			},
		};
	});
}
