# Progress Tracker

Concrete, verified state. A unit moves to Complete only with what proves it.

## In progress

- **Context system adoption** (2026-09-29) — `project-context-system` installed
  globally and scaffolded into this repo: `context/` (12 files), `memory.md`,
  `CLAUDE.local.md`, `.claude/settings.json`, `.gitignore` additions. Existing
  human-authored `AGENTS.md` / `CLAUDE.md` preserved; one stale claim in
  `CLAUDE.md` corrected (see Issue 01).
- **Feature 01 — agents in chat** (`feature-specs/01-chat-agents.md`) — spec
  written, implementation not started. Decisions D-11/D-12 recorded as
  owner-vetoable.

## Completed

- **Provider pin and remote caps** (`ai-assistant`, unmerged) — the assistant's
  client now goes through `mcp::pin_client_allowing`, so the address
  `validate_provider_base` judged is the address the socket uses;
  `AI_ALLOW_PRIVATE_BASE` became an argument to the shared rule instead of a
  second rule set, and `never_a_host` moved to `mcp.rs` with its private copy
  deleted. Every remaining remote read is bounded: the three provider error bodies,
  both SSE streams (`add_within_cap` folds each chunk into a running total, because
  a remote chooses how it splits a body), and the GitHub skill catalog and
  SKILL.md fetches. Proof: 3 new tests; un-pinning `ai_client` breaks its test,
  disabling the link-local branch admits `169.254.169.254` with the flag on, and
  widening the cap lets 8 MB in 8 KB chunks through. What is *not* covered by a
  test: the one-line wiring of the cap into the stream loops — proving that needs a
  live provider stub, and `AI_ALLOW_PRIVATE_BASE` is process-global, so a test that
  set it would race every other test in the binary. `npm test` 153 passed / 0 failed.
- **MCP and fetch rebinding + response caps** (`ai-assistant`, unmerged) — the two
  audit findings that lived outside `ai.rs`. `mcp::pin_client` is now the single
  place a URL is resolved, refused if any answer is private, and pinned with
  `resolve_to_addrs`; `mcp::pinned_client` and `search.rs::fetch_client` both build
  through it, and `web_fetch` re-pins on every redirect hop. `mcp::read_capped`
  bounds a response as it arrives (4 MB) instead of trusting `content-length`, and
  the fetch path uses it rather than its old length-then-buffer rule. Also fixed:
  `parse_ddg_html` sliced at a raw byte offset, which panicked the request worker on
  any non-ASCII redirect target. Proof: 5 new tests, each mutation-checked —
  removing the pin's address loop breaks 2, raising the cap breaks the chunked
  test, lowering it breaks the whole-body test, and restoring the byte-offset bound
  panics the parser test (the first fixture for that one landed wrong: a 20-byte
  prefix put the 500th byte exactly on a char boundary, so it passed against the
  buggy code). `npm test` 149 passed / 0 failed / 1 deliberate ignore; clippy clean.
- **v0.1.3 tenancy and shredding** (`206d55d`, tagged, pushed) — per-org
  databases with routing (#19/#20/#24/#25), `org_keys` crypto-shredding with
  sealed objects and read-path unsealing (#21), whole-instance and
  single-organization archives with decrypt-on-export and the restore guard
  (#26), maintenance that defers instead of starving the pool (#31), the client
  that keeps its session on a 503 (#33), quota overshoot closed (#27), stale
  tenant members pruned (#29), OT engine property tests (#30), all 16 formerly
  ignored socket tests restored (#28). Proof: `npm test` 130 passed / 0 failed,
  one deliberate `#[ignore]` (the measured second-connection VACUUM hazard);
  clippy at its single pre-existing warning; `tsc` and `vite build` clean;
  migration 38 verified booting the real binary.
- **Console honesty pass** (`f79cd09`, pushed) — `sealing` in the storage
  readout, delete dialog that names what a shred destroys, Settings stating where
  content lives, licence expiry rendered from `exp`. Proof: driven in the running
  app against a live server on `BLOB_BACKEND=fs` (sealing row, dialog wording and
  CTA, both org row actions, Settings line).

## Up next

1. Issue 06 remainder: pin `ai.rs::ai_client` (needs `AI_ALLOW_PRIVATE_BASE`
   threaded into `mcp::pin_client` as an argument, not a second rule set) and cap
   the provider/skill response reads.
2. The remaining release-blocking audit findings from `31bdf60` land one commit
   each — see `context/current-issues.md`.
3. Feature 01 backend: `users.kind`, `bots` profile table, mention → queued turn →
   reply-as-bot, loop guard, seat exclusion. Its failing test first.
4. Feature 01 UI: bot marker in People and messages, mention autocomplete, the
   owner's agent management panel.
5. Issue 02: the object-backend dependency call (owner).
6. F-01: decide the chat-encryption wording.

## Session notes

- 2026-10-01: closed the rebinding and unbounded-read findings for the MCP and
  fetch paths; `ai.rs` still has both (Issue 06). Nothing merged to `main` — this
  branch is `ai-assistant`.
- 2026-09-29: skill installed (it was never in `~/.qoder/skills/`, which is why it
  looked broken), repo audited and scaffolded, Feature 01 specced. Two decisions
  recorded with an explicit "owner may veto" — D-11 bot-as-user-kind, D-12 bots
  free of seats.
