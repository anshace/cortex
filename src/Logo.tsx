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
        <linearGradient id="cortex-logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1c1a2e" />
          <stop offset="1" stopColor="#0d0b1a" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#cortex-logo-g)" />
      {/* Central node with 5 blue strands to 5 light-lavender nodes (pentagon). */}
      <g stroke="#5b6ef5" strokeWidth="3" strokeLinecap="round">
        <line x1="32" y1="32" x2="32" y2="14" />
        <line x1="32" y1="32" x2="49" y2="26" />
        <line x1="32" y1="32" x2="43" y2="47" />
        <line x1="32" y1="32" x2="21" y2="47" />
        <line x1="32" y1="32" x2="15" y2="26" />
      </g>
      <g fill="#c7bcf6">
        <circle cx="32" cy="32" r="6.5" fill="#7c6ff0" />
        <circle cx="32" cy="14" r="4" />
        <circle cx="49" cy="26" r="4" />
        <circle cx="43" cy="47" r="4" />
        <circle cx="21" cy="47" r="4" />
        <circle cx="15" cy="26" r="4" />
      </g>
    </svg>
  );
}

export default Logo;
