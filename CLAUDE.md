# CLAUDE.md

@AGENTS.md

This file is a thin wrapper on purpose. `AGENTS.md` is the master instruction
file for every agent and every tool; the project's state lives in `context/` and
`memory.md`. Nothing is maintained here — if a rule belongs to this project, it
goes in `AGENTS.md` (true everywhere) or the relevant `context/` file (true when
the task touches it), and `DEPLOY.md` stays the operations runbook.
