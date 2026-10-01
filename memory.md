# Memory

The handoff file. A fresh session reads this plus `context/overview.md`,
`context/workflow-rules.md` and `context/progress-tracker.md` and picks up with no
re-explaining. Tool auto-memory is scratch; this file is the record.

## Current state (2026-10-01)

Work is on branch `ai-assistant`, not `main`. `main` = `f79cd09`, tagged `v0.1.3`.
The branch carries the assistant checkpoint (`31bdf60`) plus one fix per audit
finding: the provider URL guard (`ddce381`, D-13), the in-flight turn owner key
(`b41b75f`), and the outbound-HTTP hardening in `mcp.rs`/`search.rs` — both the MCP
and web-fetch paths now build their client through `mcp::pin_client`, which
resolves once, refuses any private answer, and pins the connection to those
answers; `mcp::read_capped` bounds a body as it streams instead of trusting
`content-length`; and `parse_ddg_html` no longer slices at a raw byte offset.
Gates at HEAD: `npm test` 149 passed / 0 failed / one deliberate `#[ignore]`,
clippy clean, `tsc` and `vite build` unchanged (no UI touched).

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

Finish Issue 06 in `context/current-issues.md` — the same two findings still open
in `ai.rs`, one commit each:
1. Pin `ai_client` (`ai.rs:269`). `validate_provider_base` only runs where a
   profile is *saved* (`ai.rs:209`), so the request itself still resolves a second
   time — the exact rebinding this branch closed everywhere else. Thread
   `AI_ALLOW_PRIVATE_BASE` into `mcp::pin_client` as an argument; do not copy the
   address rules.
2. Cap the provider and skill response reads (`ai.rs:2403`, `2928`, `github_client`
   at 5213).
3. Then the rest of the release-blocking list, then Feature 01.

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
