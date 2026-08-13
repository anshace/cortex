# Cortex

**Cortex** is a private, authenticated, multi-file collaborative workspace: a
real-time collaborative code editor (Monaco + operational transformation).

Built on top of [Rustpad](https://github.com/ekzhang/rustpad)'s OT engine, with
a closed authentication layer, workspaces, multi-file editing, and admin-only
file upload/download added on top.

## Key properties

- **Closed by default.** No public signup. A default owner is created on first
  run and provisions every other account from the owner console. Every data
  route (documents, the collaborative socket, stats) requires a valid session;
  nothing is reachable anonymously.
- **Roles.** `admin` owns a workspace, adds members, and is the only role that
  can upload/download files. Regular `user`s can open and edit files
  collaboratively.
- **Multi-file, multi-user.** Each file is its own OT document; many users edit
  the same file in real time with live cursors.
- **SQLite** for users, sessions, workspaces, files, and document content.

## Prerequisites

- Rust toolchain (`rustup`) **with a C compiler/linker** — on Windows install
  the "Desktop development with C++" workload (provides `link.exe`); SQLite and
  crypto crates compile C.
- `wasm-pack` (`npm i -g wasm-pack`) and the `wasm32-unknown-unknown` target
  (`rustup target add wasm32-unknown-unknown`).
- Node.js + npm.

## Configure

No configuration is required to start. On first run (an empty database) the
server creates a **default owner** account:

```
username: admin
password: admin
```

Sign in and change the password immediately (Settings → Security). To set your
own initial owner instead, put `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env`
before the first start — they're ignored once any user exists.

`.env` also controls `SQLITE_URI` (defaults to `sqlite://authpad.db`) and
`PORT`. Everyone (owner and users) can change their own username and password
from Settings; the owner provisions additional accounts from the owner console.

## Run it (self-hosted)

Cortex ships as a single self-contained image — **one command, no domain, no
build, no clone:**

```bash
docker run -d -p 3030:3030 -v cortex-data:/data ghcr.io/anshace/cortex:latest
# → open http://localhost:3030, sign in as  admin / admin , then change the password
```

Everything (users, sessions, workspaces, files, chat) lives in SQLite inside the
`cortex-data` volume, so your data survives restarts and upgrades. Sign in as the
default owner; the owner creates orgs, workspaces, and accounts from the owner
console; an admin adds members and manages files; members join and edit.

### With your own domain + automatic HTTPS (optional)

Only needed if you want to serve Cortex on a public URL. `docker-compose.prod.yml`
adds Caddy, which fetches a TLS certificate for `DOMAIN` automatically. No real
domain? Point at your server's IP via sslip.io (e.g. `203.0.113.9.sslip.io`):

```bash
DOMAIN=203.0.113.9.sslip.io docker compose -f docker-compose.prod.yml up -d
```

`COOKIE_SECURE=1` (already set there) makes the session cookie HTTPS-only. Plain
`docker run` above works over HTTP with no domain and no Caddy. Full server
walkthrough: DEPLOY.md.

### Build from source instead of pulling the image

```bash
docker compose up --build      # builds the image locally → http://localhost:3030
```

### Dev loop (hot-reload, for hacking on Cortex)

```bash
docker compose -f docker-compose.dev.yml up   # → http://localhost:5173
```

Frontend hot-reloads; the backend recompiles on Rust changes. First `up` is slow
(builds the image); later runs are fast. Stop the other composes first — all use
port 3030.

## Build without Docker

```bash
(cd rustpad-wasm && wasm-pack build)   # WebAssembly OT core
npm install && npm run build           # frontend
cargo run --release --manifest-path rustpad-server/Cargo.toml
```

Requires a Rust toolchain with a C compiler/linker (on Windows: the VS "Desktop
development with C++" workload), `wasm-pack`, and the `wasm32-unknown-unknown`
target.

## Tests

```bash
cargo test --manifest-path rustpad-server/Cargo.toml auth   # auth unit tests
```

> Note: the original Rustpad integration tests under `rustpad-server/tests/`
> predate authentication and assume open access; they need updating for the
> locked model.
