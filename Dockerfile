# syntax=docker/dockerfile:1
#
# Build caching strategy (turns the ~8-min CI build into ~2-3 min on cache hits):
#
# The two Rust stages used to be the bottleneck: BuildKit cache mounts
# (--mount=type=cache) are builder-local, so on CI every run started with an
# EMPTY target/ and the whole dependency tree recompiled from scratch — the
# GHA layer cache (`cache-from: type=gha` in ci.yml) could never capture it.
#
# Fix: make the dependency compilation its own *image layer* so the existing
# GHA layer cache actually persists it across runs.
#
#   backend  → cargo-chef: "prepare" a recipe (the dep manifest, keyed on
#              Cargo.toml/Cargo.lock only), "cook" it once into a cached layer,
#              then the real build recompiles just the changed app sources.
#   wasm     → same idea without the extra tool: pre-build the wasm dependency
#              graph with stub sources (also keyed on Cargo.toml/Cargo.lock),
#              then wasm-pack only rebuilds the wasm crate itself.
#
# Frontend was already layer-cached (package.json + package-lock.json → npm ci) and is cheap.

FROM rust:alpine AS chef-planner
WORKDIR /home/rust/src
RUN apk --no-cache add musl-dev openssl-dev \
    && cargo install cargo-chef --locked
COPY Cargo.toml Cargo.lock ./
COPY rustpad-server rustpad-server
COPY rustpad-wasm rustpad-wasm
# Recipe = dependency manifest. Only Cargo.toml/Cargo.lock changes alter it.
RUN cargo chef prepare --recipe-path recipe.json

FROM rust:alpine AS chef-cacher
WORKDIR /home/rust/src
COPY --from=chef-planner /usr/local/cargo/bin/cargo-chef /usr/local/cargo/bin/cargo-chef
COPY --from=chef-planner /home/rust/src/recipe.json recipe.json
RUN apk --no-cache add musl-dev openssl-dev \
    && cargo chef cook --release --recipe-path recipe.json

FROM rust:alpine AS backend
WORKDIR /home/rust/src
# Reuse the pre-compiled deps and the cargo registry cache from the cacher
# stage, so the build below recompiles only the app crates and re-downloads
# nothing. (No cache mounts here — a mount would shadow the baked-in target/.)
COPY --from=chef-cacher /usr/local/cargo /usr/local/cargo
COPY --from=chef-cacher /home/rust/src/target /home/rust/src/target
RUN apk --no-cache add musl-dev openssl-dev
COPY Cargo.toml Cargo.lock ./
COPY rustpad-server rustpad-server
COPY rustpad-wasm rustpad-wasm
# No tests here — deploy builds ship the binary; run `cargo test` locally / in CI.
RUN cargo build --release \
    && cp target/release/rustpad-server /rustpad-server

FROM --platform=amd64 rust:alpine AS wasm
WORKDIR /home/rust/src
RUN apk --no-cache add curl musl-dev \
    && curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
# Manifests only — the next layer compiles the whole wasm dependency graph
# (wasm-bindgen, js-sys, …) with stub sources, so it stays warm across source
# edits and only busts when the manifests change. Stubs let the workspace
# resolve without pulling in rustpad-server's (host-only) deps for wasm32.
COPY Cargo.toml Cargo.lock ./
COPY rustpad-server/Cargo.toml rustpad-server/
COPY rustpad-wasm/Cargo.toml rustpad-wasm/
RUN mkdir -p rustpad-server/src rustpad-wasm/src \
    && echo 'fn main() {}' > rustpad-server/src/main.rs \
    && : > rustpad-server/src/lib.rs \
    && : > rustpad-wasm/src/lib.rs \
    && rustup target add wasm32-unknown-unknown \
    && cargo build --release --target wasm32-unknown-unknown -p rustpad-wasm
COPY rustpad-server rustpad-server
COPY rustpad-wasm rustpad-wasm
# pkg/ is written outside target/, so the cached target survives. Only the wasm
# crate's own sources recompile here.
#
# COPY preserves the sources' mtimes, which can be OLDER than the stub-compiled
# artifacts in the cached target/ — cargo would then treat the crate as fresh
# and link the EMPTY stub rlib into the pkg (no OpSeq export), which breaks the
# frontend typecheck. Touch the sources so cargo sees them as newer and
# recompiles the real crate (the dependency artifacts stay cached).
RUN touch rustpad-wasm/src/*.rs \
    && wasm-pack build rustpad-wasm

FROM --platform=amd64 node:lts-alpine AS frontend
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
COPY --from=wasm /home/rust/src/rustpad-wasm/pkg rustpad-wasm/pkg
# `npm ci` (not `install`): installs the exact locked versions, so a dependency
# bump in package.json without a synced lockfile fails the build loudly instead
# of silently resolving newer, possibly incompatible versions (the vite 6→8
# lockfile drift is what broke this build).
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run check
RUN npm run build

# Alpine (not scratch) so we get a writable data dir, CA certs, and a real user.
# Caddy is baked in so ONE container serves app + auto-HTTPS (see docker-entrypoint.sh).
FROM alpine AS runtime
RUN apk --no-cache add ca-certificates caddy libcap \
    && adduser -D -u 1000 app \
    && mkdir -p /data && chown app /data \
    && setcap cap_net_bind_service=+ep "$(command -v caddy)"  # let non-root bind 80/443
WORKDIR /app
COPY --from=frontend /usr/src/app/dist dist
COPY --from=backend /rustpad-server .
COPY Caddyfile /etc/caddy/Caddyfile
COPY docker-entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint
USER app
# XDG_* point Caddy's cert store at the /data volume so certs persist across restarts.
ENV SQLITE_URI=sqlite:///data/authpad.db \
    XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/data
EXPOSE 80 443 3030
ENTRYPOINT [ "entrypoint" ]
