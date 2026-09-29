# Build Plan

Phases 0-4 are **shipped and pushed**; they are listed so the shape of what
exists is visible, not as work. Phase 5 is the current one.

## Phase 0 — foundation (shipped)

Real-time OT editing with auth, one container, SQLite, hard deletes. Done to:
`npm test` green, PWA installable, single-box deploy documented in DEPLOY.md.

## Phase 1 — secrets and storage out of the row (shipped)

TOTP sealed at rest; `file_blob`/`chat_image` moved to a `BlobStore` with inline
and `fs` backends; database vs object bytes metered apart in the console.

## Phase 2 — tenancy (shipped)

`doc_org` routing index → per-org databases with a registry, request routing,
forward-only content migration, per-org migration runner and skew reporting,
replicated identity, stale-member pruning, session/membership cache, boot guard
refusing single mode beside tenant files.

## Phase 3 — plans, quotas, lifecycle (shipped)

Offline-verifiable signed licence claims; write-path quota ledger (no
check-then-act overshoot); per-org crypto-shredding with `org_keys`; whole-
instance and single-organization archives; maintenance that defers instead of
starving the pool; the client that keeps its session when the server is busy.

## Phase 4 — console honesty (shipped)

The console says what protects content (`sealing`), the delete dialog says what
a deletion destroys, Settings says where bytes live, licence expiry renders.

## Phase 5 — agents in the room (in progress)

A person can @mention a bot in a channel or DM and get a reply from it, as
themselves-visible named participant, with its own instructions, skills and
provider profile. Multiple distinct agents are rows, not code paths.
Definition of done: mention → queued turn → reply posted as the bot, scoped to
one org, seat-excluded, loop-guarded, tested at the seam, and visible in the UI
as a bot rather than a person. Spec: `feature-specs/01-chat-agents.md`.

## Phase 6 — object backend (blocked on an owner call)

S3/R2 `BlobStore` variant. Blocked on the dependency decision, not on design.

## Rules

- One boundary per unit: backend spec and UI spec are separate units.
- Logic-bearing code ships its failing test first.
- Every phase boundary gets a git push; every feature a review pass.
- Nothing in a later phase may couple the user-facing path to an external
  service synchronously — answer fast, queue the slow work.
