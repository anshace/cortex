# Memory

The handoff file. A fresh session reads this plus `context/overview.md`,
`context/workflow-rules.md` and `context/progress-tracker.md` and picks up with no
re-explaining. Tool auto-memory is scratch; this file is the record.

## Current state (2026-09-29)

`main` = `f79cd09`, pushed, tagged `v0.1.3`. Working tree carries the new
`context/` scaffold (uncommitted). Gates: `npm test` 130/0, `tsc` clean,
`vite build` clean, clippy at one pre-existing warning.

Tenancy is finished: per-org databases with routing, per-org crypto-shredding,
whole-instance and single-organization archives, write-path quotas, maintenance
that defers rather than starving the pool. The owner console now states what
protects content and what a deletion destroys.

Feature 01 (agents in chat) is specced, not started. The substrate mostly exists:
`workspace/ai.rs` already has provider profiles (anthropic/openai/azure, keys
sealed per user/org), file tools, SSE turns, skills, MCP, research, and a
`spawn_agent` tool that runs parallel sub-agents. `ChatView.tsx` already resolves
and highlights @mentions. Chat is app-layer encrypted against the **server's**
key, so a server-side bot can read its mention — that is what makes this buildable
without touching the wire format.

## Next step

Implement Feature 01 backend-first, RED-GREEN:
1. Migration 39: `users.kind` (`'human'` default) + `bots` profile table.
2. Failing test: mentioning a bot in a channel produces a reply authored by that
   bot, in the same org, and the mention does not re-trigger it.
3. Then the routing seam, seat exclusion, and the UI (bot marker, autocomplete,
   owner's agent panel).

## Open questions (need the human)

1. **F-01 / Issue 04** — once bots read chat, does the "sealed on your device"
   copy get reworded, or does chat become genuinely device-key E2E (and bots hold
   a key pair like a client)?
2. **D-11/D-12 are recorded as owner-vetoable**: bot-as-`users.kind`, and bots not
   consuming seats. Say so if either is wrong.
3. **Issue 02** — the S3/R2 client dependency: name it or decline it.
4. Should a bot be able to *edit documents* in Feature 01, or only answer in chat?
   The file tools exist; the difference is whether an unattended turn may write.

## What not to re-litigate

`context/decisions.md` D-01…D-12. Read it before proposing a key hierarchy, a
storage split, a housekeeping connection, or an archive restore rule.
