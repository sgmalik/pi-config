import { appendFileSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { unlink, writeFile, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ReadToolInput, AgentMessage } from "@earendil-works/pi-coding-agent";
import { createReadTool, isBashToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type ReadInput = ReadToolInput & {
	raw?: boolean;
	symbol?: string;
};

type TextEdit = {
	oldText: string;
	newText: string;
};

type EditInput = {
	path: string;
	edits: TextEdit[];
};

type RefactorResponse = {
	success?: boolean;
	pre_flight_error?: string;
	diagnostics?: {
		compiler_error?: string;
		output_summary?: string;
		pipeline_stage?: string;
		diff?: string;
	};
};

const EXEC_TIMEOUT_MS = 120_000;
const MISSING_BINARY_MARKER = "refactor binary not found";
const MISSING_BINARY_MESSAGE = `${MISSING_BINARY_MARKER}. Run 'make install' to set it up, then try again.`;
const REQUIRED_SCHEMA_VERSION = 1;
const SCHEMA_VERSION_MARKER = "refactor schema version mismatch";
const LOG_FILE_PATH = join(homedir(), "pi-go-refactor.log");
const CONFIG_FILE_PATH = join(homedir(), "pi-go-refactor.json");

// System prompt tweaking is opt-in: it only runs when the config file
// exists and sets "systemPrompt": { "optimize": true }. Absent file or
// any parse error means the prompt passes through untouched.
type RouterConfig = {
	systemPrompt?: { optimize?: boolean };
};

const DEFAULT_CONFIG: RouterConfig = { systemPrompt: { optimize: false } };

export function ensureConfigFile(path: string = CONFIG_FILE_PATH): boolean {
	try {
		readFileSync(path, "utf-8");
		return false;
	} catch {
		// File missing: create it with defaults so the user can discover and
		// edit it. Write failures are non-fatal; defaults still apply.
	}
	try {
		writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf-8");
		return true;
	} catch {
		return false;
	}
}

export function loadConfig(path: string = CONFIG_FILE_PATH): RouterConfig {
	ensureConfigFile(path);
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as RouterConfig;
		if (parsed && typeof parsed === "object") {
			return parsed;
		}
	} catch {
		// Missing or invalid config file: defaults apply (optimize off).
	}
	return {};
}
const WAKEY_MAX_TURNS = 12;
const WAKEY_MAX_CONTINUE_CTX = 40 * 1024;
const WAKEY_HEALTH_URL = process.env.HARNESS_HEALTH_URL || "http://localhost:8000/health";
const WAKEY_DENYLIST = [
	"go build",
	"go test",
	"go vet",
	"go run",
	"go install",
	"go mod",
	"git",
	"make",
	"npm",
	"yarn",
	"pnpm",
	"cargo",
	"docker",
	"task",
];

async function getWakeyContextLength(): Promise<number | null> {
	try {
		const res = await fetch(WAKEY_HEALTH_URL, { signal: AbortSignal.timeout(2000) });
		if (!res.ok) return null;
		const data = (await res.json()) as any;
		const promptLen = data?.session_bank?.last_prefix_diagnostic?.prompt_len;
		return typeof promptLen === "number" ? promptLen : null;
	} catch {
		return null;
	}
}

function extractAssistantText(messages: AgentMessage[]): string {
	const assistantMsgs = messages.filter((m) => m.role === "assistant");
	if (assistantMsgs.length === 0) return "";
	const lastMsg = assistantMsgs[assistantMsgs.length - 1];
	if (typeof lastMsg.content === "string") return lastMsg.content;
	if (Array.isArray(lastMsg.content)) {
		return lastMsg.content
			.filter((b: any) => b.type === "text" && b.text)
			.map((b: any) => b.text)
			.join(" ");
	}
	return "";
}

function logToFile(level: "INFO" | "ERROR" | "WARN", message: string, details?: unknown) {
	try {
		const timestamp = new Date().toISOString();
		const payload = details
			? `${timestamp} [${level}] ${message}\n${JSON.stringify(details, null, 2)}\n`
			: `${timestamp} [${level}] ${message}\n`;
		appendFileSync(LOG_FILE_PATH, payload, "utf-8");
	} catch {
		// Silently prevent logger failures from breaking tool execution
	}
}

export function isSystemPromptOptimizeEnabled(): boolean {
	return loadConfig().systemPrompt?.optimize === true;
}

const readSchema = Type.Object({
	path: Type.String({
		description: "Path to file or directory. For Go files, passing ONLY 'path' returns a light structural outline (function signatures, types, structs) without bodies."
	}),
	symbol: Type.Optional(
		Type.String({
			description: "Go symbol name (function, type, struct, or variable) to read its full implementation body. Use this AFTER inspecting the file outline.",
		}),
	),
	offset: Type.Optional(Type.Number({
		description: "Line offset. For non-Go files or raw grep hits ONLY. Do not use for Go files — pass 'symbol' instead."
	})),
	limit: Type.Optional(Type.Number({
		description: "Maximum number of lines to return."
	})),
	raw: Type.Optional(
		Type.Boolean({
			description: "Force raw file read. Set to true ONLY for files <50 lines, non-Go files, or full rewrites. Bypasses outline/symbol routing."
		}),
	),
});

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(
		Type.Object({
			oldText: Type.String({ description: "Exact text for one targeted replacement." }),
			newText: Type.String({ description: "Replacement text for this targeted edit." }),
		}),
		{
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally.",
		},
	),
});

