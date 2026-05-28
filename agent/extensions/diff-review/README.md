# pi-diff-review

A native diff review window for [pi](https://github.com/badlogic/pi), powered by [Glimpse](https://github.com/hazat/glimpse) and Monaco Editor.

Based on [badlogic/pi-diff-review](https://github.com/badlogic/pi-diff-review) — rewritten with bug fixes, keyboard shortcuts, arbitrary ref support, and migrated from an installable git package to a local extension.

## What it does

Adds a `/diff-review` command to pi. When invoked it:

1. Collects the current git diff (working tree vs a ref, default `HEAD`)
2. Opens a native review window with a full Monaco side-by-side diff editor
3. Lets you annotate changes with three layers of feedback (see below)
4. On submit, composes a structured prompt and inserts it into the pi editor

The result is a code-review workflow where you visually inspect diffs, leave targeted comments, and hand the feedback directly to the agent.

## Usage

```
/diff-review              # Review working tree vs HEAD
/diff-review main         # Review working tree vs the main branch
/diff-review abc1234      # Review working tree vs a specific commit
```

## Shell alias (standalone usage)

The extension also works outside of pi as a standalone shell command. When run in print mode (`pi -p`), the review window opens identically but the composed prompt is written to **stdout** instead of being inserted into the pi editor.

Add this to your `.zshrc` / `.bashrc`:

```bash
diff-review() { pi -p --no-session "/diff-review ${1:-HEAD}"; }
```

Then use it directly from the terminal:

```bash
diff-review              # review working tree vs HEAD
diff-review main         # review vs main branch
diff-review abc1234      # review vs a specific commit

diff-review | pbcopy     # copy feedback to clipboard
diff-review > review.txt # save to a file
diff-review | pi -p      # pipe feedback straight into a new pi session
```

Status messages (file count, cancellation notices, errors) go to **stderr** so they don't pollute the prompt output when piping.

## The three comment layers

The review window supports three distinct types of feedback, each serving a different purpose. All three are combined into a single prompt when you submit.

### 1. Inline comments

These are line-level comments attached to a specific line in either the **original** (left) or **modified** (right) side of the diff.

**How to add one:** hover over the gutter (line numbers or glyph margin) on either side of the diff editor. A green **+** icon appears. Click it to open a comment textarea directly below that line.

**What they look like in the editor:**
- The commented line gets a highlight (amber for original side, blue for modified side)
- A colored dot appears in the glyph margin
- A textarea widget is inserted inline as a Monaco view zone

**How they appear in the prompt:**
```
1. src/index.ts:42 (new)
   This function should handle the error case — add a try/catch here.

2. src/index.ts:18 (old)
   This import is no longer needed after the refactor.
```

The `(old)` / `(new)` suffix tells the agent which side of the diff the comment refers to. The line number pinpoints the exact location.

### 2. File comments

These are comments about an entire file rather than a specific line. Use them for high-level observations like "this file should be split into two modules" or "the naming convention here doesn't match the rest of the project."

**How to add one:** click the **"Add file comment"** button in the toolbar above the diff editor.

**What they look like in the editor:** they appear as bordered cards in a section above the diff editor (between the toolbar and the Monaco editor), not inline with the code.

**How they appear in the prompt:**
```
3. src/utils.ts
   This entire file duplicates logic from src/helpers.ts — consolidate them.
```

No line number, just the file path — the agent understands this applies to the file as a whole.

### 3. Overall note

A single free-text note that applies to the entire review across all files. Use it for cross-cutting concerns like "make sure all new functions have JSDoc comments" or "the PR description says this fixes issue #42 but I don't see the relevant test."

**How to add one:** click the **"Overall note"** button in the header bar.

**How it appears in the prompt:** it is prepended above all numbered comments:
```
Address the following code review feedback:

The error handling patterns are inconsistent across these changes.
Use the Result type from src/types.ts everywhere instead of throwing.

1. src/index.ts:42 (new)
   This function should handle the error case...
```

### How they combine

When you click **"Finish review"**, all three layers are composed into a single prompt:

```
Address the following code review feedback:

<overall note, if any>

1. <file comment or inline comment with location>
   <comment body>

2. <next comment>
   <comment body>

...
```

Comments are numbered sequentially in the order they were added. The prompt is inserted into the pi editor, ready to send to the agent.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘/Ctrl + Enter` | Submit review (works globally and from within textareas) |
| `Escape` | Cancel review (when not focused in a textarea) |
| `⌘/Ctrl + [` | Previous file |
| `⌘/Ctrl + ]` | Next file |
| `⌘/Ctrl + Enter` (in modals) | Save and close modal |
| `Escape` (in modals) | Close modal without saving |

## Other features

- **Mark reviewed** — toggle a green dot on files you've finished reviewing (visual tracking only, not included in the prompt)
- **Wrap lines** — toggle word wrap in the diff editor
- **Changed areas only (default)** — unchanged regions are collapsed by default so you immediately see every diff. Click "Show full file" to expand everything for full context.
- **File tree** — collapsible directory tree in the sidebar with comment counts per file and change-type badges (M/A/D/R)
- **Scroll position memory** — switching between files preserves your scroll position

## Architecture

```
diff-review/
├── index.ts        Extension entry point — registers /diff-review, manages
│                   the Glimpse window lifecycle, shows TUI waiting overlay
├── git.ts          Git operations — resolves repo root, collects changed
│                   files via `git diff --name-status`, reads file contents
│                   from the ref and working tree
├── prompt.ts       Prompt composition — takes the structured comment data
│                   and formats it into a numbered text prompt
├── types.ts        Shared TypeScript types for comments, files, payloads
├── ui.ts           HTML builder — reads the web/ template, inlines the
│                   review data as JSON, inlines app.js, returns a single
│                   self-contained HTML string
├── web/
│   ├── index.html  The native window HTML shell — layout grid, toolbar,
│   │               sidebar, editor container, Tailwind + Monaco CDN refs
│   └── app.js      All browser-side logic — Monaco diff editor setup,
│                   file tree rendering, comment management (view zones,
│                   decorations, modals), keyboard shortcuts, submit/cancel
└── package.json    Declares the glimpseui dependency
```

### Data flow

```
/diff-review [ref]
       │
       ▼
   git.ts ─── pi.exec("git", ...) ──→ collects file list + contents
       │
       ▼
   ui.ts ──── reads web/index.html + web/app.js
       │       inlines review data as JSON
       │
       ▼
   glimpseui.open(html) ──→ native webview window
       │
       │  (user reviews diffs, adds comments)
       │
       ▼
   window.glimpse.send(payload) ──→ message event on GlimpseWindow
       │
       ▼
   prompt.ts ── composeReviewPrompt() ──→ formatted text
       │
       ├── ctx.hasUI? ──→ ctx.ui.setEditorText(prompt)  (interactive)
       └── !ctx.hasUI? ─→ process.stdout.write(prompt)  (headless / shell alias)
```

### Blocking UI pattern (interactive mode only)

While the native window is open, the extension shows a TUI overlay in the pi terminal via `ctx.ui.custom()`. This overlay:

- Tells the user a review window is open
- Accepts `Escape` to cancel and close the window
- Races the TUI promise against the Glimpse window's message/close events
- Whichever settles first determines the outcome (submit, cancel, or error)

This prevents the user from interacting with pi while a review is in progress.

## Requirements

- macOS, Linux, or Windows
- Node.js 20+
- `pi` installed
- Internet access (Monaco and Tailwind are loaded from CDN)
- On macOS: Xcode command line tools (for building the Glimpse Swift binary)
- On Windows: .NET 8 SDK + Edge WebView2 Runtime

## Changes from the original

This is a rewrite of [badlogic/pi-diff-review](https://github.com/badlogic/pi-diff-review) (v0.2.0). Changes:

- Fixed redundant `.padEnd()` after `truncateToWidth(..., true)` which already pads
- Moved `waitingUI` above `try` block so the catch path can dismiss the TUI overlay before showing errors
- Guarded empty feedback — skips editor insertion when no comments or overall note exist
- Updated prompt phrasing to prime the model for code review context
- Fixed `session_shutdown` handler signature (`(_event, _ctx)` instead of `()`)
- Migrated from deprecated Monaco `deltaDecorations` to `createDecorationsCollection`
- Added keyboard shortcuts (`⌘Enter` submit, `Escape` cancel, `⌘[/]` file navigation)
- Added arbitrary ref support (`/diff-review main`, `/diff-review abc1234`)
- Cached template file reads (no repeated `readFileSync` on every invocation)
- Expanded language detection (C, C++, Swift, Ruby, PHP, SQL, XML, Dockerfile, TOML, etc.)
- `⌘/Ctrl+Enter` works from within comment textareas and modals
- Migrated from installable git package to local directory extension
- Changed default to show only changed areas (unchanged regions collapsed) so diffs are immediately visible without scrolling
- Added headless mode (`ctx.hasUI` detection) — writes prompt to stdout when run via `pi -p`, enabling standalone shell alias usage
