import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiffReviewWindowData } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, "web");

function escapeForInlineScript(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

const DATA_PLACEHOLDER = "%%DIFF_REVIEW_INLINE_DATA_a9f3e7b2%%";
const JS_PLACEHOLDER = "%%DIFF_REVIEW_INLINE_JS_c4d8f1e6%%";

export function buildReviewHtml(data: DiffReviewWindowData): string {
  // Read fresh each time — files are small and this avoids stale-cache bugs
  const templateHtml = readFileSync(join(webDir, "index.html"), "utf8");
  const appJs = readFileSync(join(webDir, "app.js"), "utf8");
  const payload = escapeForInlineScript(JSON.stringify(data));

  // Replace from the END of the template first (JS placeholder comes after data placeholder)
  // to avoid collisions if file contents happen to contain placeholder strings.
  let html = templateHtml;
  const jsIndex = html.lastIndexOf(JS_PLACEHOLDER);
  if (jsIndex !== -1) {
    html = html.slice(0, jsIndex) + appJs + html.slice(jsIndex + JS_PLACEHOLDER.length);
  }
  const dataIndex = html.indexOf(DATA_PLACEHOLDER);
  if (dataIndex !== -1) {
    html = html.slice(0, dataIndex) + payload + html.slice(dataIndex + DATA_PLACEHOLDER.length);
  }
  return html;
}
