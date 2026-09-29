# UI Rules

Rules this project settled on through rejected drafts, so they don't get
re-litigated. Each one exists because a version that broke it was built and
refused.

## Layout

- **No top bar** and **no right-hand dock** as primary chrome. Navigation is a
  slim left rail; the rail does not carry People or Settings.
- A **full-width status bar** sits at the bottom; console tabs are **centred and
  segmented**, not left-aligned.
- Collaboration affordances live in the surface they act on, not in a separate
  panel that competes with it.
- Mobile-first: `min-h-dvh` not `100vh`, no horizontal scroll, primary touch
  targets ≥ 44px.

## Colour

- Cool neutrals plus **one azure accent**. Warm ivory/amber palettes and razor
  corners were rejected as "dirty".
- Colour everywhere **and theme-aware**: every surface follows the colour mode;
  no always-dark panels; tokens only (`ui-tokens.md`).
- Radii 6-10px. Flat elevation scale; no mixed shadow languages.

## Components behavior

- Destructive actions: `state.bad`, visually separated, and the confirmation
  states **what is destroyed**, not just "are you sure". A confirmation that
  understates irreversibility is a bug (fixed for org deletion in v0.1.3).
- Row actions reveal on hover but stay reachable by keyboard, with `aria-label`
  on every icon button — those labels are also how UI is verified programmatically.
- Loading > 300ms shows a skeleton or disabled-with-spinner state; async buttons
  disable while in flight.
- Errors render near the field that caused them and name the recovery.
- Empty states name the next action.

## Motion

150-300ms, transform/opacity only, `--cx-ease-soft` easing, exits shorter than
enters, and nothing animates that isn't communicating a cause.

## Bans

Emoji as icons. Decorative-only animation. Raw hex in components. Toasts that
steal focus. A second primary CTA on one surface. Marketing wording in
in-app chrome ("deployment environments", not "dev team"). Sales vocabulary in
docs.
