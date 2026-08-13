import { extendTheme, type ThemeConfig } from "@chakra-ui/react";

// Cortex design system — a cool graphite neutral base with a thin violet/indigo
// accent. Light + dark are both first-class via semantic tokens; components
// reference the token names (surface.*, ink.*) and adapt automatically.
const config: ThemeConfig = {
  initialColorMode: "dark",
  useSystemColorMode: false,
};

const fontStack = `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

const theme = extendTheme({
  config,
  fonts: {
    heading: fontStack,
    body: fontStack,
    mono: `"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace`,
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
  },
  semanticTokens: {
    colors: {
      // Mono: near-black / paper, hairline borders.
      "surface.bg": { default: "#fbfbfa", _dark: "#0c0c0d" },
      "surface.panel": { default: "#ffffff", _dark: "#111112" },
      "surface.raised": { default: "#ffffff", _dark: "#161617" },
      "surface.hover": { default: "#f0f0ee", _dark: "#1d1d1f" },
      "surface.border": { default: "#e7e7e3", _dark: "#242427" },
      "surface.borderStrong": { default: "#d6d6d0", _dark: "#34343a" },
      "ink.base": { default: "#141414", _dark: "#ededed" },
      "ink.muted": { default: "#55555a", _dark: "#9a9a9f" },
      "ink.subtle": { default: "#8a8a86", _dark: "#5f5f66" },
      "accent.tint": {
        default: "rgba(91,75,214,0.09)",
        _dark: "rgba(139,123,255,0.14)",
      },
    },
  },
  shadows: {
    xs: "0 1px 2px rgba(0,0,0,0.06)",
    sm: "0 1px 3px rgba(0,0,0,0.09), 0 1px 2px rgba(0,0,0,0.05)",
    outline: "0 0 0 3px rgba(107, 91, 255, 0.35)",
    card: "0 1px 2px rgba(0,0,0,0.06), 0 8px 24px -16px rgba(0,0,0,0.35)",
    pop: "0 12px 40px -12px rgba(0,0,0,0.45), 0 2px 8px -4px rgba(0,0,0,0.22)",
  },
  radii: {
    md: "7px",
    lg: "10px",
    xl: "14px",
    "2xl": "18px",
  },
  styles: {
    global: {
      "html, body, #root": { height: "100%" },
      body: {
        bg: "surface.bg",
        color: "ink.base",
        WebkitFontSmoothing: "antialiased",
      },
      "::selection": { background: "rgba(109,94,252,0.35)" },
      "*::-webkit-scrollbar": { width: "10px", height: "10px" },
      "*::-webkit-scrollbar-thumb": {
        background: "var(--chakra-colors-surface-borderStrong)",
        borderRadius: "8px",
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
        transition: "background 0.12s ease, transform 0.06s ease",
        _focusVisible: { boxShadow: "outline" },
        _active: { transform: "translateY(0.5px)" },
      },
      variants: {
        // Quiet secondary action that reads clearly on panels.
        subtle: {
          bg: "surface.hover",
          color: "ink.base",
          _hover: { bg: "surface.borderStrong" },
        },
      },
    },
    Input: {
      defaultProps: { focusBorderColor: "brand.500" },
      variants: {
        outline: {
          field: {
            bg: "surface.raised",
            borderColor: "surface.border",
            borderRadius: "lg",
            _hover: { borderColor: "surface.borderStrong" },
            _placeholder: { color: "ink.subtle" },
          },
        },
      },
    },
    Textarea: {
      defaultProps: { focusBorderColor: "brand.500" },
      variants: {
        outline: {
          bg: "surface.raised",
          borderColor: "surface.border",
          borderRadius: "lg",
          _hover: { borderColor: "surface.borderStrong" },
          _placeholder: { color: "ink.subtle" },
        },
      },
    },
    Select: {
      defaultProps: { focusBorderColor: "brand.500" },
      variants: {
        outline: {
          field: {
            bg: "surface.raised",
            borderColor: "surface.border",
            borderRadius: "lg",
            _hover: { borderColor: "surface.borderStrong" },
          },
        },
      },
    },
    Tooltip: {
      baseStyle: {
        bg: "surface.raised",
        color: "ink.base",
        border: "1px solid",
        borderColor: "surface.border",
        borderRadius: "md",
        fontSize: "xs",
        px: 2.5,
        py: 1.5,
        boxShadow: "pop",
      },
    },
    // Every dropdown menu (context menus, language picker, account menu…).
    Menu: {
      baseStyle: {
        list: {
          bg: "surface.raised",
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
          _hover: { bg: "surface.hover" },
          _focus: { bg: "surface.hover" },
        },
        divider: { borderColor: "surface.border", my: 1 },
        groupTitle: {
          fontSize: "11px",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "ink.subtle",
          mx: 3,
        },
      },
    },
    // AlertDialog shares this component key, so confirm/prompt dialogs get it too.
    Modal: {
      baseStyle: {
        overlay: { bg: "blackAlpha.600", backdropFilter: "blur(5px)" },
        dialog: {
          bg: "surface.panel",
          borderRadius: "xl",
          border: "1px solid",
          borderColor: "surface.border",
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
          bg: "surface.raised",
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
        overlay: { bg: "blackAlpha.600", backdropFilter: "blur(5px)" },
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
        },
      },
    },
    Tabs: { defaultProps: { colorScheme: "brand" } },
    Badge: {
      baseStyle: { borderRadius: "full", textTransform: "none", fontWeight: 600 },
    },
  },
});

export default theme;
