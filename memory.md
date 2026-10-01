# Memory

The handoff file. A fresh session reads this plus `context/overview.md`,
`context/workflow-rules.md` and `context/progress-tracker.md` and picks up with no
re-explaining. Tool auto-memory is scratch; this file is the record.

## Current state (2026-10-01)

Work is on branch `ai-assistant`, pushed to `origin/ai-assistant`, **not** merged
to `main`. `main` = `f79cd09`, tagged `v0.1.3`.

All eight findings from the `31bdf60` audit are closed, one commit each: provider
`base_url` validated (`ddce381`) → MCP/fetch rebinding and remote caps
(`4d9e622`) → turn-owner key on the in-flight registry (`b41b75f`) → provider
client pinned (`237edee`) → every remote body capped (`becce78`) → membership
re-proved at the write seams (`aa55ccc`) → plan mode covers `remember`
(`0a28b56`) → quota reservation and memory attribution (`7939aa5`).

The controls that did most of the work are shared rather than copied:
`mcp::pin_client_allowing` (resolve, refuse, then connect to exactly those answers,
with `AI_ALLOW_PRIVATE_BASE` as an argument instead of a second rule set),
`mcp::read_capped`/`add_within_cap` (bound a body by its running total, because a
remote chooses how it splits), and `workspace::ws_access` (`ensure_ws`'s rules
extracted so a detached task can ask them without answering an HTTP request).

Tenancy is finished on `main`: per-org databases with routing, per-org
crypto-shredding, whole-instance and single-organization archives, write-path
quotas, maintenance that defers rather than starving the pool.

Feature 01 (agents in chat) is specced, not started. The substrate mostly exists:
`workspace/ai.rs` already has provider profiles (anthropic/openai/azure, keys
sealed per user/org), file tools, SSE turns, skills, MCP, research, and a
`spawn_agent` tool that runs parallel sub-agents. `ChatView.tsx` already resolves
and highlights @mentions. Chat is app-layer encrypted against the **server's**
key, so a server-side bot can read its mention — that is what makes this buildable
without touching the wire format.

## Next step

1. Merge-or-not for `ai-assistant` → `main` is the owner's call: the branch is
   eight commits and the whole assistant ahead of `main`.
2. Feature 01 backend, RED-GREEN, per `context/feature-specs/01-chat-agents.md`.
3. Three smaller decisions are listed below and in `context/current-issues.md`;
   none block Feature 01.

## What the tests do NOT prove

In the commit messages too, because a future session could assume it away: licence
enforcement is off in tests, so the quota *wiring* at each write site is reviewed
rather than tested (the reservation and its arithmetic are tested), and
`memory_section` is tested while its two prompt call sites are not.

## Open questions (need the human)

1. **F-01 / Issue 04** — once bots read chat, does the "sealed on your device"
   copy get reworded, or does chat become genuinely device-key E2E (and bots hold
   a key pair like a client)?
2. **D-11/D-12 are recorded as owner-vetoable**: bot-as-`users.kind`, and bots not
   consuming seats. Say so if either is wrong.
3. **Issue 02** — the S3/R2 client dependency: name it or decline it.
4. Should a bot be able to *edit documents* in Feature 01, or only answer in chat?
   The file tools exist; the difference is whether an unattended turn may write.
5. **The shape of workspace memory.** `.cortex/MEMORY.md` is written by any
   member's turn and read back into everyone's. Its notes are now attributed and
   framed as context-not-instruction (`7939aa5`), which dulls the cross-user
   channel without closing it. Closing it means either owner-only writes (loses
   the shared-note feature) or one file per member with a read that merges (keeps
   it, changes where memory lives). Your call, not mine.
6. `ensure_ws`'s HTTP routes still turn a database error into `403` — the same
   class as #31. `ws_access` distinguishes the two now; changing every route's
   status code is its own unit, not a side effect of this one.

## What not to re-litigate

`context/decisions.md` D-01…D-12. Read it before proposing a key hierarchy, a
storage split, a housekeeping connection, or an archive restore rule.
