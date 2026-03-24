import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ChangeStatus, DiffReviewFile } from "./types.js";

interface ChangedPath {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
}

async function runGit(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

async function runGitAllowFailure(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) {
    return "";
  }
  return result.stdout;
}

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.code !== 0) {
    throw new Error("Not inside a git repository.");
  }
  return result.stdout.trim();
}

async function hasRef(pi: ExtensionAPI, repoRoot: string, ref: string): Promise<boolean> {
  const result = await pi.exec("git", ["rev-parse", "--verify", ref], { cwd: repoRoot });
  return result.code === 0;
}

function parseNameStatus(output: string): ChangedPath[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const changes: ChangedPath[] = [];

  for (const line of lines) {
    const parts = line.split("\t");
    const rawStatus = parts[0] ?? "";
    const code = rawStatus[0];

    if (code === "R") {
      const oldPath = parts[1] ?? null;
      const newPath = parts[2] ?? null;
      if (oldPath != null && newPath != null) {
        changes.push({ status: "renamed", oldPath, newPath });
      }
      continue;
    }

    if (code === "M") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "modified", oldPath: path, newPath: path });
      }
      continue;
    }

    if (code === "A") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "added", oldPath: null, newPath: path });
      }
      continue;
    }

    if (code === "D") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "deleted", oldPath: path, newPath: null });
      }
    }
  }

  return changes;
}

async function getRefContent(pi: ExtensionAPI, repoRoot: string, ref: string, path: string): Promise<string> {
  const result = await pi.exec("git", ["show", `${ref}:${path}`], { cwd: repoRoot });
  if (result.code !== 0) {
    return "";
  }
  return result.stdout;
}

async function getWorkingTreeContent(repoRoot: string, path: string): Promise<string> {
  try {
    return await readFile(join(repoRoot, path), "utf8");
  } catch {
    return "";
  }
}

function parseUntrackedPaths(output: string): ChangedPath[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((path) => !path.includes("node_modules/"))
    .map((path) => ({
      status: "added" as const,
      oldPath: null,
      newPath: path,
    }));
}

function mergeChangedPaths(tracked: ChangedPath[], untracked: ChangedPath[]): ChangedPath[] {
  const seen = new Set(tracked.map((change) => `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`));
  const merged = [...tracked];

  for (const change of untracked) {
    const key = `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`;
    if (seen.has(key)) continue;
    merged.push(change);
    seen.add(key);
  }

  return merged;
}

function toDisplayPath(change: ChangedPath): string {
  if (change.status === "renamed") {
    return `${change.oldPath ?? ""} -> ${change.newPath ?? ""}`;
  }
  return change.newPath ?? change.oldPath ?? "(unknown)";
}

/**
 * Gather diff review files comparing the working tree against a given ref.
 * Defaults to HEAD. Also includes untracked files as "added".
 */
export async function getDiffReviewFiles(
  pi: ExtensionAPI,
  cwd: string,
  ref: string = "HEAD",
): Promise<{ repoRoot: string; files: DiffReviewFile[]; ref: string }> {
  const repoRoot = await getRepoRoot(pi, cwd);
  const refExists = await hasRef(pi, repoRoot, ref);

  const trackedOutput = refExists
    ? await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", ref, "--"])
    : "";
  const untrackedOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--others", "--exclude-standard"]);

  const trackedPaths = parseNameStatus(trackedOutput);
  const untrackedPaths = parseUntrackedPaths(untrackedOutput);
  const changedPaths = mergeChangedPaths(trackedPaths, untrackedPaths);

  const files = await Promise.all(
    changedPaths.map(async (change, index): Promise<DiffReviewFile> => {
      const oldContent = change.oldPath == null ? "" : await getRefContent(pi, repoRoot, ref, change.oldPath);
      const newContent = change.newPath == null ? "" : await getWorkingTreeContent(repoRoot, change.newPath);
      return {
        id: `${index}:${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`,
        status: change.status,
        oldPath: change.oldPath,
        newPath: change.newPath,
        displayPath: toDisplayPath(change),
        oldContent,
        newContent,
      };
    }),
  );

  return { repoRoot, files, ref };
}
