# CLAUDE.md

Guidance for AI agents working in this repository.

## Project

**Cortex** — a private, authenticated, multi-file collaborative workspace. Note
that the deployment image is a different thing from "Authpad"; the DB file is
`authpad.db`. Persist this knowledge, not the cloud.

- Backend: Rust (`rustpad-server`, `rustpad-wasm`) — real-time collab via
  operational transformation (based on ekzhang/rustpad).
- Frontend: React + TypeScript + Vite + Chakra UI. Monaco editor.
- Data: SQLite. On first run (empty DB) a default owner is created:
  username `admin`, password `admin`.
- Roles: `root`/owner (cross-org account, workspace, backup and maintenance
  control), `admin` (manages users, groups, workspaces and moderation within
  their own org), `user` (edits, uploads/downloads and transfers files in
  accessible workspaces). Deletes are hard deletes, not Trash.

## Commands

```sh
npm install              # install frontend deps
npm run dev              # Vite dev server
npm run check            # typecheck (tsc) — run before committing frontend changes
npm run build            # production frontend build
npm run format           # prettier --write .
cargo build --release    # build server (rustpad-server)
cargo test --workspace   # Rust tests
```

Rust requires a C linker — on Windows install the "Desktop development with C++"
workload. WASM needs `wasm-pack` + `wasm32-unknown-unknown` target.

## Architecture

- `rustpad-server/` — Rust HTTP + WebSocket server; OT logic, auth, and
  workspace. Migrations live in `rustpad-server/migrations/`.
- `rustpad-wasm/` — OT engine compiled to WASM (bundled by the frontend).
- `src/` — React frontend. `api.ts` is the API client; `auth.rs`/`crypto.rs`
  handle sessions and encryption. Workspace views mirror backend concepts
  (`WorkspaceApp`, `OwnerApp`, etc.).
- WebSocket: `src/rustpad.ts` + `rustpad-server/src/rustpad.rs`.

## Conventions

- TS: strict; React Function components; Chakra UI primitives; no tests for UI.
- Rust: idiomatic, clippy-clean; keep migrations forward-only.
- Keep docstrings/`# Comments` purposeful — do not add noise comments.
- After editing, run `npm run check` (and `cargo` tests if touching Rust).

## Deployment (single container)

- The image is **one container**: app + Caddy (auto-HTTPS) + SQLite on a
  `cortex-data` Docker volume. App binds IPv4 `0.0.0.0:3030`; Caddy proxies
  `127.0.0.1:3030` (never `localhost` — IPv6).
- Image: `ghcr.io/anshace/cortex:latest`, **linux/amd64** only (t3.* boxes, not
  ARM/Graviton). App runs as **uid 1000**.
- `DOMAIN` env → Caddy serves that host with a Let's Encrypt cert; unset → plain
  HTTP on 3030. `COOKIE_SECURE=1` auto-set when `DOMAIN` is set.
- Full run/recovery/backup runbook: **DEPLOY.md**.
- **Never commit `.env`, `seed_users.json`, `*.db`, or `graphify-out/`** (all
  gitignored).

## Repo hygiene (this is a PUBLIC repo — do not leak)

- The repo is open source. Never commit real domains, public IPs, emails,
  passwords, or API keys. Use reserved doc examples (`203.0.113.9.sslip.io`,
  `your-domain.example`) in place of real hosts.
- Author identity for commits is `Ansh Roshan`
  (`75963202+anshace@users.noreply.github.com`). No `Co-Authored-By` trailers and no AI attribution (`Generated with …`, 🤖, etc.) in commit messages or bodies.
- `archive/` and `graphify-out/` are gitignored; keep personal/dev scratch there.

## Docs

- `DEPLOY.md` — operations & recovery runbook (single-container, backups, 2FA,
  DB troubleshooting). Keep env/volume/port details synced with the Dockerfile,
  `docker-entrypoint.sh`, and compose files.
- `README.md` — user-facing overview + quick start; keep `admin/admin` plus the
  `203.0.113.9.sslip.io` example in sync.

## Notes / gotchas

- **Root-owned DB** = app can't write → logins fail with `{"error":"server error"}`.
  After any DB edit from a root container, chown back to `1000:1000`.
- RESTORE ORDER: seed the DB first, THEN start the app.
- Keep the box clock synced (`timedatectl set-ntp true`) or TOTP breaks (±30s).
- **`Database` is a cheap handle, so a registry slot on it must be shared.**
  Its fields are `Arc`s over one pool, but a plain `OnceCell<Databases>` field
  would be *per handle*: `Databases::new` clones the control `Database` before
  the registry exists, so the clone stored inside `Databases` and the clones
  handed to handlers would disagree about whether routing is on, and which
  document lives where would depend on which clone a given call site happens to
  hold. Use `Arc<OnceCell<Databases>>` (set once, after both exist) and pass the
  same shared slot to every `open_org`, or don't route inside `Database` at all.
- Don't put tests that rewrite files in the committed tree.

### Per-organization storage (measured, so it doesn't get re-derived)

- **`ATTACH` caps at ten.** Attaching each tenant database into the control
  connection would need no handler changes — SQLite answers the eleventh with
  `too many attached databases - max 10`, and `SQLITE_MAX_ATTACHED` is a
  compile-time constant. Don't build the ten-tenant ceiling into the storage
  layer. Nothing in the tree uses `ATTACH`.
- **Views and foreign keys don't cross databases.** `CREATE VIEW users AS SELECT
  … FROM ctl.users` is rejected outright, and `workspace.owner_id`,
  `group_member.user_id`, `message.sender_id` and `session.user_id` all declare
  `REFERENCES users(id)`. That is why identity is *replicated* into a tenant
  database as display data only (`member-<id>@org.local`, `password_hash = '!'`)
  rather than referenced: authentication stays a control-plane operation and a
  leaked tenant file authenticates nobody.
- **`doc_org` shares a transaction with the content it indexes.** `route_doc_tx`
  runs on the same `tx` as the `file`/`file_blob` inserts (database.rs:2070/2076,
  :2137/2143). Once `file` is tenant-resident and `doc_org` is not, no SQLite
  transaction spans them — so splitting storage is a design decision about which
  guarantee survives, not a mechanical sweep. Resolve that before writing the
  control/tenant method split.
- **`cargo test --lib` proves nothing about the live document path.** It compiles
  none of `rustpad-server/tests/`, and every test in there is `#[ignore]`d
  (`warp::test` cannot complete a WS upgrade on a route that awaits auth). Gate
  document/OT work with `cargo test --manifest-path rustpad-server/Cargo.toml`
  across all targets, and read the ignored counts.