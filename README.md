# Pi Agent Configuration

Personal configuration, extensions, agents, and themes for the [Pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

## Directory Structure

```
.pi/
├── agent/
│   ├── settings.json          # Global settings (theme, thinking level, packages)
│   ├── extensions/            # Active extensions (auto-loaded)
│   │   ├── lib/               # Shared utilities
│   │   ├── diff-review/       # Native diff review window (Glimpse + Monaco)
│   │   └── plan-mode/         # Read-only exploration mode
│   ├── optional-extensions/   # Available but not auto-loaded
│   ├── agents/                # Agent personas
│   │   └── pi-pi/             # Pi Pi meta-agent team (experts)
│   └── themes/                # Custom color themes (12 themes)
```

## Settings

| Setting                | Value            |
|------------------------|------------------|
| Theme                  | `midnight-ocean` |
| Default thinking level | `medium`         |
| Packages               | `@aliou/pi-guardrails` |

## Extensions

All extensions in `extensions/` are loaded automatically on startup.

### Core Workflow

| Extension | Description |
|-----------|-------------|
| **plan-mode** | Read-only exploration mode (`/plan`, `Ctrl+Alt+P`). Restricts tools to read-only, extracts numbered plan steps, tracks progress with `[DONE:n]` markers. |
| **diff-review** | Native diff review window (`/diff-review [ref]`). Opens a Glimpse/Monaco side-by-side diff editor for inline comments, file comments, and overall notes. Supports headless mode for shell alias usage. |
| **handoff** | Context transfer (`/handoff <goal>`). Extracts relevant context from the current session and generates a focused prompt for a new session, avoiding lossy compaction. |
| **custom-compaction** | Replaces default compaction with a full-context summary using AWS Bedrock Haiku. `/compaction` shows the last compaction result. |
| **trigger-compact** | Auto-triggers compaction when context exceeds 150k tokens at agent end. |

### Safety & Guardrails

| Extension | Description |
|-----------|-------------|
| **confirm-destructive** | Prompts for confirmation before destructive session actions (clear, switch, branch). |
| **protected-paths** | Blocks writes to `.env`, `.git/`, `node_modules/`. Requires confirmation for any `rm` command. |
| **@aliou/pi-guardrails** | Package-based guardrails with path access controls. |

### UI & Display

| Extension | Description |
|-----------|-------------|
| **theme-cycler** | Cycle through themes with `F5`/`F6`. `/theme` opens a picker, `/theme <name>` switches directly. Shows color swatch on change. |
| **start-screen** | Themed welcome widget with ASCII logo, git branch, and 7-day cost sparkline. |
| **tool-counter** | Rich two-line footer: model + context meter, tokens in/out, cost, cwd with git branch, and tool call tally. |
| **cost** | `/cost [days]` — API cost summary with breakdown by date, model, and project. |
| **help** | `/help` — scrollable overlay listing all commands, shortcuts, and extension features. |
| **notify** | Native terminal notification when Pi finishes and is waiting for input (OSC 777/99, Windows toast). |

### Agent & Tool Management

| Extension | Description |
|-----------|-------------|
| **tools** | `/tools` — interactive tool selector to enable/disable tools. Persists across session reloads. |
| **system-select** | `/system` — switch system prompts by picking from agent definitions across `.pi/`, `.claude/`, `.gemini/`, `.codex/`. |
| **cross-agent** | Loads commands, skills, and agents from other AI coding agent directories (`.claude/`, `.gemini/`, `.codex/`). |

### Shared Libraries

| File | Description |
|------|-------------|
| **lib/costUtils.ts** | Cost aggregation utilities (used by `cost.ts` and `start-screen.ts`). |
| **lib/themeMap.ts** | Per-extension default theme assignments. Each extension can declare a preferred theme. |

### Optional Extensions

Not auto-loaded. Use `pi -e optional-extensions/<name>.ts` to enable.

| Extension | Description |
|-----------|-------------|
| **pi-pi** | Pi Pi meta-agent — team of domain-specific research experts that operate in parallel to build Pi components. |
| **status-line** | Demo extension showing `ctx.ui.setStatus()` with turn progress and themed colors. |

## Agents

Agent personas in `agents/`. Invoke with `/system` or reference in team configurations.

### Development Agents

| Agent | Tools | Description |
|-------|-------|-------------|
| **builder** | read, write, edit, bash, grep, find, ls | Implementation and code generation. |
| **planner** | read, grep, find, ls | Architecture and implementation planning. Read-only. |
| **plan-reviewer** | read, grep, find, ls | Critically evaluates plans — challenges assumptions, flags risks. |
| **scout** | read, grep, find, ls | Fast recon and codebase exploration. Read-only. |
| **reviewer** | read, bash, grep, find, ls | Code review and quality checks. Read-only. |
| **refactor** | _(full)_ | Refactoring specialist — improves code quality without changing behavior. |

### Specialist Agents

| Agent | Tools | Description |
|-------|-------|-------------|
| **debugger** | _(full)_ | Systematic debugging — reproduces issues, forms hypotheses, isolates root causes. |
| **error-investigator** | _(full)_ | Analyzes errors, exceptions, and stack traces to identify root causes. |
| **test-writer** | _(full)_ | Writes comprehensive, maintainable tests following the testing pyramid. |
| **red-team** | read, bash, grep, find, ls | Security and adversarial testing. Finds vulnerabilities, reports with severity. |
| **architect** | _(full)_ | Software architecture — SOLID, design patterns, scalable system design. |

### Documentation Agents

| Agent | Tools | Description |
|-------|-------|-------------|
| **documenter** | read, write, edit, grep, find, ls | Documentation and README generation. |
| **docs-writer** | _(full)_ | Technical documentation specialist — audience-first, examples over explanations. |
| **code-reviewer** | _(full)_ | In-depth code review focused on security, performance, and best practices. |
| **explainer** | _(full)_ | Breaks down complex code and concepts into clear explanations. |
| **commit-summary** | _(full)_ | Analyzes git history to summarize changes and provide actionable next steps. |

### Pi Pi Expert Team

Located in `agents/pi-pi/`. A meta-agent team for building Pi extensions, themes, and configurations.

| Expert | Domain |
|--------|--------|
| **pi-orchestrator** | Primary agent — coordinates experts, writes files |
| **ext-expert** | Extensions — tools, events, commands, rendering |
| **theme-expert** | Themes — JSON format, color tokens |
| **tui-expert** | TUI — components, overlays, widgets, footers |
| **config-expert** | Settings — providers, models, packages |
| **skill-expert** | Skills — SKILL.md packages, scripts |
| **prompt-expert** | Prompt templates — .md format, arguments |
| **agent-expert** | Agent definitions — personas, teams |
| **keybinding-expert** | Keyboard shortcuts — key IDs, reserved keys |
| **cli-expert** | CLI — flags, environment variables, output modes |

## Themes

12 custom themes in `themes/`. Cycle with `F5`/`F6` or pick with `/theme`.

| Theme | Style |
|-------|-------|
| catppuccin | Warm pastel |
| catppuccin-mocha | Dark warm pastel |
| cyberpunk | Neon on dark |
| dracula | Classic dark |
| everforest | Calm green |
| gruvbox | Earthy retro |
| midnight-ocean | Deep blue |
| nord | Arctic cool |
| ocean-breeze | Light aqua |
| rose-pine | Muted rose |
| synthwave | Retro neon purple |
| tokyo-night | Dark city lights |

## Keyboard Shortcuts

Extension-registered shortcuts (in addition to Pi built-ins):

| Shortcut | Action | Extension |
|----------|--------|-----------|
| `F5` | Cycle theme forward | theme-cycler |
| `F6` | Cycle theme backward | theme-cycler |
| `Ctrl+Alt+P` | Toggle plan mode | plan-mode |

## Slash Commands

| Command | Description | Extension |
|---------|-------------|-----------|
| `/cost [days]` | API cost summary (default: 7 days) | cost |
| `/compaction` | View last compaction result | custom-compaction |
| `/diff-review [ref]` | Open native diff review window | diff-review |
| `/handoff <goal>` | Transfer context to a new session | handoff |
| `/help` | Show all commands and shortcuts | help |
| `/plan` | Toggle plan mode | plan-mode |
| `/system` | Switch system prompt / agent persona | system-select |
| `/theme [name]` | Select or switch theme | theme-cycler |
| `/todos` | Show plan progress | plan-mode |
| `/tools` | Enable/disable tools interactively | tools |
