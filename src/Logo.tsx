// The Cortex brand mark — a small neural-node glyph, matching the favicon.
function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Cortex"
    >
      <defs>
        <linearGradient id="cortex-logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#201d36" />
          <stop offset="1" stopColor="#0c0a1a" />
        </linearGradient>
        <radialGradient id="cortex-logo-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#5b6ef5" stopOpacity="0.38" />
          <stop offset="1" stopColor="#5b6ef5" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="cortex-logo-strand" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5b6ef5" />
          <stop offset="1" stopColor="#8b7cf8" />
        </linearGradient>
        <radialGradient id="cortex-logo-node" cx="0.35" cy="0.3" r="1">
          <stop offset="0" stopColor="#f0ebff" />
          <stop offset="1" stopColor="#b2a5f2" />
        </radialGradient>
        <radialGradient id="cortex-logo-core" cx="0.35" cy="0.3" r="1">
          <stop offset="0" stopColor="#a99cff" />
          <stop offset="1" stopColor="#5a4ed6" />
        </radialGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="url(#cortex-logo-bg)" />
      <rect
        x="1"
        y="1"
        width="62"
        height="62"
        rx="13"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.07"
        strokeWidth="1.5"
      />
      {/* Soft halo behind the network */}
      <circle cx="32" cy="32" r="24" fill="url(#cortex-logo-glow)" />
      <circle
        cx="32"
        cy="32"
        r="12"
        fill="none"
        stroke="#8b7cf8"
        strokeOpacity="0.22"
        strokeWidth="1"
      />
      {/* 5 strands from the core to the outer nodes (pentagon) */}
      <g stroke="url(#cortex-logo-strand)" strokeWidth="2.5" strokeLinecap="round">
        <line x1="32" y1="32" x2="32" y2="14" />
        <line x1="32" y1="32" x2="49" y2="26" />
        <line x1="32" y1="32" x2="43" y2="47" />
        <line x1="32" y1="32" x2="21" y2="47" />
        <line x1="32" y1="32" x2="15" y2="26" />
      </g>
      {/* Outer nodes: dimensional orbs */}
      <g fill="url(#cortex-logo-node)">
        <circle cx="32" cy="14" r="4.2" />
        <circle cx="49" cy="26" r="4.2" />
        <circle cx="43" cy="47" r="4.2" />
        <circle cx="21" cy="47" r="4.2" />
        <circle cx="15" cy="26" r="4.2" />
      </g>
      {/* Core node */}
      <circle cx="32" cy="32" r="7.5" fill="url(#cortex-logo-core)" />
    </svg>
  );
}

export default Logo;
