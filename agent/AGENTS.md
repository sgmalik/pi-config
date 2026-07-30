# How I Work

## Act vs. Discuss

Do NOT make code changes unless I explicitly ask for them. Default to discussion.

If I ask a question, explain something, or say "let's think about this" — respond with words, not code edits. Even after a discussion concludes, wait for me to say "do it", "make the change", "go ahead", or something equally explicit before touching files.

## When I Ask Questions

Teach, don't tell. Assume I want deep understanding, not surface answers.

- Start simple. Use analogies to ground abstract concepts in something physical or familiar.
- Build up from the ground floor. Don't skip steps — if there's a prerequisite concept, cover it first.
- Dumb things down without being condescending. Clarity over jargon.
- If I ask "why", go deeper. Don't hand-wave.

## When I Ask About Code

Explain code from the ground up, not the middle out.

1. Link to or cite the relevant documentation/spec first.
2. Show a minimal, standalone example that demonstrates the core concept in isolation.
3. Explain that example — what each part does and why.
4. Build toward a more robust version, layering in real-world concerns.
5. Only then, explain the actual code in context — connecting it back to the simple examples.

Never dump a wall of code and say "here's how it works." Walk me through it.

## When Generating Code

Always TDD. Requirements first, tests second, implementation third.

1. **Define requirements** — every behavior gets a clear, testable definition before any code is written.
2. **Write the test** — the test should fail (red).
3. **Implement** — write the minimum code to make the test pass (green).
4. **Refactor** — clean up per the refactoring process below.

All code I produce must meet these standards:

- **Type checked** — explicit types, no `any`, no implicit inference where it harms clarity.
- **Linted** — clean, no warnings, follow project lint config.
- **Verified** — run the appropriate checks for the language before considering work done:
  - **Go**: `golangci-lint run` (vet + lint), then `wet` for duplication scanning.
  - **Python**: `ruff check` (lint) + `pyright` (type check).
  - `wet` (alias: `/Users/sm-syc/Sycamore/s-caf/scripts/wet/wet`) scans the current branch for code clones, duplicate structs, and repeated string literals. Exit code 1 = new findings — fix them.
- **Readability first** — if it's clever but hard to read, simplify it. Code is read 10x more than it's written.
- **Top-level imports only** — no inline imports, no lazy imports, no conditional imports. Ever.
- **Simplify and refactor** — follow a structured refactoring process (see below).
- **No over-commenting** — code should be self-documenting through clear naming. Comments explain *why*, never *what*. No commented-out code. No obvious comments like `# increment counter`.
- **No stubs or TODOs** — finish what you start. If something is out of scope, say so explicitly rather than leaving a placeholder.

## Search

**In-repo → fff tools first.** Frecency-ranked, git-aware, instant.

* **`ffgrep`** — file contents. Smart-case, regex or literal.
* **`fffind`** — paths/filenames. Fuzzy, multi-word narrows; `path:` param for globs.

Bad:  `find . -name "*.sas"`         Good: `fffind({path: "**/*.sas"})`
Bad:  `rg "CN012" .`                 Good: `ffgrep({pattern: "CN012"})`

After 1–2 results, **read the top match** — don't keep searching.

### Bash fallbacks

Only when fff doesn't apply:

| Situation | Tool |
|-----------|------|
| Outside repo (`~`, `/etc/`, mounts) | `fd -g "name" ~` (or `fd -uuu` unrestricted) |
| Pipe into xargs / count across huge trees | `rg` at `/opt/homebrew/bin/rg` |

## Before Implementation

Before writing ANY code, walk through this sequence:

1. **Restate the problem** — what's broken or missing, in plain terms.
2. **Explain the root cause** — why it's happening. Ground-up, with analogies if needed.
3. **Propose the solution** — what approach we'll take and why. Discuss tradeoffs.
4. **Confirm** — wait for explicit approval before writing a single line.

Do not collapse steps 1-3 into a brief paragraph and then start coding. Each step should be its own clear section. The goal is that I fully understand the problem and the fix *before* any implementation begins.

## When Refactoring

Treat every refactor like a PR review. Walk through it systematically:

1. **Show the before** — present the current code as-is.
2. **Point out the gaps** — what's wrong, what's brittle, what violates the standards above. Be specific: name the smell (duplication, unclear naming, missing types, tight coupling, etc.).
3. **Discuss the approach** — what technologies, patterns, algorithms, or abstractions we're choosing to fill each gap and *why*. If there are tradeoffs, name them.
4. **Show the after** — the refactored code, explained from the ground up. Every new function, type, or structural choice should be justified in terms of the gaps identified in step 2.
5. **Summarize the delta** — a before/after diff-style recap so the change is crystal clear.

The user should walk away understanding not just *what* changed, but *why* each decision was made — ground up, no leaps.
