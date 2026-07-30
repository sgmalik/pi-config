/**
 * Reasoning generation — uses an LLM call to generate concise per-file
 * explanations of why changes were made, based on the diffs and conversation context.
 */

import { complete } from "@mariozechner/pi-ai";
import type { DiffReviewFile } from "./types.js";

interface ReasoningContext {
  model: any;
  apiKey: string;
}

/**
 * Generate a unified diff summary for a file (compact, for the LLM prompt).
 */
function generateCompactDiff(file: DiffReviewFile): string {
  if (file.status === "added") {
    const lines = file.newContent.split("\n");
    if (lines.length > 120) {
      return `[New file: ${lines.length} lines]\n${lines.slice(0, 60).join("\n")}\n...\n${lines.slice(-20).join("\n")}`;
    }
    return `[New file]\n${file.newContent}`;
  }
  if (file.status === "deleted") {
    const lines = file.oldContent.split("\n");
    if (lines.length > 60) {
      return `[Deleted file, was ${lines.length} lines]\n${lines.slice(0, 30).join("\n")}\n...`;
    }
    return `[Deleted file]\n${file.oldContent}`;
  }

  // For modified files, show a simple line-level diff (compact)
  const oldLines = file.oldContent.split("\n");
  const newLines = file.newContent.split("\n");

  // Simple approach: show what was added/removed (limited)
  const oldSet = new Set(oldLines.map((l) => l.trim()));
  const newSet = new Set(newLines.map((l) => l.trim()));

  const added = newLines.filter((l) => l.trim() && !oldSet.has(l.trim()));
  const removed = oldLines.filter((l) => l.trim() && !newSet.has(l.trim()));

  const parts: string[] = [];
  if (removed.length > 0) {
    const shown = removed.slice(0, 40);
    parts.push(`Removed:\n${shown.map((l) => `- ${l}`).join("\n")}${removed.length > 40 ? `\n... (${removed.length - 40} more)` : ""}`);
  }
  if (added.length > 0) {
    const shown = added.slice(0, 40);
    parts.push(`Added:\n${shown.map((l) => `+ ${l}`).join("\n")}${added.length > 40 ? `\n... (${added.length - 40} more)` : ""}`);
  }

  return parts.join("\n\n") || "[Minor whitespace/formatting changes]";
}

/**
 * Build the prompt for the LLM to generate per-file reasoning.
 */
function buildReasoningPrompt(files: DiffReviewFile[]): string {
  const fileDescriptions = files.map((file, i) => {
    const diff = generateCompactDiff(file);
    // Limit each file's diff context to avoid token explosion
    const truncatedDiff = diff.length > 4000 ? diff.slice(0, 4000) + "\n..." : diff;
    return `## File ${i + 1}: ${file.displayPath} (${file.status})\n\n${truncatedDiff}`;
  }).join("\n\n---\n\n");

  return `You are reviewing code changes. For each file below, write a detailed explanation (3-5 sentences) of WHY these changes were made. A code reviewer reading this should understand the full context without looking at the diff.

For each file, explain:
1. What problem or requirement motivated this change
2. The approach/design decision and why it was chosen over alternatives
3. How this change fits into the broader system or feature being built
4. Any notable trade-offs, edge cases handled, or defensive patterns

Do NOT describe what the code does mechanically ("adds a function that..."). Instead explain the reasoning and intent behind the decisions.

Respond with a JSON array where each element corresponds to a file (in order). Each element should be a string with the full reasoning paragraph.

Example response format:
["The upload retry logic was needed because S3 multipart uploads frequently fail on spotty connections, especially for files >100MB. A simple exponential backoff with jitter was chosen over a circuit breaker because failures are transient and isolated per-request. The 3-retry limit with 30s max delay balances user experience against overwhelming the endpoint during regional outages. Failed parts are tracked individually so only the failed segments retry, not the entire upload.", "The schema migration adds tenant_id as a required field because the platform is moving from single-tenant to multi-tenant isolation. A NOT NULL constraint with a default ensures existing rows migrate cleanly without a backfill job. The composite index on (tenant_id, created_at) was chosen because the most common query pattern filters by tenant then sorts chronologically."]

---

${fileDescriptions}`;
}

/**
 * Parse the LLM response into per-file reasoning strings.
 */
function parseReasoningResponse(response: string, fileCount: number): string[] {
  // Try to extract JSON array from the response
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed) && parsed.length >= fileCount) {
        return parsed.slice(0, fileCount).map((item: unknown) =>
          typeof item === "string" ? item : "",
        );
      }
      // If fewer items than files, pad with empty
      if (Array.isArray(parsed)) {
        const result = parsed.map((item: unknown) => typeof item === "string" ? item : "");
        while (result.length < fileCount) result.push("");
        return result;
      }
    } catch {
      // Fall through to line-based parsing
    }
  }

  // Fallback: try to split by numbered lines
  const lines = response.split("\n").filter((l) => l.trim());
  const result: string[] = [];
  for (const line of lines) {
    const cleaned = line.replace(/^\d+[\.\)]\s*/, "").replace(/^[-*]\s*/, "").trim();
    if (cleaned) result.push(cleaned);
    if (result.length >= fileCount) break;
  }
  while (result.length < fileCount) result.push("");
  return result;
}

/**
 * Generate reasoning for all files using an LLM call.
 * Returns immediately with empty reasoning if the call fails.
 */
export async function generateFileReasoning(
  files: DiffReviewFile[],
  reasoningCtx: ReasoningContext,
): Promise<void> {
  if (files.length === 0) return;

  // Filter to files that have actual content changes
  const filesWithChanges = files.filter(
    (f) => f.status !== "deleted" || f.oldContent.trim().length > 0,
  );

  if (filesWithChanges.length === 0) return;

  // Limit to avoid overwhelming the model (batch large sets)
  const maxFiles = 30;
  const batch = filesWithChanges.slice(0, maxFiles);

  const prompt = buildReasoningPrompt(batch);

  try {
    const response = await complete(
      reasoningCtx.model,
      {
        systemPrompt: "You are a senior code reviewer explaining changes to a teammate. You provide detailed reasoning about WHY code changes were made — the problem, the design decision, the trade-offs, and how it fits the bigger picture. Write in clear, direct prose. Output valid JSON only.",
        messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }],
      },
      {
        apiKey: reasoningCtx.apiKey,
        maxTokens: 4096,
      },
    );

    const responseText = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    const reasons = parseReasoningResponse(responseText, batch.length);

    // Assign reasoning to files
    for (let i = 0; i < batch.length; i++) {
      if (reasons[i]) {
        batch[i].reasoning = [reasons[i]];
      }
    }
  } catch {
    // Non-fatal: if LLM call fails, files just won't have reasoning
  }
}
