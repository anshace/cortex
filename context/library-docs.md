# Library Docs

## Installed agent skills / MCP servers

| Name | Where | What it is for |
|---|---|---|
| `project-context-system` | global: `~/.qoder/skills/project-context-system` | this system — bootstrap, session protocol, recording rules, sync pass |
| `agent-browser` | global | driving the real app for UI verification; screenshots are the evidence |
| `ui-ux-pro-max-skill`, `frontend-design`, `impeccable` | global | UI/UX doctrine when a surface is being designed |
| `plan`, `research`, `cross-review`, `zen-review` | global | planning and review lanes |
| `qoder_sites`, `browser-use`, `qmind` | MCP | other products; not used by this repo |

`project-context-system` was cloned into `~/.qoder/skills/` on 2026-09-29. Before
that it existed only as a GitHub repo, so no tool could load it — the reason it
appeared "not working". Re-clone with `git -C ~/.qoder/skills/project-context-system pull`
to update it.

## Per-library usage notes (project-specific)

### sqlx 0.6.3 + SQLite
`max_connections(1)`, WAL. A read on the pool inside an open transaction
deadlocks to a `pool timed out` error. `SQLITE_BUSY_SNAPSHOT` (517) forbids a
second pooled connection for read-then-write transactions, which is why
housekeeping stays on the app's own connection with short interruptible
statements. `sqlx::migrate!` embeds migration text **as checked out** — the
storage-shape fingerprint normalises `\r` because of it.

### warp 0.3
`path!` macros compose with `.and()` in declaration order, so a handler's
parameters follow the order its filters are chained. New routes must be
`.boxed()` before `.or()`-ing into the main chain.

### Chakra UI v2 + Emotion
`sx` seams need an explicit `border-style`; inset markers collapse against the
padding box; washes stay theme-aware only through tokens.

### aes-gcm / p256 / hkdf
Already regular deps, reused by the integration test client — no extra dev-dep
was needed to restore the socket suites.

### vite-plugin-pwa 1.3 (`generateSW`)
With `registerType: "prompt"` the update/offline banner component is the only
thing that registers the service worker; deleting it silently kills updates and
offline. Icons come from `npm run icons` (`scripts/make-icons.cjs`).

## Known operational constraints

- Rust needs a C linker (Windows: "Desktop development with C++"); WASM needs
  `wasm-pack` + `wasm32-unknown-unknown`.
- `target/` filled the disk once (61.5 GiB) and failed both a build and a
  commit. `[profile.dev]` now caps it: `debug = "line-tables-only"`,
  `incremental = false`, `codegen-units = 16` ≈ 2.9 GiB per cold cycle.
- The AI assistant's provider layer (`workspace/ai.rs`) is user/org-configured:
  anthropic / openai / azure profiles with keys sealed in the database. There is
  no vendor key in the repo and none should ever be added.
- **`reqwest` 0.11 is in the working tree only, not in `main`.** The AI assistant
  (`workspace/ai.rs`, `mcp.rs`, `search.rs`, `AiView.tsx`…) and its
  `reqwest = { json, rustls-tls, stream, gzip }` dependency are **uncommitted** as
  of 2026-09-29, so nothing on GitHub can make an outbound call today. `ring` 0.17
  and `hmac` are likewise reached through that uncommitted work. Consequence for
  #16: at `HEAD` there is genuinely **no HTTP client**, so the S3/R2 backend is
  still blocked on a dependency decision until either the AI work lands or an
  object backend brings its own transport.

## Docs sources

`DEPLOY.md` (operations, backups, recovery), `README.md` (quick start), this
`context/` folder, and upstream `ekzhang/rustpad` for the OT engine's origin.
