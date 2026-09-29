# Code Standards

## Language & types

TypeScript strict, no `any` without a reason on the adjacent line. React
function components only. Rust idiomatic and clippy-clean against the recorded
baseline (one pre-existing `too_many_arguments` warning at
`database.rs::create_uploaded_file` — anything else is new and yours to fix).

Rust errors: `anyhow::Result` at the database layer, and a handler must never
turn an `Err` into a denial. `Err` is 503 `database busy`; `Ok(None)` is the
denial. That distinction was a class of shipped bugs (#31).

## Framework conventions

- **Chakra v2** for layout and styling; semantic tokens only (`surface.*`,
  `ink.*`, `brand.*`, `state.*`, `accent.*`) and `tint()` for washes. Never a
  raw ramp hex in a component — that is what breaks theme-awareness.
- **warp 0.3** route chains: each added route `.boxed()` separately; the main
  chain sits at the compiler's nesting limit.
- **sqlx 0.6.3**: bind everything; build dynamic SQL only from integers and
  identifiers we own (see the `DELETE FROM users WHERE id NOT IN (…)` pattern).
- Handler order is a rule: authorize → then drain the request body. A 16 MB
  upload must not be read before the access gate is earned.

## Structure

`database.rs` holds queries and tenancy; routes live in `workspace/`. A new
query belongs on `Database`, not inline in a handler. Frontend: every call the
browser makes goes through `api.ts` — no component fetches a URL directly.

## Comments

Default to none. Write one only where the *why* is non-obvious: a hidden
constraint, an invariant, a workaround, a surprise a reader would otherwise
take as a bug. Most of the long comments in this repo exist because a measured
failure forced them; match that standard, and never narrate what code does.

## Testing

- The gate is `npm test` (= `cargo test --workspace`). `--lib` compiles none of
  `rustpad-server/tests/`, so it proves less than it looks.
- New logic ships its failing test first (RED-GREEN-REFACTOR). No test-after.
- Every new assertion gets mutation-checked or revert-proved: break the thing it
  guards, watch it fail, revert. An assertion that passes either way is noise.
- Concurrency tests run ~10 times before anyone calls them green.
- Re-run gates **after** committing, on the committed tree.
- UI has no unit-test suite; it is verified by driving the running app and
  reading the rendered DOM plus a screenshot. Never from the CSS just written.

## Quality gates

```sh
npm test      # cargo test --workspace — the gate
npm run check # tsc
npm run build # production build (catches PWA/bundle breakage)
cargo clippy --workspace --all-targets
```

Never run `prettier --write` or `cargo fmt`: the working tree is CRLF and
reformatting rewrites every line ending, which for migrations changes the DDL
text `sqlx::migrate!` embeds.
