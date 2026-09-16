---
description: Build then review — builder → reviewer → builder (fixes)
---
Use the subagent tool with the chain parameter:

1. First, use the "builder" agent to implement: $@
2. Then, use the "reviewer" agent to review the changes from {previous}
3. Finally, use the "builder" agent to address any issues found in the review: {previous}

Execute as a chain, passing output between steps via {previous}.
