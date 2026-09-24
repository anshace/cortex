import { useId } from "react";

// The Cortex brand mark: a synapse — two nodes exchanging a signal across a
// shared core. The rounded accent→cyan tile and the S-curve come from the v2
// exploration; the satellite nodes and hairline strands are the v1
// constellation, kept as background detail so the glyph still reads at 22px.
// Gradient ids are per-instance: the mark renders twice on some screens
// (top bar + empty editor) and shared ids would let the first definition win.
function Logo({ size = 24, glow = true }: { size?: number; glow?: boolean }) {
  const raw = useId().replace(/[^a-zA-Z0-9]/g, "");
  const id = {
    tile: `cx-tile-${raw}`,
    sheen: `cx-sheen-${raw}`,
    halo: `cx-halo-${raw}`,
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Cortex"
      style={
        glow
          ? { filter: "drop-shadow(0 2px 10px rgba(107,91,255,0.45))" }
          : undefined
      }
    >
      <defs>
        <linearGradient id={id.tile} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a294ff" />
          <stop offset="0.52" stopColor="#6b5bff" />
          <stop offset="1" stopColor="#1fb6d8" />
        </linearGradient>
        <radialGradient id={id.sheen} cx="0.28" cy="0.18" r="0.72">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.3" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id.halo} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0.4" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.16" />
        </radialGradient>
      </defs>

      <rect width="64" height="64" rx="17" fill={`url(#${id.tile})`} />
      <rect width="64" height="64" rx="17" fill={`url(#${id.sheen})`} />
      <rect
        x="0.85"
        y="0.85"
        width="62.3"
        height="62.3"
        rx="16.3"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.28"
        strokeWidth="1.7"
      />
      <circle cx="32" cy="32" r="28" fill={`url(#${id.halo})`} />

      {/* Satellite nodes, echoing the v1 pentagon ring */}
      <g
        stroke="#ffffff"
        strokeOpacity="0.34"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <line x1="46" y1="18" x2="46" y2="38" />
        <line x1="18" y1="26" x2="18" y2="46" />
      </g>
      <g fill="#ffffff" fillOpacity="0.62">
        <circle cx="46" cy="18" r="2.6" />
        <circle cx="18" cy="46" r="2.6" />
      </g>

      {/* The signal path between the two peers */}
      <path
        d="M18 23c0-4 3.2-7 7-7s7 3 7 7v18c0 4 3.2 7 7 7s7-3 7-7"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.95"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <g fill="#ffffff">
        <circle cx="18" cy="23" r="5.2" />
        <circle cx="46" cy="41" r="5.2" />
      </g>
      <circle cx="32" cy="32" r="3.6" fill="#ffffff" fillOpacity="0.72" />
    </svg>
  );
}

export default Logo;
