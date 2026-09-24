import { type ThemeConfig, extendTheme } from "@chakra-ui/react";

// Cortex design system — a cool graphite neutral base with a thin violet/indigo
// accent and a cyan secondary. Light + dark are both first-class via semantic
// tokens; components reference the token names (surface.*, ink.*) and adapt
// automatically.
//
// Three things carry the look, in order of how visible they are:
//   1. borders are alpha hairlines over the surface, not opaque grey, so a
//      panel's edge reads as light catching a bevel rather than as a drawn line;
//   2. elevation is layered (a tight contact shadow plus a wide ambient one), so
//      popovers feel physically stacked instead of floating on a blur;
//   3. motion is standardized on two easings and three durations (see
//      `transition` below, and the cx-* keyframes in index.css), with a global
//      prefers-reduced-motion kill switch.
const config: ThemeConfig = {
  initialColorMode: "dark",
  useSystemColorMode: false,
};

const fontStack = `"Inter Variable", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
const monoStack = `"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace`;

// The eight-step graphite ramp, dark side. Each step is ~4% lighter than the
// last so a nested panel is distinguishable without a border doing the work.
const dark = {
  deep: "#07080b",
  bg: "#0a0b0e",
  panel: "#101216",
  panel2: "#14161c",
  raised: "#181b22",
  hover: "#1e222b",
  active: "#262b36",
  sunken: "#0c0e12",
};

const light = {
  deep: "#f1f1ef",
  bg: "#fbfbfa",
  panel: "#ffffff",
  panel2: "#f7f7f5",
  raised: "#ffffff",
  hover: "#efefec",
  active: "#e5e5e1",
  sunken: "#f7f7f5",
};

// Hairlines: white-alpha on graphite, ink-alpha on paper. Three steps — quiet
// edge, edge that must be seen (inputs, dividers), and the strongest (hovered
// or focused boundaries).
const line = (a: number) => `rgba(255,255,255,${a})`;
const lineInk = (a: number) => `rgba(16,18,27,${a})`;

