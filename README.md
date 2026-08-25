# Pi Agent Configuration

Personal configuration, extensions, agents, and themes for the [Pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

## Directory Structure

```
.pi/
├── agent/
│   ├── AGENTS.md                    # Personal coding standards & guidelines
│   ├── settings.json                # Global settings (theme, thinking level, packages)
│   ├── extensions/                  # Active extensions (auto-loaded)
│   │   ├── lib/                     # Shared utilities
│   │   ├── gitnexus.ts              # GitNexus tool integration
│   │   ├── router.ts                # Tool routing and subagent delegation
│   │   ├── refactor-router.ts       # Refactor command routing
│   │   ├── cost.ts                  # Cost tracking
│   │   ├── custom-compaction.ts     # Custom context compaction
│   │   ├── tool-counter.ts          # Token & cost footer
│   │   ├── tools.ts                 # Tool selector
│   │   ├── trigger-compact.ts       # Auto-compaction at token threshold
│   │   └── notify.ts                # Terminal notifications
│   ├── optional-extensions/         # Available but not auto-loaded
│   │   ├── theme-cycler.ts
│   │   ├── confirm-destructive.ts
│   │   ├── protected-paths.ts
│   │   ├── start-screen.ts
│   │   ├── handoff.ts
│   │   ├── cross-agent.ts
│   │   ├── help.ts
│   │   ├── system-select.ts
│   │   ├── pi-pi.ts                 # Meta-agent team mode
│   │   ├── ollama-thinking.ts       # Extended thinking support
│   │   ├── status-line.ts           # Custom status line demo
│   │   └── themeMap.ts              # Theme preferences
│   ├── agents/                      # Agent personas
│   │   ├── architect.md             # System design & architecture
│   │   ├── builder.md               # Implementation & code generation
│   │   ├── coder.md                 # General-purpose coding
│   │   ├── code-reviewer.md         # Security & best practices review
│   │   ├── code-simplifier.md       # Code clarity & maintainability
│   │   ├── commit-summary.md        # Git history analysis
│   │   ├── debugger.md              # Systematic debugging
│   │   ├── documenter.md            # Documentation generation
│   │   ├── docs-writer.md           # Technical documentation specialist
│   │   ├── error-investigator.md    # Error & exception analysis
│   │   ├── explainer.md             # Complex code explanation
│   │   ├── hard.md                  # Advanced problems (Claude Sonnet)
│   │   ├── opus.md                  # Maximum capability (Claude Opus)
│   │   ├── oss-fast.md              # Fast & cheap (DeepSeek v3)
│   │   ├── oss-strong.md            # Capable OSS model (GLM-5)
│   │   ├── plan-reviewer.md         # Plan validation & criticism
│   │   ├── planner.md               # Architecture planning
│   │   ├── red-team.md              # Security & adversarial testing
│   │   ├── refactor.md              # Code refactoring
│   │   ├── reviewer.md              # Code review & quality
│   │   ├── scout.md                 # Fast recon & exploration
│   │   └── test-writer.md           # Test writing specialist
│   ├── prompts/                     # Prompt templates (.md files)
│   ├── fff/                         # Fast file finder utilities
│   ├── optional-skills/             # Available skills (opt-in)
│   │   └── codebase-to-course/      # Convert codebase to course content
│   └── themes/                      # Custom color themes (12 themes)
```

## Settings

| Setting                | Value            |
|------------------------|------------------|
| Theme                  | `midnight-ocean` |
| Default thinking level | `medium`         |

## Active Extensions

Extensions in `extensions/` are auto-loaded on startup.

### Core Workflow

| Extension | Description |
|-----------|-------------|
| **router** | Tool and subagent routing. Delegates to specialized agents based on task context. |
| **gitnexus** | GitNexus integration for code knowledge graph queries and impact analysis. |
| **refactor-router** | Routes refactor operations to appropriate agents and handles code transformations. |

### Cost & Optimization

| Extension | Description |
|-----------|-------------|
| **cost** | `/cost [days]` — API cost summary with breakdown by date, model, and project. |
| **custom-compaction** | Replaces default compaction with full-context summary using AWS Bedrock Haiku. `/compaction` shows last result. |
| **trigger-compact** | Auto-triggers compaction when context exceeds 150k tokens at agent end. |
| **tool-counter** | Rich two-line footer: model + context meter, tokens in/out, cost, cwd with git branch, and tool call tally. |
| **tools** | `/tools` — interactive tool selector to enable/disable tools. Persists across session reloads. |

### System

| Extension | Description |
|-----------|-------------|
| **notify** | Native terminal notification when Pi finishes and is waiting for input (OSC 777/99, Windows toast). |

## Optional Extensions

Not auto-loaded by default. Use `pi -e optional-extensions/<name>.ts` to enable.

### Safety & Guardrails

| Extension | Description |
|-----------|-------------|
| **confirm-destructive** | Prompts for confirmation before destructive session actions (clear, switch, branch). |
| **protected-paths** | Blocks writes to `.env`, `.git/`, `node_modules/`. Requires confirmation for any `rm` command. |

### UI & Display

| Extension | Description |
|-----------|-------------|
| **theme-cycler** | Cycle through themes with `F5`/`F6`. `/theme` opens a picker, `/theme <name>` switches directly. |
| **start-screen** | Themed welcome widget with ASCII logo, git branch, and 7-day cost sparkline. |
| **help** | `/help` — scrollable overlay listing all commands, shortcuts, and extension features. |

### Agent & Tool Management

| Extension | Description |
|-----------|-------------|
| **system-select** | `/system` — switch system prompts by picking from agent definitions across `.pi/`, `.claude/`, `.gemini/`, `.codex/`. |
| **cross-agent** | Loads commands, skills, and agents from other AI coding agent directories (`.claude/`, `.gemini/`, `.codex/`). |

### Context Transfer

| Extension | Description |
|-----------|-------------|
| **handoff** | Context transfer (`/handoff <goal>`). Extracts relevant context and generates a focused prompt for a new session. |

### Advanced Features

| Extension | Description |
|-----------|-------------|
| **pi-pi** | Pi Pi meta-agent — team of domain-specific research experts that operate in parallel. |
| **ollama-thinking** | Extended thinking support (Claude 4 thinking model integration). |
| **status-line** | Demo extension showing `ctx.ui.setStatus()` with themed status updates. |

### Shared Libraries

| File | Description |
|------|-------------|
| **lib/costUtils.ts** | Cost aggregation utilities (used by `cost.ts` and `start-screen.ts`). |
| **themeMap.ts** | Per-extension default theme assignments. |

## Agents

Agent personas in `agents/`. Invoke with `/system` or reference in team configurations.

### General Purpose

| Agent | Tools | Description |
|-------|-------|-------------|
| **coder** | _(full)_ | General-purpose coding — implements, rewrites, and modifies code. |
| **builder** | write, edit, bash, grep, find, ls | Implementation and code generation. Read + write focused. |
| **refactor** | _(full)_ | Code refactoring specialist — improves quality without changing behavior. |

### Planning & Analysis

| Agent | Tools | Description |
|-------|-------|-------------|
| **planner** | read, grep, find, ls | Architecture and implementation planning. Read-only. |
| **plan-reviewer** | read, grep, find, ls | Critically evaluates plans — challenges assumptions, flags risks. |
| **scout** | read, grep, find, ls | Fast recon and codebase exploration. Read-only. |

### Review & Quality

| Agent | Tools | Description |
|-------|-------|-------------|
| **reviewer** | read, bash, grep, find, ls | Code review and quality checks. Read-only. |
| **code-reviewer** | _(full)_ | In-depth review focused on security, performance, and best practices. |
| **code-simplifier** | _(full)_ | Simplifies and refines code for clarity and maintainability. |

### Debugging & Investigation

| Agent | Tools | Description |
|-------|-------|-------------|
| **debugger** | _(full)_ | Systematic debugging — reproduces issues, forms hypotheses, isolates root causes. |
| **error-investigator** | _(full)_ | Analyzes errors, exceptions, and stack traces to identify root causes. |

### Testing & Security

| Agent | Tools | Description |
|-------|-------|-------------|
| **test-writer** | _(full)_ | Writes comprehensive, maintainable tests following the testing pyramid. |
| **red-team** | read, bash, grep, find, ls | Security and adversarial testing. Finds vulnerabilities. |

### Documentation

| Agent | Tools | Description |
|-------|-------|-------------|
| **documenter** | read, write, edit, grep, find, ls | Documentation and README generation. |
| **docs-writer** | _(full)_ | Technical documentation specialist — audience-first, examples-focused. |
| **explainer** | _(full)_ | Breaks down complex code and concepts into clear explanations. |
| **commit-summary** | _(full)_ | Analyzes git history to summarize changes and provide next steps. |

### Architecture

| Agent | Tools | Description |
|-------|-------|-------------|
| **architect** | _(full)_ | System design, SOLID principles, design patterns, scalable systems. |

### Model Variants

| Agent | Provider | Model | Use Case |
|-------|----------|-------|----------|
| **hard** | Anthropic | Claude Sonnet 5 | Protocol work, security, gnarly debugging |
| **opus** | Anthropic | Claude Opus 5 | Maximum capability for hardest problems |
| **oss-fast** | DeepSeek | v3-2 | Cheap & fast boilerplate, tests, simple edits |
| **oss-strong** | GLM | GLM-5 | Capable OSS model for complex implementations |

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
| midnight-ocean | Deep blue (default) |
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

## Slash Commands

| Command | Description | Extension |
|---------|-------------|-----------|
| `/cost [days]` | API cost summary (default: 7 days) | cost |
| `/compaction` | View last compaction result | custom-compaction |
| `/handoff <goal>` | Transfer context to a new session | handoff |
| `/help` | Show all commands and shortcuts | help |
| `/system` | Switch system prompt / agent persona | system-select |
| `/theme [name]` | Select or switch theme | theme-cycler |
| `/tools` | Enable/disable tools interactively | tools |

## Key Additions & Changes

### v2.0 (Current)
- **GitNexus Integration**: Built-in code knowledge graph queries (`gitnexus_query`, `gitnexus_impact`, `gitnexus_context`, `gitnexus_detect_changes`)
- **Model Variants**: Added `hard`, `opus`, `oss-fast`, `oss-strong` for specialized use cases
- **Router Extensions**: Intelligent tool and agent delegation via `router.ts`
- **New Agents**: `code-simplifier`, `coder` join the roster
- **Optional Skills**: Skills moved to opt-in model in `optional-skills/`
- **Prompt Templates**: New `prompts/` directory for custom prompt templates
- **Cleaner Architecture**: Better separation of active vs optional extensions

### v1.0
- Initial setup with core extensions, themes, and agent personas

## Personal Guidelines

See `agent/AGENTS.md` for personal coding standards, search techniques, GitNexus workflow, and code quality requirements.