function stripAtPrefix(inputPath: string): string {
	const trimmed = inputPath.trim();
	return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

function expandTilde(inputPath: string): string {
	if (inputPath === "~") {
		return homedir();
	}
	if (inputPath.startsWith("~/")) {
		return join(homedir(), inputPath.slice(2));
	}
	return inputPath;
}

function resolveAbsolutePath(cwd: string, inputPath: string): string {
	const clean = expandTilde(stripAtPrefix(inputPath));
	return resolve(cwd, clean);
}

async function isGoTarget(absPath: string, inputPath: string): Promise<boolean> {
	const clean = stripAtPrefix(inputPath);
	if (extname(clean).toLowerCase() === ".go") {
		return true;
	}
	try {
		const st = await stat(absPath);
		return st.isDirectory();
	} catch {
		return false;
	}
}

function trimLeadingWhitespace(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let inRawString = false;
	for (const line of lines) {
		// Preserve lines that are inside a raw string at entry: this covers both
		// interior lines and close lines (content before '`' is literal).
		// Opening lines are not yet inside the string, so their Go-source prefix
		// is safe to trim. Toggle state after the preserve decision.
		const shouldPreserve = inRawString;
		const backtickCount = (line.match(/`/g) ?? []).length;
		if (backtickCount % 2 !== 0) {
			inRawString = !inRawString;
		}
		out.push(shouldPreserve ? line : line.replace(/^[ \t]+/, ""));
	}
	return out.join("\n");
}

// compactDiff strips removed lines and context lines from a unified diff,
// keeping only file headers, hunk headers, and added lines. The caller
// already submitted oldText so it knows what was there; it only needs to
// confirm what landed.
function compactDiff(diff: string): string {
	if (!diff) return "";
	const out: string[] = [];
	for (const line of diff.split("\n")) {
		if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@") || line.startsWith("+")) {
			out.push(line);
		}
		// skip: "-" (deleted) and " " (unchanged context)
	}
	while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
	return out.join("\n");
}

function summarizeRefactorFailure(response: RefactorResponse): string {
	const stage = response.diagnostics?.pipeline_stage ? `[${response.diagnostics.pipeline_stage}] ` : "";
	return (
		response.pre_flight_error ||
		response.diagnostics?.compiler_error ||
		response.diagnostics?.output_summary ||
		`${stage}refactor reported failure`
	);
}

async function runRefactorCommand(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	args: string[],
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
	await assertRefactorBinary(pi, ctx, signal);
	return await pi.exec("refactor", args, {
		cwd: ctx.cwd,
		signal,
		timeout: EXEC_TIMEOUT_MS,
	});
}

function failIfNonZero(result: { stdout: string; stderr: string; code: number }, label: string): void {
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		throw new Error(`${label} failed: ${detail}`);
	}
}

async function readGoOutline(pi: ExtensionAPI, ctx: ExtensionContext, targetPath: string, signal?: AbortSignal): Promise<string> {
	const result = await runRefactorCommand(pi, ctx, ["outline", targetPath], signal);
	failIfNonZero(result, `refactor outline for '${targetPath}'`);
	if (result.stdout.trim() === "") {
		throw new Error(`refactor outline produced no source for '${targetPath}'`);
	}
	return result.stdout;
}

async function readGoBody(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	targetPath: string,
	symbol: string,
	signal?: AbortSignal,
): Promise<string> {
	const result = await runRefactorCommand(pi, ctx, ["body", targetPath, symbol], signal);
	failIfNonZero(result, `refactor body for '${targetPath}' symbol '${symbol}'`);
	return result.stdout;
}

async function readRawFileDirect(filePath: string, offset?: number, limit?: number): Promise<string> {
	const content = await readFile(filePath, "utf-8");
	if (offset === undefined && limit === undefined) {
		return content;
	}
	const lines = content.split("\n");
	const start = offset && offset > 0 ? offset - 1 : 0;
	const end = limit && limit > 0 ? start + limit : lines.length;
	return lines.slice(start, end).join("\n");
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

function isImagePath(targetPath: string): boolean {
	return IMAGE_EXTENSIONS.has(extname(targetPath).toLowerCase());
}

async function editFileDirect(filePath: string, edits: TextEdit[]): Promise<void> {
	const content = await readFile(filePath, "utf-8");
	type Match = { start: number; end: number; newText: string; index: number };
	const matches: Match[] = [];
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		if (edit.oldText === "") {
			throw new Error(`edit[${i}]: oldText must not be empty`);
		}
		const idx = content.indexOf(edit.oldText);
		if (idx === -1) {
			throw new Error(`edit[${i}]: oldText matched 0 times in '${filePath}'`);
		}
		const nextIdx = content.indexOf(edit.oldText, idx + 1);
		if (nextIdx !== -1) {
			throw new Error(`edit[${i}]: oldText matched multiple times in '${filePath}'`);
		}
		matches.push({
			start: idx,
			end: idx + edit.oldText.length,
			newText: edit.newText,
			index: i,
		});
	}
	matches.sort((a, b) => a.start - b.start);
	for (let i = 1; i < matches.length; i++) {
		if (matches[i - 1].end > matches[i].start) {
			throw new Error(`edits overlap: edit[${matches[i - 1].index}] and edit[${matches[i].index}]`);
		}
	}
	let result = "";
	let cursor = 0;
	for (const match of matches) {
		result += content.slice(cursor, match.start);
		result += match.newText;
		cursor = match.end;
	}
	result += content.slice(cursor);
	await writeFile(filePath, result, "utf-8");
}

const HOME_DIR = homedir();
const DECORATIVE_LINE = /^[═─\-_=\*]{3,}$/;

// Memoized preflight check for refactor binary availability
let binaryChecked = false;
let binaryAvailable = false;
let binaryError: Error | null = null;

async function assertRefactorBinary(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
	if (binaryChecked) {
		if (binaryError) throw binaryError;
		if (!binaryAvailable) throw new Error("refactor binary not available");
		return;
	}
	// pi.exec spawns directly (shell: false) and swallows spawn failures
	// (including ENOENT for a missing binary) into a resolved result with
	// code:1 and empty stdout/stderr — it never rejects. So invoking
	// `refactor` itself can't distinguish "missing" from "ran and failed".
	// `which` is virtually always present, so its own exit code reliably
	// tells us whether `refactor` resolves on PATH.
	binaryChecked = true;
	const result = await pi.exec("which", ["refactor"], {
		cwd: ctx.cwd,
		signal,
		timeout: 5000,
	});
	if (result.code === 0 && result.stdout.trim() !== "") {
		// Binary found — check schema version compatibility.
		const versionResult = await pi.exec("refactor", ["version"], {
			cwd: ctx.cwd,
			signal,
			timeout: 5000,
		});
		if (versionResult.code !== 0) {
			binaryError = new Error(
				`${SCHEMA_VERSION_MARKER}: 'refactor version' failed (CLI may be out of date). Run 'make install' to rebuild, then try again.`,
			);
			throw binaryError;
		}
		let schemaVersion: number | undefined;
		try {
			const parsed = JSON.parse(versionResult.stdout) as { schema_version?: number };
			schemaVersion = parsed.schema_version;
		} catch {
			// unparseable output — treat as unknown version
		}
		if (schemaVersion !== REQUIRED_SCHEMA_VERSION) {
			binaryError = new Error(
				`${SCHEMA_VERSION_MARKER}: plugin expects schema_version ${REQUIRED_SCHEMA_VERSION}, CLI reports ${schemaVersion ?? "unknown"}. Run 'make install' to rebuild, then try again.`,
			);
			throw binaryError;
		}
		logToFile("INFO", `refactor CLI compatible (schema_version=${schemaVersion})`);
		binaryAvailable = true;
		return;
	}
	binaryError = new Error(MISSING_BINARY_MESSAGE);
	throw binaryError;
}

async function openInstallReadme(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	try {
		const currentFile = fileURLToPath(import.meta.url);
		const realPath = realpathSync(currentFile);
		const extensionsDir = dirname(realPath);
		const piDir = dirname(extensionsDir);
		const appDir = dirname(piDir);
		const readmeFile = join(appDir, "README.md");

		let opener: string;
		if (process.platform === "darwin") {
			opener = "open";
		} else if (process.platform === "linux") {
			opener = "xdg-open";
		} else if (process.platform === "win32") {
			opener = "start";
		} else {
			logToFile("WARN", "Unknown platform for README opener", { platform: process.platform });
			return;
		}

		try {
			await pi.exec(opener, [readmeFile], {
				cwd: ctx.cwd,
				timeout: 5000,
			});
		} catch (execError) {
			logToFile("WARN", `Failed to open README with ${opener}`, {
				error: execError instanceof Error ? execError.message : String(execError),
			});
		}
	} catch (error) {
		const errMessage = error instanceof Error ? error.message : String(error);
		logToFile("ERROR", "openInstallReadme failed", { error: errMessage });
	}
}

function isMissingBinaryError(error: unknown): boolean {
	// Match only our own exact marker, not a generic "not found" substring —
	// that would misfire on unrelated errors (e.g. "symbol not found") and
	// wrongly tell the user the binary is missing.
	return error instanceof Error && error.message.includes(MISSING_BINARY_MARKER);
}

async function reportMissingBinary(pi: ExtensionAPI, ctx: ExtensionContext, prefix: string): Promise<never> {
	// Fire-and-forget: the tool error below surfaces immediately; the README
	// opens shortly after as a background side effect, not before.
	openInstallReadme(pi, ctx).catch(() => {
		// Silently swallow errors from README opener
	});
	throw new Error(`${prefix} ${MISSING_BINARY_MESSAGE}`);
}
const SIMPLIFY_PROMPT_BODY = `You are an expert code simplification specialist focused on enhancing code clarity, consistency, and maintainability while preserving exact functionality. Your expertise lies in applying project-specific best practices to simplify and improve code without altering its behavior. You prioritize readable, explicit code over overly compact solutions. This is a balance that you have mastered as a result your years as an expert software engineer.

You will analyze recently modified code and apply refinements that:

1. **Preserve Functionality**: Never change what the code does - only how it does it. All original features, outputs, and behaviors must remain intact.

2. **Go tips. Caveman.** Codebase break these. Fix:

   - **No string enum.** \`Status string // "applied"|"queued"\`. Bad. Make \`type Status string\` with \`const\` values. Compiler catch typo. Codebase has \`Status string\`, \`Type string\`, \`MatchType string\` everywhere — wrap them.
   - **\`any\` not \`interface{}\`.** 1000+ \`interface{}\` in repo. Go 1.18+. Use \`any\`. Same thing, less ugly. \`map[string]any\` not \`map[string]interface{}\`.
   - **Wrap err with \`%w\`, lowercase, no period.** \`fmt.Errorf("load config: %w", err)\`. Not \`"Failed to load: %v"\`. \`%w\` keep chain. \`errors.Is\`/\`errors.As\` work.
   - **No panic in runtime code.** Panic only \`init\`/\`main\` startup or truly impossible. Return error. Codebase has \`panic(err)\` in request paths — bad.
   - **Don't ignore err with \`_\`.** If you \`_ = thing.Close()\`, at least \`defer\` and log. Silent fail = ghost bug.
   - **Accept interface, return struct.** Narrow input, concrete output. Don't define interface near impl — define near consumer.
   - **Context first arg, named \`ctx\`.** Pass through. No \`context.TODO()\` in committed code.
   - **Small interface.** 1-3 method. Big interface = wrong abstraction.
   - **No naked return** in long func. Hides what come back.
   - **Receiver name short, consistent.** All method on \`*Server\` use \`s\`. Not mix \`srv\`, \`server\`, \`s\`.

3. **Enhance Clarity**: Simplify code structure by:

   - Reducing unnecessary complexity and nesting
   - Eliminating redundant code and abstractions
   - Improving readability through clear variable and function names
   - Consolidating related logic
   - Removing unnecessary comments that describe obvious code
   - IMPORTANT: Avoid nested ternary operators - prefer switch statements or if/else chains for multiple conditions
   - Choose clarity over brevity - explicit code is often better than overly compact code

4. **Maintain Balance**: Avoid over-simplification that could:

   - Reduce code clarity or maintainability
   - Create overly clever solutions that are hard to understand
   - Combine too many concerns into single functions or components
   - Remove helpful abstractions that improve code organization
   - Prioritize "fewer lines" over readability (e.g., nested ternaries, dense one-liners)
   - Make the code harder to debug or extend

5. **Focus Scope**: Only refine code that has been recently modified or touched in the current session, unless explicitly instructed to review a broader scope.

Your refinement process:

1. Identify the recently modified code sections
2. Analyze for opportunities to improve elegance and consistency
3. Apply project-specific best practices and coding standards
4. Ensure all functionality remains unchanged
5. Verify the refined code is simpler and more maintainable
6. Document only significant changes that affect understanding

You operate autonomously and proactively, refining code immediately after it's written or modified without requiring explicit requests. Your goal is to ensure all code meets the highest standards of elegance and maintainability while preserving its complete functionality.`;

const LO_PROMPT_BODY = `Scan target Go files for imperative for range loops performing collection operations. Refactor them to idiomatic [github.com/samber/lo](https://github.com/samber/lo) functional helpers:

Filter/Map: Replace loop-and-append with lo.Filter, lo.Map, or lo.FilterMap.

Search/Validate: Replace manual lookup loops with lo.Contains, lo.Some, or lo.Every.

Grouping/Dedupe: Replace manual map/slice logic with lo.Uniq, lo.GroupBy, or lo.KeyBy.

Add import "[github.com/samber/lo](https://github.com/samber/lo)". Ensure type parameters match, preserve exact logic/side-effects, remove redundant slice initializations, and run existing tests to verify zero regressions.`;

export function transformSystemPrompt(rawPrompt: string): string {
	// 1. Path substitution: home directory → ~
	let text = rawPrompt.split(HOME_DIR).join("~");

	// 2. Fence-aware line trimming + 3. blank-line normalization + 4. decorative-line stripping
	const lines = text.split("\n");
	const out: string[] = [];
	let inCodeBlock = false;
	let blankRun = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("```")) {
			inCodeBlock = !inCodeBlock;
			out.push(inCodeBlock ? line : line.trimEnd());
			blankRun = 0;
			continue;
		}
		if (inCodeBlock) {
			if (trimmed === "") {
				blankRun += 1;
				if (blankRun === 1) {
					out.push("");
				}
			} else {
				blankRun = 0;
				out.push(line);
			}
			continue;
		}
		if (trimmed === "") {
			blankRun += 1;
			if (blankRun === 1) {
				out.push("");
			}
			continue;
		}
		if (DECORATIVE_LINE.test(trimmed)) {
			continue;
		}
		blankRun = 0;
		out.push(trimmed);
	}
	// 3 (cont.). Remove leading and trailing blank lines
	while (out.length > 0 && out[0] === "") {
		out.shift();
	}
	while (out.length > 0 && out[out.length - 1] === "") {
		out.pop();
	}
	return out.join("\n");
}

function toEditFileRequest(params: EditInput) {
	return {
		transaction_id: `pi_go_edit_${Date.now()}`,
		compile_only: false,
		operations: [
			{
				op: "edit_file",
				file: stripAtPrefix(params.path),
				edits: params.edits.map((edit) => ({
					old_text: edit.oldText,
					new_text: edit.newText,
				})),
			},
		],
	};
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const optimize = config.systemPrompt?.optimize === true;
	logToFile("INFO", "router config loaded", {
		configFile: CONFIG_FILE_PATH,
		systemPromptOptimize: optimize,
	});

	// System-prompt optimization is opt-in and self-gates on every agent
	// start. Tool registration (read/edit) and commands (/go, /lo, /sr) are
	// unconditional: they must be available regardless of the prompt toggle.
	if (optimize) {
		logToFile("INFO", "system prompt tweaking enabled");
	} else {
		logToFile("INFO", "system prompt tweaking disabled (opt-in not set); prompt passes through unchanged");
	}

	// Re-read the config on every agent start so the toggle takes effect
	// without restarting the pi session. The handler self-gates when the
	// opt-in is off, so it is safe to register unconditionally.
	pi.on("before_agent_start", async (event, ctx) => {
		logToFile("INFO", "session interactivity", {
			hasUI: (ctx as any).hasUI ?? false,
			isTTY: process.stdout.isTTY ?? false,
		});

		// Probe: log getBranch() shape for context-deduplication design. TODO: remove once confirmed.
		try {
			const branch = (ctx as any).sessionManager?.getBranch?.();
			logToFile("INFO", "getBranch probe", branch !== undefined ? {
				isArray: Array.isArray(branch),
				keys: !Array.isArray(branch) ? Object.keys(branch as object).slice(0, 8) : "n/a",
				length: Array.isArray(branch) ? (branch as any[]).length : (branch as any)?.messages?.length,
				tail: Array.isArray(branch)
					? (branch as any[]).slice(-2).map((m: any) => ({ role: m.role, type: typeof m.content }))
					: "n/a",
			} : { result: "undefined" });
		} catch (e) {
			logToFile("INFO", "getBranch probe error", { error: String(e) });
		}

		try {
			// Preflight: check refactor binary is available
			await assertRefactorBinary(pi, ctx);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logToFile("ERROR", "refactor binary preflight check failed", { error: msg });
			// Only notify here — the README should open once an actual tool
			// call fails and its error is surfaced, not proactively before the
			// agent has even attempted anything this turn.
			ctx?.ui?.notify(`Refactor setup issue: ${msg}`, "error");
			logToFile("ERROR", "before_agent_start preflight failed", { error: msg });
		}

		if (!isSystemPromptOptimizeEnabled()) {
			logToFile("INFO", "system prompt tweak skipped (opt-in disabled at agent start)");
			return;
		}
		const before = event.systemPrompt.length;
		const after = transformSystemPrompt(event.systemPrompt);
		logToFile("INFO", "system prompt optimized", {
			beforeChars: before,
			afterChars: after.length,
			savedChars: before - after.length,
		});
		return { systemPrompt: after };
	});

	// --- Wakey: autonomous-run alarm + continuation loop -------------------
	let isArmed = false;
	let turnCount = 0;
	let alertInterval: NodeJS.Timeout | null = null;
	let keyListener: ((data: Buffer) => void) | null = null;

	const stopAlert = () => {
		if (alertInterval) {
			clearInterval(alertInterval);
			alertInterval = null;
		}
		if (keyListener) {
			process.stdin.removeListener("data", keyListener);
			keyListener = null;
		}
	};

	const flashScreen = (times = 2) => {
		for (let i = 0; i < times; i++) {
			setTimeout(() => {
				process.stdout.write("\x07\x1b[?5h");
				setTimeout(() => process.stdout.write("\x1b[?5l"), 120);
			}, i * 250);
		};
	};

	const triggerChime = () => {
		process.stdout.write("\x07\x1b[?5h");
		setTimeout(() => {
			process.stdout.write("\x1b[?5l");
		}, 150);
	};

	const disarmAndAlert = (reason: string, level: "info" | "warning" = "info", ctx?: any, isBlocked = false) => {
		isArmed = false;
		turnCount = 0;
		stopAlert();

		ctx?.ui?.notify(`[wakey] ${reason}`, level);

		// Only fire terminal bells and listen for keypresses in an interactive
		// session. In headless/CI/pipe mode, ANSI codes would corrupt logs.
		if (process.stdout.isTTY === true && ctx?.hasUI === true) {
			if (isBlocked) {
				flashScreen(3);
			} else {
				triggerChime();
			}

			alertInterval = setInterval(triggerChime, 2500);

			keyListener = () => {
				stopAlert();
			};
			process.stdin.once("data", keyListener);
		}
	};

	// /go - run an instruction autonomously; keep going until WAKEY_DONE.
	pi.registerCommand("go", {
		description: "Run instruction and sound the Wakey alarm when finished",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /go <instruction>", "warning");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy. Wait for current task to finish.", "warning");
				return;
			}

			isArmed = true;
			turnCount = 0;
			stopAlert();

			const promptWithProtocol = [
				args.trim(),
				"---",
				"Autonomously fulfill request. Append WAKEY_DONE when complete/verified, or WAKEY_BLOCKED: if stuck.",
			].join("\n");

			pi.sendUserMessage(promptWithProtocol);
		},
	});

	// When Pi finishes processing and goes idle: if armed, keep the agent
	// going (up to WAKEY_MAX_TURNS or context limit) until it reports
	// WAKEY_DONE or WAKEY_BLOCKED.
	pi.on("agent_end", async (event, ctx) => {
		if (!isArmed) return;

		const lastText = extractAssistantText(event.messages ?? []);

		if (lastText.includes("WAKEY_DONE")) {
			disarmAndAlert("Task completed (WAKEY_DONE).", "info", ctx);
			return;
		}

		const blockedMatch = lastText.match(/WAKEY_BLOCKED:\s*(.*)/i);
		if (blockedMatch) {
			disarmAndAlert(`Agent blocked: ${blockedMatch[1] || "needs input"}`, "warning", ctx, true);
			return;
		}

		turnCount++;
		if (WAKEY_MAX_TURNS > 0 && turnCount >= WAKEY_MAX_TURNS) {
			disarmAndAlert(`Hit max turn limit (${WAKEY_MAX_TURNS}). Review progress.`, "warning", ctx, true);
			return;
		}

		const ctxLen = await getWakeyContextLength();
		if (ctxLen !== null && ctxLen >= WAKEY_MAX_CONTINUE_CTX) {
			disarmAndAlert(`Context limit reached (${ctxLen}).`, "warning", ctx);
			return;
		}

		ctx?.ui?.notify(`[wakey] Turn ${turnCount}/${WAKEY_MAX_TURNS} ended without WAKEY_DONE. Continuing...`, "info");
		pi.sendUserMessage(
			"Continue working to complete the task. Fix any remaining errors and verify. Output 'WAKEY_DONE' when completely finished, or 'WAKEY_BLOCKED: ' if stuck.",
			{ deliverAs: "followUp" },
		);
	});

	pi.on("agent_start", async () => {
		stopAlert();
	});

	// Single tool_result handler for probe-is-benign behavior.
	pi.on("tool_result", (event, ctx) => {
		// --- Probe-is-benign (bash errors only) ---
		try {
			if (!isBashToolResult(event) || !event.isError) return;
			const command = String(event.input?.command ?? "");
			const denied = WAKEY_DENYLIST.some((w) => new RegExp(`\\b${w}\\b`).test(command));
			if (denied) {
				return { content: [...event.content, { type: "text" as const, text: "Verifying/mutating command failed — this is a real error. Investigate before proceeding." }] };
			}
			return {
				isError: false,
				content: [...event.content, { type: "text" as const, text: "[wakey] Non-zero exit on a read-only command — treated as a benign probe (e.g. a missing path). The output above is valid; continue, do not halt." }],
			};
		} catch {
			return;
		}
	});

	pi.registerTool({
		name: "read",
		label: "read",
		description:
			"Read file or package contents. For .go files or directories, returns AST outline by default; use symbol for one body, raw=true for full source, or offset/limit for raw line ranges.",
		parameters: readSchema,
		promptSnippet: "Read file or package contents",
		promptGuidelines: [
			"To read a Go package or file outline: call read with file or directory path.",
			"To read a Go function or method body, pass symbol='Type.Method' or symbol='funcName'.",
			"FORBIDDEN: Do not use offset/limit on Go files to inspect known functions; always use symbol.",
			"Never grep, sed or ffgrep for Go symbol names. Use bash('refactor find <name> --body') instead.",
		],
		prepareArguments(args: Record<string, unknown>) {
			const rawPath = args.path;
			if (typeof rawPath !== "string" || rawPath.trim() === "") {
				logToFile("ERROR", "read prepareArguments rejected malformed path", { args });
				throw new Error("read: 'path' must be a non-empty string");
			}
			return {
				...args,
				path: stripAtPrefix(rawPath),
			};
		},
		async execute(toolCallId, input, signal, onUpdate, ctx) {
			const params = input as ReadInput;
			const targetPath = stripAtPrefix(params.path);
			const absPath = resolveAbsolutePath(ctx.cwd, targetPath);
			const symbol = typeof params.symbol === "string" ? params.symbol.trim() : "";
			const hasLineRange = typeof params.offset === "number" || typeof params.limit === "number";

			// Delegate images to pi's built-in read tool verbatim (outside the
			// try/catch, so results/errors pass through unwrapped). Checking by
			// extension avoids an extra fs call, which matters for ephemeral
			// sources like macOS screenshot temp files that can vanish between
			// filesystem touches.
			if (isImagePath(targetPath)) {
				const builtinRead = createReadTool(ctx.cwd);
				return await builtinRead.execute(toolCallId, params, signal, onUpdate);
			}

			try {
				const isTargetGoOrDir = await isGoTarget(absPath, targetPath);

				// Route Go files/dirs to refactor unless the caller explicitly wants raw bytes (raw=true or a line range).
				const shouldRoute = isTargetGoOrDir && !params.raw && !hasLineRange;

				if (!shouldRoute) {
					let content = await readRawFileDirect(absPath, params.offset, params.limit);
					if (extname(targetPath).toLowerCase() === ".go") {
						content = trimLeadingWhitespace(content);
					}
					return {
						content: [{ type: "text" as const, text: content }],
					};
				}

				const routedSource =
					symbol !== ""
						? await readGoBody(pi, ctx, targetPath, symbol, signal)
						: await readGoOutline(pi, ctx, targetPath, signal);

				return {
					content: [{ type: "text" as const, text: routedSource }],
				};
			} catch (error) {
				const errMessage = error instanceof Error ? error.message : String(error);
				const stack = error instanceof Error ? error.stack : undefined;

				if (isMissingBinaryError(error)) {
					logToFile("ERROR", `read failed: refactor binary missing (toolCallId: ${toolCallId})`, {
						input,
						targetPath,
					});
					await reportMissingBinary(pi, ctx, "[go-refactor read error]");
				}

				logToFile("ERROR", `read execution failed for toolCallId: ${toolCallId}`, {
					input,
					targetPath,
					absPath,
					cwd: ctx.cwd,
					error: errMessage,
					stack,
				});

				throw new Error(`[go-refactor read error] ${errMessage}`);
			}
		},
	});

	pi.registerTool({
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. For .go files, edits are routed through refactor edit_file.",
		parameters: editSchema,
		promptSnippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		promptGuidelines: [
			"FORBIDDEN: Do not use 'sed', 'awk', 'perl', or shell redirection to edit files.",
			"Use edit for precise changes (edits[].oldText must match exactly).",
			"Each edit is matched against the original file, not incrementally.",
		],
		prepareArguments(args: Record<string, unknown>) {
			const rawPath = args.path;
			if (typeof rawPath !== "string" || rawPath.trim() === "") {
				logToFile("ERROR", "edit prepareArguments rejected malformed path", { args });
				throw new Error("edit: 'path' must be a non-empty string");
			}
			return {
				...args,
				path: stripAtPrefix(rawPath),
			};
		},
		async execute(toolCallId, input, signal, onUpdate, ctx) {
			const params = input as EditInput;
			const targetPath = stripAtPrefix(params.path);
			const absPath = resolveAbsolutePath(ctx.cwd, targetPath);
			const isGoFile = extname(targetPath).toLowerCase() === ".go";

			try {
				if (!Array.isArray(params.edits) || params.edits.length === 0) {
					throw new Error("Edit routing requires at least one edit block.");
				}

				if (!isGoFile) {
					await editFileDirect(absPath, params.edits);
					return {
						content: [
							{
								type: "text" as const,
								text: `Successfully replaced ${params.edits.length} block(s) in ${targetPath}.`,
							},
						],
					};
				}

				const request = toEditFileRequest({
					...params,
					path: targetPath,
				});

				const requestPath = join(tmpdir(), `refactor-pi-edit-${randomUUID()}.json`);

				try {
					await writeFile(requestPath, JSON.stringify(request, null, 2), "utf-8");
					const result = await runRefactorCommand(pi, ctx, ["--file", requestPath], signal);
					if (result.code !== 0) {
						const stderr = result.stderr.trim();
						const stdout = result.stdout.trim();
						throw new Error(
							`refactor edit failed for '${targetPath}': ${stderr || stdout || `exit code ${result.code}`}`,
						);
					}

					let response: RefactorResponse;
					try {
						response = JSON.parse(result.stdout) as RefactorResponse;
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						throw new Error(`invalid JSON from refactor edit for '${targetPath}': ${message}`);
					}

					if (!response.success) {
						throw new Error(summarizeRefactorFailure(response));
					}

					const diff = response.diagnostics?.diff;
					const diffSection = diff ? `\n\n${compactDiff(diff)}` : "";
					return {
						content: [
							{
								type: "text" as const,
								text: `Updated ${targetPath.split('/').pop()}${diffSection}`,
							},
						],
					};
				} catch (error) {
					const errMessage = error instanceof Error ? error.message : String(error);
					if (isMissingBinaryError(error)) {
						logToFile("ERROR", `edit failed: refactor binary missing (toolCallId: ${toolCallId})`);
						await reportMissingBinary(pi, ctx, "[go-refactor edit error]");
					}
					logToFile("WARN", `refactor edit_file failed for '${targetPath}'`, { error: errMessage });
					throw error;
				} finally {
					await unlink(requestPath).catch(() => { });
				}
			} catch (error) {
				const errMessage = error instanceof Error ? error.message : String(error);
				const stack = error instanceof Error ? error.stack : undefined;

				if (isMissingBinaryError(error)) {
					logToFile("ERROR", `edit failed: refactor binary missing (toolCallId: ${toolCallId})`, {
						input,
						targetPath,
					});
					await reportMissingBinary(pi, ctx, "[go-refactor edit error]");
				}

				logToFile("ERROR", `edit execution failed for toolCallId: ${toolCallId}`, {
					input,
					targetPath,
					absPath,
					cwd: ctx.cwd,
					error: errMessage,
					stack,
				});

				throw new Error(`[go-refactor edit error] ${errMessage}`);
			}
		},
	});

	// /lo - lo refactor: arm the wakey loop and emit the samber/lo
	// loop-refactoring prompt; the agent keeps going until it reports
	// WAKEY_DONE or WAKEY_BLOCKED, same as /go.
	pi.registerCommand("lo", {
		description: "Refactor imperative for range loops to samber/lo functional helpers. Usage: /lo [target files or directory]",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy. Wait for current task to finish.", "warning");
				return;
			}

			isArmed = true;
			turnCount = 0;
			stopAlert();

			const target = args?.trim() ?? "";
			const targetNote =
				target !== ""
					? `\n\nTarget: ${target}.`
					: "\n\nTarget: the Go files recently modified or discussed in this session.";
			const promptWithProtocol = [
				LO_PROMPT_BODY + targetNote,
				"---",
				"Autonomously fulfill request. Append WAKEY_DONE when complete/verified, or WAKEY_BLOCKED:  if stuck.",
			].join("\n");

			pi.sendUserMessage(promptWithProtocol);
		},
	});

	// /sr - simplify refactor: emit the code-simplifier skill body as a prompt
	// for the agent to apply to recently modified code.
	pi.registerCommand("sr", {
		description: "Simplify refactor: apply the code-simplifier skill to recently modified code. Usage: /sr [scope]",
		handler: async (args, ctx) => {
			try {
				const scope = args?.trim() ?? "";
				const scopeNote =
					scope !== ""
						? `\n\nScope: apply the simplification to ${scope}.`
						: "";
				pi.sendMessage(
					{
						customType: "simplify-refactor",
						content: `${SIMPLIFY_PROMPT_BODY}${scopeNote}`,
						display: true,
					},
					{ triggerTurn: true },
				);
			} catch (error) {
				const errMessage = error instanceof Error ? error.message : String(error);
				logToFile("ERROR", "/sr simplify command failed", { error: errMessage });
				ctx.ui.notify(`simplify refactor failed: ${errMessage}`, "error");
			}
		},
	});
}