const theme = extendTheme({
  config,
  fonts: {
    heading: fontStack,
    body: fontStack,
    mono: monoStack,
  },
  colors: {
    // Indigo accent ramp for the Mono direction (works on both grounds).
    brand: {
      50: "#eeecff",
      100: "#ddd9ff",
      200: "#c0b8ff",
      300: "#a294ff",
      400: "#8b7bff",
      500: "#6b5bff",
      600: "#5b4bd6",
      700: "#4a3cae",
      800: "#392e88",
      900: "#2a2266",
    },
    // The secondary hue: presence, links-to-code, and "live" telemetry.
    spectral: {
      300: "#67e3f5",
      400: "#3fd8ee",
      500: "#22d3ee",
      600: "#0ea5c0",
      700: "#0b7f94",
    },
    // Status hues at full strength; use the `state.*` semantic tokens below for
    // the tinted-background form badges and callouts need.
    signal: {
      ok: "#34d399",
      warn: "#fbbf24",
      bad: "#fb7185",
      info: "#60a5fa",
    },
  },
  semanticTokens: {
    colors: {
      // Surfaces, darkest to lightest. `deep` is the void behind full-bleed
      // screens, `sunken` is where fields sit (below the panel they belong to).
      "surface.deep": { default: light.deep, _dark: dark.deep },
      "surface.bg": { default: light.bg, _dark: dark.bg },
      "surface.panel": { default: light.panel, _dark: dark.panel },
      "surface.panel2": { default: light.panel2, _dark: dark.panel2 },
      "surface.raised": { default: light.raised, _dark: dark.raised },
      "surface.hover": { default: light.hover, _dark: dark.hover },
      "surface.active": { default: light.active, _dark: dark.active },
      "surface.sunken": { default: light.sunken, _dark: dark.sunken },
      // Translucent variant for popovers that want the blur behind them.
      "surface.glass": {
        default: "rgba(255,255,255,0.88)",
        _dark: "rgba(22,25,32,0.86)",
      },
      "surface.border": { default: lineInk(0.1), _dark: line(0.07) },
      "surface.borderMid": { default: lineInk(0.16), _dark: line(0.13) },
      "surface.borderStrong": { default: lineInk(0.26), _dark: line(0.2) },
      "ink.base": { default: "#10121b", _dark: "#e9ebf2" },
      "ink.muted": { default: "#565d6d", _dark: "#9ba2b4" },
      "ink.subtle": { default: "#8b909c", _dark: "#666d80" },
      // Accent aliases so call sites read as intent rather than as a step on a
      // ramp: `accent.base` is what something is, `accent.hi` what it becomes on
      // hover, `accent.glow` the ring it casts when focused.
      "accent.base": { default: "#5b4bd6", _dark: "#8b7bff" },
      "accent.hi": { default: "#6b5bff", _dark: "#a294ff" },
      "accent.lo": { default: "#4a3cae", _dark: "#4f3fd6" },
      "accent.glow": {
        default: "rgba(91,75,214,0.35)",
        _dark: "rgba(124,107,255,0.42)",
      },
      "accent.cyan": { default: "#0b7f94", _dark: "#22d3ee" },
      "accent.tint": {
        default: "rgba(91,75,214,0.09)",
        _dark: "rgba(139,123,255,0.14)",
      },
      // Status as a pair: the saturated ink for text/icons and a ~15% wash for
      // the chip behind it. Always used together, never as a solid fill.
      "state.ok": { default: "#047857", _dark: "#34d399" },
      "state.okTint": {
        default: "rgba(4,120,87,0.12)",
        _dark: "rgba(52,211,153,0.15)",
      },
      "state.warn": { default: "#92400e", _dark: "#fbbf24" },
      "state.warnTint": {
        default: "rgba(146,64,14,0.12)",
        _dark: "rgba(251,191,36,0.15)",
      },
      "state.bad": { default: "#be123c", _dark: "#fb7185" },
      "state.badTint": {
        default: "rgba(190,18,60,0.12)",
        _dark: "rgba(251,113,133,0.15)",
      },
      "state.info": { default: "#1d4ed8", _dark: "#60a5fa" },
      "state.infoTint": {
        default: "rgba(29,78,216,0.12)",
        _dark: "rgba(96,165,250,0.15)",
      },
      // Chat bubbles — incoming is WhatsApp's grey-teal in dark / white in
      // light; outgoing stays the brand accent (Telegram vibe). Meta = the
      // small timestamp/check colour inside each bubble. chat.bg is the
      // wallpaper base (WhatsApp's beige / dark-teal).
      "chat.bg": { default: "#efeae2", _dark: "#0b141a" },
      "chat.incoming": { default: "#ffffff", _dark: "#202c33" },
      "chat.incomingBorder": { default: "#e5e5e1", _dark: "#2f3b41" },
      "chat.incomingText": { default: "#111b21", _dark: "#e9edef" },
      "chat.incomingMeta": { default: "#667781", _dark: "#8696a0" },
      "chat.read": { default: "#34b7f1", _dark: "#53bdeb" }, // read-receipt blue
    },
  },
  shadows: {
    // Contact + ambient, the pair that makes an edge look real. Every level adds
    // a hair of top-light so raised surfaces separate on the darkest grounds.
    xs: "0 1px 2px rgba(0,0,0,0.16)",
    sm: "0 1px 2px rgba(0,0,0,0.22), 0 1px 1px rgba(255,255,255,0.03)",
    outline: "0 0 0 2px var(--chakra-colors-surface-bg), 0 0 0 4px rgba(124,107,255,0.55)",
    // Pressed fields: the shadow is inside, so the well reads as recessed.
    inset: "inset 0 1px 2px rgba(0,0,0,0.24)",
    card: "0 1px 2px rgba(0,0,0,0.2), 0 8px 24px -16px rgba(0,0,0,0.45)",
    pop: "0 2px 4px rgba(0,0,0,0.16), 0 16px 44px -16px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)",
  },
  radii: {
    xs: "4px",
    sm: "5px",
    md: "7px",
    lg: "10px",
    xl: "14px",
    "2xl": "18px",
    "3xl": "24px",
  },
  textStyles: {
    // Small all-caps label over a section. Mono, because it sits above lists of
    // identifiers and file names, and mixing it with proportional caps makes
    // the row look ragged.
    eyebrow: {
      fontFamily: "mono",
      fontSize: "10px",
      fontWeight: 600,
      letterSpacing: "0.09em",
      textTransform: "uppercase",
      color: "ink.subtle",
    },
    // Anything numeric — sizes, counts, latency — is tabular so columns align.
    num: {
      fontVariantNumeric: "tabular-nums",
      fontFamily: "mono",
    },
  },
  styles: {
    global: {
      "html, body, #root": { height: "100%" },
      body: {
        bg: "surface.bg",
        color: "ink.base",
        WebkitFontSmoothing: "antialiased",
        MozOsxFontSmoothing: "grayscale",
        fontFeatureSettings: "'cv02', 'cv03', 'cv04', 'ss01'",
        textRendering: "optimizeLegibility",
      },
      // Headings get display-style tracking everywhere at once.
      "h1, h2, h3, h4, h5, h6": {
        letterSpacing: "-0.022em",
        textWrap: "balance",
      },
      "::selection": { background: "rgba(109,94,252,0.35)" },
      "*:focus-visible": {
        outline: "2px solid var(--chakra-colors-accent-glow)",
        outlineOffset: "1px",
      },
      // Thin pill thumbs that float in the track: 8px total, 3px of which is
      // transparent padding, so the thumb never touches the panel edge.
      "*::-webkit-scrollbar": { width: "8px", height: "8px" },
      "*::-webkit-scrollbar-thumb": {
        background: "var(--chakra-colors-surface-borderStrong)",
        borderRadius: "8px",
        border: "2px solid transparent",
        backgroundClip: "content-box",
        transition: "background 0.18s cubic-bezier(0.22, 1, 0.36, 1)",
      },
      "*::-webkit-scrollbar-thumb:hover": {
        background: "var(--chakra-colors-ink-subtle)",
        border: "2px solid transparent",
        backgroundClip: "content-box",
      },
      "*::-webkit-scrollbar-track": { background: "transparent" },
    },
  },
  components: {
    Button: {
      defaultProps: { colorScheme: "brand" },
      baseStyle: {
        fontWeight: 600,
        borderRadius: "lg",
        letterSpacing: "-0.01em",
        transition:
          "background 0.15s cubic-bezier(0.22,1,0.36,1), color 0.15s, border-color 0.15s, box-shadow 0.15s, transform 0.09s cubic-bezier(0.34,1.4,0.64,1)",
        _focusVisible: { boxShadow: "outline" },
        // A press should move. 2% of scale reads as tactile without bouncing.
        _active: { transform: "scale(0.98)" },
      },
      variants: {
        // Quiet secondary action that reads clearly on panels.
        subtle: {
          bg: "surface.hover",
          color: "ink.base",
          _hover: { bg: "surface.borderStrong" },
        },
        // Accent-tinted, for the one action in a dialog that is not the default.
        soft: {
          bg: "accent.tint",
          color: "accent.base",
          _hover: { bg: "var(--chakra-colors-accent-glow)" },
        },
        // Destructive actions are tinted, never solid red — a solid red button
        // asks for a click; a tinted one asks for a decision.
        danger: {
          bg: "state.badTint",
          color: "state.bad",
          _hover: { bg: "var(--chakra-colors-state-bad)", color: "surface.panel" },
        },
        // Bordered ghost: an affordance in a toolbar that must not shout.
        outline: {
          borderColor: "surface.borderMid",
          _hover: {
            borderColor: "surface.borderStrong",
            bg: "surface.hover",
          },
        },
      },
    },
    IconButton: {
      baseStyle: {
        borderRadius: "md",
        transition:
          "background 0.15s cubic-bezier(0.22,1,0.36,1), color 0.15s, transform 0.09s cubic-bezier(0.34,1.4,0.64,1)",
        _active: { transform: "scale(0.94)" },
      },
    },
    // Panels, dialogs and menus: layered hairline surfaces with a shared
    // elevation so popovers read as physically stacked.
    Input: {
      defaultProps: { focusBorderColor: "accent.base" },
      variants: {
        outline: {
          field: {
            bg: "surface.sunken",
            borderColor: "surface.borderMid",
            borderRadius: "lg",
            boxShadow: "inset",
            _hover: { borderColor: "surface.borderStrong" },
            _placeholder: { color: "ink.subtle" },
          },
        },
      },
    },
    Textarea: {
      defaultProps: { focusBorderColor: "accent.base" },
      variants: {
        outline: {
          bg: "surface.sunken",
          borderColor: "surface.borderMid",
          borderRadius: "lg",
          boxShadow: "inset",
          _hover: { borderColor: "surface.borderStrong" },
          _placeholder: { color: "ink.subtle" },
        },
      },
    },
    Select: {
      defaultProps: { focusBorderColor: "accent.base" },
      variants: {
        outline: {
          field: {
            bg: "surface.sunken",
            borderColor: "surface.borderMid",
            borderRadius: "lg",
            boxShadow: "inset",
            _hover: { borderColor: "surface.borderStrong" },
          },
        },
      },
    },
    Tooltip: {
      defaultProps: {
        // 320ms: long enough that sweeping the mouse across a toolbar never
        // fires a tooltip, short enough that a deliberate pause always does.
        openDelay: 320,
        closeDelay: 120,
      },
      baseStyle: {
        bg: "surface.glass",
        color: "ink.base",
        border: "1px solid",
        borderColor: "surface.border",
        borderRadius: "md",
        fontSize: "xs",
        px: 2.5,
        py: 1.5,
        boxShadow: "pop",
        backdropFilter: "blur(12px) saturate(1.4)",
      },
    },
    Kbd: {
      baseStyle: {
        bg: "surface.sunken",
        border: "1px solid",
        borderColor: "surface.borderMid",
        borderRadius: "sm",
        boxShadow: "sm",
        color: "ink.muted",
        fontSize: "10px",
        fontWeight: 600,
        px: "5px",
        py: "1px",
        minHeight: "18px",
      },
    },
    // Every dropdown menu (context menus, language picker, account menu…).
    Menu: {
      baseStyle: {
        list: {
          bg: "surface.glass",
          backdropFilter: "blur(16px) saturate(1.4)",
          border: "1px solid",
          borderColor: "surface.border",
          borderRadius: "lg",
          boxShadow: "pop",
          py: 1,
          minW: "184px",
        },
        item: {
          bg: "transparent",
          color: "ink.base",
          fontSize: "sm",
          borderRadius: "md",
          mx: 1,
          px: 2.5,
          py: 1.5,
          transition: "background 0.12s, color 0.12s",
          _hover: { bg: "surface.hover" },
          _focus: { bg: "surface.hover" },
        },
        divider: { borderColor: "surface.border", my: 1 },
        groupTitle: {
          textStyle: "eyebrow",
          mx: 3,
        },
      },
    },
    // AlertDialog shares this component key, so confirm/prompt dialogs get it too.
    Modal: {
      baseStyle: {
        overlay: { bg: "blackAlpha.600", backdropFilter: "blur(4px)" },
        dialog: {
          bg: "surface.panel",
          borderRadius: "2xl",
          border: "1px solid",
          borderColor: "surface.borderMid",
          boxShadow: "pop",
          mx: 4,
        },
        header: { fontSize: "md", fontWeight: 700, pb: 2 },
        closeButton: {
          borderRadius: "md",
          color: "ink.muted",
          _hover: { bg: "surface.hover", color: "ink.base" },
        },
      },
    },
    Popover: {
      baseStyle: {
        content: {
          bg: "surface.glass",
          backdropFilter: "blur(16px) saturate(1.4)",
          border: "1px solid",
          borderColor: "surface.border",
          borderRadius: "lg",
          boxShadow: "pop",
          _focusVisible: { outline: "none", boxShadow: "pop" },
        },
      },
    },
    Drawer: {
      baseStyle: {
        overlay: { bg: "blackAlpha.600", backdropFilter: "blur(4px)" },
        dialog: { bg: "surface.panel" },
      },
    },
    Card: {
      baseStyle: {
        container: {
          bg: "surface.panel",
          borderRadius: "xl",
          border: "1px solid",
          borderColor: "surface.border",
          boxShadow: "card",
          transition:
            "border-color 0.15s cubic-bezier(0.22,1,0.36,1), box-shadow 0.15s",
        },
      },
    },
    Switch: { defaultProps: { colorScheme: "brand" } },
    Tabs: { defaultProps: { colorScheme: "brand" } },
    // Field labels read as the eyebrow recipe, spelled out rather than
    // referenced by textStyle so the label's own colour always wins.
    FormLabel: {
      baseStyle: {
        fontFamily: "mono",
        fontSize: "10px",
        fontWeight: 600,
        letterSpacing: "0.09em",
        textTransform: "uppercase",
        color: "ink.muted",
      },
    },
    // Hairlines everywhere: call sites shouldn't repeat the border token.
    Divider: {
      baseStyle: { borderColor: "surface.border" },
    },
    Badge: {
      baseStyle: {
        borderRadius: "full",
        textTransform: "none",
        fontWeight: 600,
        letterSpacing: "0",
      },
    },
  },
});

export default theme;
