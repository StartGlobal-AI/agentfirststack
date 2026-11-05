# Notes for agents working in this repo

This repository is AgentFirstStack itself. To change its code, read CLAUDE.md first (architecture,
the agent-native rules, conventions, deployments).

The site in `site/` is also an AgentFirstStack customer: our own project runs analytics, tags,
an inbox and replay on agentfirststack.com.

<!-- agentfirststack:start -->
## AgentFirstStack

This project uses AgentFirstStack (analytics, tag manager, email inbox, session replay). What is
set up is in AGENTFIRSTSTACK.md; the key is AGENTFIRSTSTACK_API_KEY in .env.

When you work on analytics, tracking, conversions, the inbox or session replay, or when an
AgentFirstStack answer carries a `notice` (an `AFS-Notice` header, or a note in an MCP result),
run the setup check first: `GET https://agentfirststack.com/v1/setup` (MCP `afs_check_setup`). Apply what it
lists, following https://agentfirststack.com/llms.txt, and update AGENTFIRSTSTACK.md.
<!-- agentfirststack:end -->
