---
description: Full implementation workflow — scout → planner → builder
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "planner" agent to create an implementation plan for "$@" using the scout's findings via {previous}
3. Finally, use the "builder" agent to implement the plan from {previous}

Execute this as a chain, passing output between steps via {previous}.
