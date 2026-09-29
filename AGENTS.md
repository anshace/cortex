# AGENTS.md

Master instruction file for every agent, in every tool. `CLAUDE.md` is a thin
wrapper that imports this one. Project state lives in `context/` and `memory.md`,
not in a chat that vanishes.

## Reading order (tiered — never load the whole folder blindly)

ALWAYS before any work:
1. `context/overview.md`
2. `context/workflow-rules.md`
3. `context/progress-tracker.md`
4. `memory.md`

READ WHEN THE TASK TOUCHES IT:
- `context/feature-specs/NN-*.md` — the unit being built
- `context/code-standards.md` — before writing any code
- `context/architecture.md` + `context/library-docs.md` — before that subsystem or library
- `context/ui-tokens.md`, `ui-rules.md`, `ui-registry.md` — only for UI units
- `context/decisions.md` — before making or repeating any decision (D-01…D-12)
- `context/build-plan.md` — when sequencing or adding features
- `DEPLOY.md` — anything touching operations, backups, env vars, or the container

Update `context/progress-tracker.md` when starting and when finishing every unit.

## Project facts

- **Cortex**: self-hosted collaborative workspace (docs + OT, files, whiteboards,
  chat), one container: app + Caddy + SQLite. Product is Cortex; the DB file is
  `authpad.db` and the crates are `rustpad-*`.
- Package manager: npm. Run dev: `npm run dev` (Vite proxies `/api` to
  `127.0.0.1:3030`). Test: `npm test`. Typecheck: `npm run check`. Build:
  `npm run build`. Icons: `npm run icons`.
- The gate is `npm test` = `cargo test --workspace`. `cargo test --lib` compiles
  **none** of `rustpad-server/tests/` — never quote it as evidence about documents
  or archives. Re-run gates **after** committing, on the committed tree.
- Database access: `sqlx` on SQLite, queries on `Database` in
  `rustpad-server/src/database.rs`; migrations in `rustpad-server/migrations/`
  are **forward-only** — never edit an applied one, add the next number.
- **The pool has one connection.** Never issue a pool read while holding a
  transaction on it; prefetch, or read through `&mut tx`. Most historical bugs
  here are that one mistake.
- API handlers live in `rustpad-server/src/workspace/` (`mod.rs` routes,
  `ai.rs` assistant). Every browser call goes through `src/api.ts`.
- Design: cool neutrals + one azure accent, 6-10px radii, colour everywhere and
  theme-aware via tokens only; no top bar, no right dock, slim left rail. Details
  in `context/ui-rules.md`.

## Invariant rules (true every session, never changed mid-build)

- Every visual value comes from `context/ui-tokens.md`; no raw ramp hex in a
  component.
- Before touching a third-party library, load its skill/docs
  (`context/library-docs.md`) and act from that, not from memory.
- One feature unit or subsystem at a time; never combine unrelated boundaries in
  one step. Backend and UI are separate units.
- Logic-bearing code ships its failing test first. Every new assertion is
  mutation-checked or revert-proved; concurrency tests run ~10×.
- A swallowed DB error must never answer as a denial: `Err` → 503, `Ok(None)` →
  401/403.
- Never run `prettier --write` or `cargo fmt` (CRLF tree; reformatting rewrites
  the DDL text `sqlx::migrate!` embeds).
- Adding or updating a dependency is the owner's decision — ask first.
- Any decision that is hard, ambiguous, or changes an invariant: stop, write the
  options with their cost, and ask the human. Record it in
  `context/decisions.md`, never in chat.

## Commit hygiene — keep the history clean

- Author every commit as `Ansh Roshan <75963202+anshace@users.noreply.github.com>`.
  Never use a personal or real email.
- **No co-authors, no AI attribution.** No `Co-Authored-By` trailers, no
  "Generated with …" footers, no AI emoji or tool names in commit messages or
  bodies. Commit messages describe the change and nothing else.
- **Keep everything clean.** This is a public repo — never commit real domains,
  public IPs, emails, passwords, or API keys. Never commit `.env`,
  `seed_users.json`, `*.db`, or `graphify-out/` (all gitignored). Use reserved doc
  examples (`your-domain.example`, `203.0.113.9.sslip.io`).
- Do not commit scratch files or local-only notes; keep those in `archive/`
  (gitignored).

## Skills

- `project-context-system` — this system: bootstrap, session protocol, recording
  rules, sync pass. Use when setting up, syncing, or handing off.
- `agent-browser` — driving the real app; the evidence for any UI claim.
- `ui-ux-pro-max-skill`, `frontend-design`, `impeccable` — only for UI units.
- `plan`, `research`, `cross-review`, `zen-review` — planning and review lanes;
  research that the main thread does not need goes to a subagent.

## Verification

`npm test`, `npm run check`, `npm run build`, `cargo clippy --workspace
--all-targets` (baseline: one pre-existing `too_many_arguments` warning —
anything else is yours). UI is verified in the running app with a screenshot,
never from the CSS. Report the results, name what is wrong including my own
earlier claims, and explain anything the human should review.
