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

1. Feature 01 backend: `users.kind`, `bots` profile table, mention → queued turn →
   reply-as-bot, loop guard, seat exclusion. Its failing test first.
2. Feature 01 UI: bot marker in People and messages, mention autocomplete, the
   owner's agent management panel.
3. Issue 02: the object-backend dependency call (owner).
4. F-01: decide the chat-encryption wording.

## Session notes

- 2026-09-29: skill installed (it was never in `~/.qoder/skills/`, which is why it
  looked broken), repo audited and scaffolded, Feature 01 specced. Two decisions
  recorded with an explicit "owner may veto" — D-11 bot-as-user-kind, D-12 bots
  free of seats.
