# Project Overview

## What this is

Cortex is a private, self-hosted, multi-file collaborative workspace: documents,
binary files, whiteboards, chat channels and DMs, with real-time editing through
operational transformation. It ships as **one container** (app + Caddy + SQLite on
one volume) so a person can run their own instance on one small box.

Deployment note that trips people up: the product is Cortex, the database file is
still `authpad.db`, and the crates are still `rustpad-*`. Same thing, three names.

## Who it's for

A single operator running it for themselves and a handful of organizations —
a team, a family, a client. Not a public SaaS: every feature is judged against
"can this run on a t3.micro with one volume and no Redis?"

## Core flows

1. **Sign in** → `POST /api/login` (bcrypt, throttled per IP), HttpOnly cookie
   session, optional TOTP sealed at rest. Root lands in the owner console;
   everyone else in their org's workspace app.
2. **Open a workspace, edit a document** → WebSocket with an ephemeral ECDH
   handshake (`epk` first frame) and AES-256-GCM payload envelopes; OT merges
   through `rustpad-wasm`; content persists to SQLite.
3. **Organize** → org → group → workspace → file. Chat and DMs are org-scoped.
4. **Meter and limit** → per-org plans verified offline from a signed licence;
   quota enforced on the write path, not in a cron.
5. **Back up and restore** → whole-instance ZIP export, or one organization's ZIP;
   import replaces everything transactionally.

## Complex patterns / what could go wrong

- **One pooled connection.** `sqlx` pool is `max_connections(1)`. Any read issued
  from inside a transaction on that pool waits for itself forever. This is the
  single most-recurring cause of bugs here (see `context/decisions.md`).
- **Tenancy spans databases.** Identity is *replicated* into each tenant database,
  never foreign-keyed across them; only `document` moves. Views and FKs cannot
  cross SQLite databases, and `ATTACH` caps at ten.
- **Content is encrypted per organization** when `BLOB_BACKEND=fs`. Deleting an
  org destroys its key, so its bytes become unreadable — recoverability, not
  existence. A backup from before the deletion still opens.
- **Hard deletes.** No Trash. A delete that leaves a routing row or an orphan
  object behind reads as data loss later.
- **Public repo.** Any real domain, IP, email, key or `.db` committed is a leak.

## In scope for version one

Shipped: multi-tenancy with per-org databases, crypto-shredding, per-org and
whole-instance archives, offline-verifiable plans with write-path quotas, 2FA,
audit log with switch + clear, PWA/offline client, single-container deploy.

In flight: **agents as chat participants** — named bots a person can @mention
alongside humans (`context/feature-specs/01-chat-agents.md`).

## Deliberately out of scope

No Postgres, no Redis, no queue, no second service. No SQLCipher. No S3/R2 object
backend yet — it needs an HTTP/S3 client dependency the owner has not approved
(`context/current-issues.md` Issue 02). No soft delete, no e2e-encrypted chat
(the app layer seals payloads against the *server's* key, which is a transport
claim, not device-only keys — see the flagged assumption in `decisions.md`).
