# Router Extension Demo Script

## Test Prompts (copy-paste these)

### Fast (DeepSeek) — simple questions, lookups
```
what is a closure
```
```
how do I reverse a string in python
```
```
what does the spread operator do
```

### Strong (GLM-5) — standard refactors, debugging
```
refactor this function to use async/await instead of callbacks
```
```
debug why this test is flaking on CI, it passes locally but fails intermittently
```
```
implement a rate limiter middleware for our express server
```

### Smart (Haiku) — design choices, tradeoffs, reasoning
```
design a caching layer for our API that invalidates correctly when the underlying data changes, considering both read-heavy and write-heavy workloads
```
```
compare the tradeoffs between using a message queue vs direct HTTP calls for our notification service, considering failure modes and scaling
```

### Sonnet (Sonnet 5) — architecture, security, multi-system
```
architect a plugin system for this CLI tool that supports hot-reloading, versioned APIs, and sandboxed execution without compromising the host process security
```
```
we implemented this router extension, is there anyway we could make this an api or some sort of external binary such that other coding harnesses could utilize it
```

### Opus (explicit only)
```
opus — review this entire codebase for security vulnerabilities
```

---

## Commands to Demo

```
/router status      — show current tier and session stats
/router score       — show score breakdown for last prompt
/router on/off      — enable/disable routing
/cheap              — pin to fast tier (DeepSeek)
/strong             — pin to strong tier (GLM-5)
/escalate           — move up one tier
/auto               — re-enable automatic routing
/routes             — full help reference
```

---

## Screencast Script

### Opening (5s)
> "This is a model router for Pi — it automatically picks the cheapest AI model that can handle your prompt."

### Show the tiers (10s)
- Run `/routes` to show the full tier list and pricing
- Highlight: "5 tiers from $0.30 to $75 per million tokens"

### Demo: Simple question → DeepSeek (15s)
- Type: `what is a closure`
- Let it respond (fast, cheap)
- Run `/router score` → show LLM scored it low, routed to DeepSeek
- "Simple question, simple model. Fractions of a cent."

### Demo: Architecture question → Sonnet (15s)
- Type: `architect a plugin system for this CLI tool that supports hot-reloading, versioned APIs, and sandboxed execution without compromising the host process security`
- Show it routes to Sonnet 5 automatically
- Run `/router score` → show high score
- "Complex architecture prompt — router escalated to Sonnet 5 automatically."

### Demo: Conversational design → Smart routing (15s)
- Type: `we implemented this router extension, is there anyway we could make this an api or some sort of external binary such that other coding harnesses could utilize it`
- Show it routes appropriately (smart/sonnet)
- "No special keywords needed — the LLM classifier understands intent, not just vocabulary."

### Demo: Manual override (10s)
- Run `/cheap` → show it pins to DeepSeek
- Type anything → stays on DeepSeek
- Run `/auto` → back to automatic
- "You can always override manually."

### Demo: Explicit Opus (5s)
- Type: `opus`
- Show it jumps straight to Opus 4.8
- "Say 'opus' and it goes straight to the top. No scoring needed."

### Closing (5s)
> "Cheap-first routing. LLM-classified. Every prompt gets the right model at the right price."

---

## Key Talking Points

- **Cost savings**: Most dev prompts are simple — why pay $15/M when $0.30 works?
- **LLM classification**: A cheap DeepSeek call (~350ms, ~$0.00001) classifies each prompt
- **No keyword hacking**: Understands "make this an API" = architecture, not just "architect X"
- **Fallback safety**: If classifier fails, heuristic regex scoring kicks in
- **Manual control**: `/cheap`, `/escalate`, `/auto` for full override
- **Escalate on failure**: 2 consecutive tool errors → auto-upgrade to next tier
