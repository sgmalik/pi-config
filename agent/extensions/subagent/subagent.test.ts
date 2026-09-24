import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { choosePaneSplit, HerdrRunner, shellQuote } from "./herdr-runner.ts";
import { appendToolArgs, resolveChildTools } from "./tool-policy.ts";
import childLifecycle from "./child-lifecycle.ts";

const rect = { x: 0, y: 0, width: 160, height: 80 };
const timings = { poll: 2, shellReady: 1, startup: 30, queryFailure: 10, exit: 30 };
const result = { version: 1, kind: "result", exitCode: 0, messages: [] };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(t: any, behavior: "success" | "hang" | "missing" | "startup" | "exit" | "query" = "success", unrelated = 0) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const panes = new Map([["parent", { ...rect }]]);
	for (let i = 0; i < unrelated; i++) panes.set(`unrelated-${i}`, { ...rect });
	let sequence = 0;
	let peak = panes.size;
	const closed: string[] = [];
	const targets: string[] = [];
	const commands: string[] = [];
	const api = {
		isHerdrAvailable: () => true,
		getHerdrLayout: () => [...panes].map(([pane_id, rect]) => ({ pane_id, rect })),
		createHerdrPane: (target: string, direction: string) => {
			targets.push(target);
			const current = panes.get(target)!;
			const next = { ...current };
			if (direction === "down") { current.height /= 2; next.height /= 2; next.y += current.height; }
			else { current.width /= 2; next.width /= 2; next.x += current.width; }
			const id = `child-${++sequence}`;
			panes.set(id, next);
			peak = Math.max(peak, panes.size);
			return id;
		},
		runHerdrCommand: (pane: string, command: string) => {
			commands.push(command);
			const script = command.slice(6, -1);
			const artifactDir = path.dirname(script);
			if (behavior === "startup") return;
			fs.writeFileSync(path.join(artifactDir, "ready"), "ready");
			if (behavior === "missing") { panes.delete(pane); return; }
			if (behavior === "exit") { fs.writeFileSync(path.join(artifactDir, "exit"), "1"); return; }
			if (behavior !== "success") return;
			fs.writeFileSync(path.join(artifactDir, "progress.json"), JSON.stringify({ ...result, kind: "progress" }));
			setTimeout(() => fs.writeFileSync(path.join(artifactDir, "result.json"), JSON.stringify(result)), 8);
			setTimeout(() => fs.writeFileSync(path.join(artifactDir, "exit"), "0"), 20);
		},
		herdrPaneExists: async (pane: string) => {
			if (behavior === "query") throw new Error("socket unavailable");
			return panes.has(pane);
		},
		closeHerdrPane: (pane: string) => { closed.push(pane); panes.delete(pane); },
	};
	const runner = new HerdrRunner(api, "parent", timings);
	t.after(() => runner.closeAll());
	const options = (id: number) => ({ name: `child-${id}`, cwd: dir, command: "/node", args: ["/pi", "task"], env: {}, artifactDir: path.join(dir, String(id)) });
	return { runner, options, panes, closed, targets, commands, peak: () => peak };
}

test("child tools can only narrow parent permissions, including explicit empty tools", () => {
	assert.deepEqual(resolveChildTools(["read", "edit", "subagent"], ["read", "bash", "subagent"]), ["read"]);
	assert.deepEqual(resolveChildTools(["read", "subagent"], undefined), ["read"]);
	assert.deepEqual(resolveChildTools(["read", "edit"], []), []);
	const args: string[] = [];
	appendToolArgs(args, []);
	assert.deepEqual(args, ["--no-tools"]);
});

test("shell quoting preserves hostile strings", () => {
	assert.equal(shellQuote("a'b; $(touch nope)\nnext"), "'a'\\''b; $(touch nope)\nnext'");
});

