---
description: 先侦察再规划（scout → planner）：只产出计划，不动代码
---
Use the subagent tool as a CHAIN so the planning happens in isolated context
windows instead of filling this conversation:

1. Run the "scout" agent to find all code relevant to: $@
2. Then run the "planner" agent with the scout's output as context (pass it via the
   {previous} placeholder) to produce the implementation plan for "$@".

Do NOT implement anything — return the plan only.

Reasoning for the two steps: the scout's job is breadth (where is the code), the
planner's is depth (what should change, in what order, what could break). Keeping
them separate keeps the main conversation's context for the actual work.

If the subagent tool is unavailable, say so instead of silently doing the work inline.
