# Project Instructions

## Project Context
- This is a git-backed project. Prefer project-local instructions here over global defaults.
- Read relevant code before editing. Keep diffs minimal and focused.
- Do not edit generated files, vendored code, lockfiles, or migrations unless explicitly requested.

## Build, Test, Lint
- Fill in project commands before use:
  - Install: `<command>`
  - Test: `<command>`
  - Lint/typecheck: `<command>`
- After code changes, run the smallest relevant verification first, then broader checks when practical.

## Search
- Use `ffgrep`/`fffind` first for code search and path discovery.
- For Go code, read package/file outlines first; read symbol bodies with `symbol=`.

## GitNexus
Use GitNexus only in this git repo when the repo has been indexed.

- Prefer `gitnexus_query` for unfamiliar features or cross-file execution flows.
- Use `gitnexus_impact` before modifying a function, method, or type.
- If impact is HIGH or CRITICAL, report the risk before proceeding.
- Use `gitnexus_detect_changes` before committing or finalizing large changes.
- If GitNexus reports no index / no repository / unavailable, stop using GitNexus for this task and continue with normal code search. Do not repeatedly retry failed GitNexus calls.

## Commit/PR Hygiene
- Summarize changed files and verification performed.
- Call out risks, skipped checks, or assumptions explicitly.