test("quadrants split down, top right, then bottom right", () => {
	const owned = new Set<string>();
	assert.deepEqual(choosePaneSplit("parent", owned, [{ pane_id: "parent", rect }], rect), { target: "parent", direction: "down" });
	owned.add("bottom");
	const layout = [
		{ pane_id: "parent", rect: { ...rect, height: 40 } },
		{ pane_id: "bottom", rect: { ...rect, height: 40, y: 40 } },
	];
	assert.deepEqual(choosePaneSplit("parent", owned, layout, rect), { target: "parent", direction: "right" });
	layout[0].rect.width = 80;
	layout.push({ pane_id: "top-right", rect: { ...rect, x: 80, width: 80, height: 40 } });
	owned.add("top-right");
	assert.deepEqual(choosePaneSplit("parent", owned, layout, rect), { target: "bottom", direction: "right" });
});

test("parallel overflow is queued and progress/results captured with at most four panes", async (t) => {
	const f = fixture(t);
	let progress = 0;
	const results = await Promise.all(Array.from({ length: 8 }, (_, i) => f.runner.run({ ...f.options(i), onProgress: () => progress++ })));
	assert.equal(results.length, 8);
	assert.equal(f.peak(), 4);
	assert.equal(progress, 8);
	assert.ok(f.panes.size > 1, "completed children remain open for inspection");
	await sleep(30);
	assert.deepEqual([...f.panes.keys()], ["parent"]);
	assert.equal(f.closed.length, 8);
});

test("pre-existing unrelated panes reduce capacity and are never targeted/closed", async (t) => {
	const f = fixture(t, "success", 2);
	await Promise.all([0, 1, 2].map((i) => f.runner.run(f.options(i))));
	assert.equal(f.peak(), 4);
	assert.ok(f.targets.every((id) => id === "parent"));
	assert.ok(f.closed.every((id) => id.startsWith("child-")));
	await sleep(30);
	assert.equal(f.panes.size, 3);
});

test("full existing tab fails instead of creating a fifth pane", async (t) => {
	const f = fixture(t, "success", 3);
	await assert.rejects(f.runner.run(f.options(0)), /already has four/);
	assert.equal(f.targets.length, 0);
});

for (const [behavior, error] of [["missing", /closed before completion/], ["startup", /did not start/], ["exit", /exited without a result/], ["query", /socket unavailable/]] as const) {
	test(`${behavior} failure releases capacity and owned panes`, async (t) => {
		const f = fixture(t, behavior);
		await assert.rejects(f.runner.run(f.options(0)), error);
		assert.deepEqual([...f.panes.keys()], ["parent"]);
	});
}

test("cancellation terminates active and queued children without touching parent", async (t) => {
	const f = fixture(t, "hang");
	const controller = new AbortController();
	const work = Promise.allSettled([0, 1, 2, 3].map((i) => f.runner.run({ ...f.options(i), signal: controller.signal })));
	setTimeout(() => controller.abort(), 15);
	assert.ok((await work).every((item) => item.status === "rejected"));
	assert.deepEqual([...f.panes.keys()], ["parent"]);
});

test("shutdown stops active/queued work and is idempotent", async (t) => {
	const f = fixture(t, "hang");
	const work = Promise.allSettled([0, 1, 2, 3].map((i) => f.runner.run(f.options(i))));
	setTimeout(() => { f.runner.closeAll(); f.runner.closeAll(); }, 15);
	assert.ok((await work).every((item) => item.status === "rejected"));
	assert.deepEqual([...f.panes.keys()], ["parent"]);
});

test("child lifecycle captures messages and publishes final result only at settle", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-test-"));
	const previous = process.env.PI_SUBAGENT_RESULT_FILE;
	process.env.PI_SUBAGENT_RESULT_FILE = path.join(dir, "result.json");
	t.after(() => {
		if (previous === undefined) delete process.env.PI_SUBAGENT_RESULT_FILE;
		else process.env.PI_SUBAGENT_RESULT_FILE = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const handlers = new Map<string, Function>();
	childLifecycle({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any);
	handlers.get("session_start")!();
	assert.ok(fs.existsSync(path.join(dir, "ready")));
	handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", model: "test" } });
	assert.ok(!fs.existsSync(path.join(dir, "result.json")));
	let shutdown = false;
	handlers.get("agent_settled")!({}, { shutdown: () => { shutdown = true; } });
	const artifact = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
	assert.equal(artifact.exitCode, 0);
	assert.equal(artifact.messages[0].content[0].text, "done");
	assert.ok(!shutdown, "settled child remains open for inspection");
});
