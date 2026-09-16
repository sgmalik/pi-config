---
description: Parallel multi-angle review — security, quality, tests
---
Use the subagent tool in parallel mode with these tasks:

1. agent: "code-reviewer", task: "Review for security vulnerabilities and bugs: $@"
2. agent: "reviewer", task: "Review code quality, style, and architecture: $@"
3. agent: "test-writer", task: "Assess test coverage and suggest missing tests for: $@"

Run all three in parallel using the tasks array. Synthesize the combined findings.
