/**
 * Regenerates the PWA icons from the brand mark in src/Logo.tsx.
 *
 *   node scripts/make-icons.cjs
 *
 * The mark lives in the app as React SVG; the installed app on a phone or
 * desktop gets rasterized PNGs, and those drift out of sync the moment the mark
 * changes (they did: the shipped icons were the pre-redesign pentagon while the
 * UI had moved to the synapse tile). This keeps one geometry — the 64-unit mark
 * below — and emits every size the manifest declares.
 *
 * Standard icons are full-bleed: the OS applies its own mask, and a pre-rounded
 * icon with a dark surround reads as a screenshot of an app inside an app.
 * The maskable variant pulls the glyph inside the 80% safe zone instead.
 */
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const sharp = require("sharp");

const OUT = join(__dirname, "..", "public");

// Accent→cyan tile with a corner sheen, sampled from the palette in src/Logo.tsx.
// src/Logo.tsx. Kept literal on purpose: an icon is rasterized once at build
// time and must not depend on the theme the browser happens to be in.
const TILE = `<defs>
  <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#a294ff"/>
    <stop offset="0.52" stop-color="#6b5bff"/>
    <stop offset="1" stop-color="#1fb6d8"/>
  </linearGradient>
  <radialGradient id="sheen" cx="0.28" cy="0.18" r="0.78">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.34"/>
    <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
  </radialGradient>
</defs>
<rect width="64" height="64" fill="url(#tile)"/>
<rect width="64" height="64" fill="url(#sheen)"/>`;

/** The synapse: two peers, the signal path between them, a shared core. */
const GLYPH = `<g stroke="#ffffff" stroke-opacity="0.34" stroke-width="1.8" stroke-linecap="round">
  <line x1="46" y1="18" x2="46" y2="38"/>
  <line x1="18" y1="26" x2="18" y2="46"/>
</g>
<g fill="#ffffff" fill-opacity="0.62">
  <circle cx="46" cy="18" r="2.6"/>
  <circle cx="18" cy="46" r="2.6"/>
</g>
<path d="M18 23c0-4 3.2-7 7-7s7 3 7 7v18c0 4 3.2 7 7 7s7-3 7-7" fill="none"
      stroke="#ffffff" stroke-opacity="0.95" stroke-width="4" stroke-linecap="round"/>
<g fill="#ffffff">
  <circle cx="18" cy="23" r="5.2"/>
  <circle cx="46" cy="41" r="5.2"/>
</g>
<circle cx="32" cy="32" r="3.6" fill="#ffffff" fill-opacity="0.72"/>`;

const svg = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512">
${TILE}
<g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${GLYPH}</g>
</svg>`;

// 0.88 keeps the glyph's own margins visible on a full-bleed tile; 0.70 pulls it
// inside the maskable safe zone, where the OS crops to a circle or squircle.
const ICONS = [
  { file: "pwa-192.png", px: 192, scale: 0.88 },
  { file: "pwa-512.png", px: 512, scale: 0.88 },
  { file: "pwa-maskable-512.png", px: 512, scale: 0.7 },
  { file: "apple-touch-icon.png", px: 180, scale: 0.84 },
];

(async () => {
  for (const { file, px, scale } of ICONS) {
    const buf = Buffer.from(svg(scale));
    await sharp(buf, { density: 400 }).resize(px, px).png().toFile(join(OUT, file));
    console.log(`${file.padEnd(26)} ${px}x${px}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
