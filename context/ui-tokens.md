# UI Tokens

Semantic layer only — components never use a raw ramp hex, because that is what
stops a surface following the colour mode.

| Token | Meaning |
|---|---|
| `surface.bg` | page background, follows light/dark |
| `surface.raised` | card and panel background |
| `surface.border` | hairline borders and seams |
| `ink.base` | primary text |
| `ink.muted` | secondary text |
| `ink.subtle` | metadata, captions, mono hints |
| `brand.300` / `brand.400` | the single azure accent; 400 for fills, 300 for text on tint |
| `state.ok` / `state.warn` / `state.bad` / `state.info` | semantic status colours |
| `state.warnTint` | pre-computed wash for warning callouts |
| `accent.cyan` | sparing second accent (object storage) |
| `spectral.400` | neutral data hue |

`tint(token, percent)` builds washes from a token so they stay theme-aware;
`hue` props on `Chip`/`CardTitle`/`KV` take a token, not a hex.

Typography: Inter variable for UI, JetBrains Mono for numbers and identifiers;
`textStyle="num"` (tabular figures) for anything that counts, `textStyle="eyebrow"`
for section labels.

Rules that are decisions, not taste: surfaces follow the colour mode (no
always-dark panels); radii stay 6-10px; one accent, cool neutrals; destructive
actions use `state.bad` and are visually separated. See `ui-rules.md`.
