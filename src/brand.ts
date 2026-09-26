// Single source of truth for the product's public identity.
// Change these to rename the product everywhere.
export const BRAND = {
  name: "Cortex",
  tagline: "Collaborative Workspace",
  // What the install prompt, the manifest and the page metadata say the product
  // is. vite.config.ts reads this, so the installed app cannot describe itself
  // differently from the site.
  description: "Cortex — a private, collaborative workspace.",
  // Accent used across the UI.
  accent: "purple",
} as const;
