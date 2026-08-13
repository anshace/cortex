# Contributing to Cortex

Thanks for your interest in improving Cortex! This is a self-hostable, real-time
collaborative code editor built on Rust + WebAssembly (OT core) and React +
Monaco.

## Getting started

The fastest way to run a full dev environment (no host toolchain needed):

```bash
docker compose -f docker-compose.dev.yml up   # → http://localhost:5173
```

Frontend hot-reloads; the backend recompiles on Rust changes. First `up` is
slow (it builds the image); later runs are fast.

To build natively instead, you need a Rust toolchain with a C compiler/linker,
[`wasm-pack`](https://rustwasm.github.io/wasm-pack/), the
`wasm32-unknown-unknown` target, and Node.js:

```bash
(cd rustpad-wasm && wasm-pack build)   # WebAssembly OT core
npm install && npm run build           # frontend
cargo run --release --manifest-path rustpad-server/Cargo.toml
```

## Making a change

1. **Fork** the repo and create a branch off `main` (`git switch -c fix/thing`).
2. Make your change. Keep it focused — one logical change per PR.
3. Run the checks locally before pushing:
   ```bash
   cargo test --lib --manifest-path rustpad-server/Cargo.toml   # backend unit tests
   npm run check                                               # frontend typecheck
   ```
   > The `tests/` integration suite is inherited from Rustpad and predates
   > authentication; it needs a rewrite for the gated model and is not run in CI
   > yet. Contributions that modernize it are welcome.
4. Open a pull request against `main`. Describe **what** changed and **why**.
   Link any related issue.

CI (see `.github/workflows/test.yml`) runs the same checks on every PR and must
pass before merge.

## Style & commits

- Match the style of the surrounding code; the repo has `.prettierrc` and
  `.editorconfig` — respect them.
- Write commit subjects in the imperative mood, scoped where it helps
  (`auth: …`, `chat: …`, `ci: …`). Explain non-obvious *why* in the body.
- Prefer the smallest change that solves the problem. Delete more than you add
  where you can.

## Reporting bugs & requesting features

Use the issue templates under **Issues → New issue**. For anything
security-sensitive, do **not** open a public issue — see
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the same
[MIT License](LICENSE) that covers this project.
