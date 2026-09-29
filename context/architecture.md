# Architecture

## Tech stack — tool and its role

| Tool | Role | Version |
|---|---|---|
| Rust `rustpad-server` | HTTP + WebSocket server, auth, OT persistence, tenancy, storage | workspace member, 0.1.3 |
| Rust `rustpad-wasm` | OT engine compiled to WASM, bundled by the frontend | workspace member |
| `warp` 0.3 | HTTP/WS routing (~105 `path!` route patterns) | pinned |
| `sqlx` 0.6.3 + SQLite (WAL) | one control database + one per org; `max_connections(1)` | pinned |
| React 18 + strict TS + Vite | frontend SPA | |
| Chakra UI v2 + Emotion | component and token layer | |
| Monaco | code/text editor | |
| `@excalidraw/excalidraw` | whiteboard | |
| `vite-plugin-pwa` 1.3 (`generateSW`) | offline install; the update banner registers the SW | |
| Caddy (in-image) | auto-TLS reverse proxy to `127.0.0.1:3030` | |

## Folder structure

```
rustpad-server/src/   database.rs (the bulk: queries, tenancy, export/import),
                      databases.rs (per-org registry), auth.rs, crypto.rs,
                      keystore.rs (column + org-key sealing), blobstore.rs,
                      licence.rs, workspace/ (routes: mod.rs, ai.rs, archive)
rustpad-server/migrations/   38 forward-only SQL files, embedded by sqlx::migrate!
rustpad-server/tests/        integration suites; common/mod.rs holds the WS client
src/                    React app. api.ts is the whole client surface;
                        OwnerApp.tsx is the root console; WorkspaceApp.tsx the
                        org app; AiView.tsx the assistant; crypto.ts mirrors the
                        Rust session crypto
DEPLOY.md               operations & recovery runbook
context/                this system
```

## System boundaries & data flow

Browser → (cookie session, app-layer ECDH/AES-GCM envelopes) → warp routes →
`auth::with_auth` → `Database` handle (an `Arc` over the one control pool) →
SQLite control DB, or `Databases::org(id)` for routed tenant content. Object
bytes go to `BlobStore` (inline column, or `fs` directory) named
`o<org>-<sha256(sealed)>`. Live documents sit in `LiveDocs`/`LiveBoards` maps
keyed by doc id.

Ordering rule that carries the guarantees: **content is written before the
control row that names it**, and the control commit is the commit point.

## Invariants — rules the system must never violate

1. Never issue a pool read while holding the single connection's transaction.
   Prefetch (see `export_deks`) or read through `&mut tx`.
2. Migrations are forward-only. Never edit an applied one; `sqlx::migrate!`
   embeds the text as checked out, so line-ending churn changes stored DDL.
3. A read never mints a key. Reads use `org_dek_stored`; writes use `org_dek`.
4. Identity is replicated into tenant databases as display data only
   (`password_hash = '!'`), never as a usable credential, and never FK'd across.
5. Export decrypts. An archive carrying sealed bytes would restore as garbage.
6. A swallowed `sqlx` error must never become an auth or authorization answer.
   Busy pool is a 503, not "wrong password" or "forbidden".
7. Every list is paginated; every public endpoint rate-limited. No per-user
   state kept in-process behind the load balancer (single container today, still
   the rule).
8. Commits: author `Ansh Roshan <75963202+anshace@users.noreply.github.com>`,
   no co-authors, no AI attribution, no secrets/`*.db`/`.env`/`archive/`.

## Operational gotchas (measured, so they don't get re-derived)

- **A root-owned database looks like a server error.** If the app cannot write,
  logins fail with `{"error":"server error"}`. After any DB edit from a root
  container, `chown -R 1000:1000` the volume.
- **Restore order: seed the DB, then start the app.** Starting first lets the boot
  repairs (TOTP sealing, inline sizes, routing backfill) run against the wrong file.
- **Keep the clock synced** (`timedatectl set-ntp true`) or TOTP breaks at ±30s.
- **`Database` is a cheap handle, so a registry slot on it must be shared.** Its
  fields are `Arc`s over one pool, but a plain `OnceCell<Databases>` field would be
  *per handle*: `Databases::new` clones the control `Database` before the registry
  exists, so the clone stored inside `Databases` and the clones handed to handlers
  would disagree about whether routing is on — and which document lives where would
  depend on which clone a call site happens to hold. Use `Arc<OnceCell<Databases>>`
  (set once, after both exist) and pass the same slot to every `open_org`.
- **`ATTACH` caps at ten** (`SQLITE_MAX_ATTACHED` is compile-time), so attaching
  tenants into the control connection is not a storage design. Nothing in the tree
  uses `ATTACH`.
- **Views and foreign keys do not cross databases**: `workspace.owner_id`,
  `group_member.user_id`, `message.sender_id`, `session.user_id` all declare
  `REFERENCES users(id)`, which is why identity is replicated (D-02).
- **Never put a test that rewrites committed files into the suite.**

## External dependencies

None required to run. Optional at boot: `CORTEX_DATA_KEY` (else a `<db>.key`
sidecar is created), `CORTEX_LICENCE_PUB` (absent → no plan enforcement at all),
`DOMAIN` (Caddy TLS), and provider API keys for the AI assistant, which are
supplied per user/org in Settings → AI — never from the repo.
