// Editor colour themes. The Monaco editor theme is chosen independently of the
// app chrome (light/dark), VS Code-style: pick "Cortex" to follow the app, or a
// named theme that stays fixed. The choice is persisted in localStorage.
import type { Monaco } from "@monaco-editor/react";
import type * as monaco from "monaco-editor";
import useLocalStorageState from "use-local-storage-state";

export const EDITOR_THEMES = [
  { id: "auto", label: "Cortex", hint: "Follows the app light/dark" },
  { id: "one-dark", label: "One Dark", hint: "Atom's classic dark" },
  { id: "monokai", label: "Monokai", hint: "Warm, high-contrast dark" },
  { id: "github-dark", label: "GitHub Dark", hint: "GitHub's dark palette" },
  { id: "github-light", label: "GitHub Light", hint: "GitHub's light palette" },
] as const;

// Tiny preview swatches for the theme picker (bg + three token colours).
export const SWATCHES: Record<string, { bg: string; a: string; b: string; c: string }> = {
  auto: { bg: "#15171c", a: "#8b7bff", b: "#a1a6b0", c: "#6b5bff" },
  "one-dark": { bg: "#282c34", a: "#c678dd", b: "#98c379", c: "#61afef" },
  monokai: { bg: "#272822", a: "#f92672", b: "#e6db74", c: "#a6e22e" },
  "github-dark": { bg: "#0d1117", a: "#ff7b72", b: "#a5d6ff", c: "#d2a8ff" },
  "github-light": { bg: "#ffffff", a: "#cf222e", b: "#0a3069", c: "#8250df" },
};

type Palette = {
  base: "vs" | "vs-dark";
  bg: string;
  fg: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  type: string;
  func: string;
  variable: string;
  lineHighlight: string;
  lineNumber: string;
  lineNumberActive: string;
  indent: string;
};

const PALETTES: Record<string, Palette> = {
  "one-dark": {
    base: "vs-dark",
    bg: "#282c34", fg: "#abb2bf",
    comment: "#5c6370", keyword: "#c678dd", string: "#98c379", number: "#d19a66",
    type: "#e5c07b", func: "#61afef", variable: "#e06c75",
    lineHighlight: "#2c313a", lineNumber: "#4b5263", lineNumberActive: "#abb2bf", indent: "#3b4048",
  },
  monokai: {
    base: "vs-dark",
    bg: "#272822", fg: "#f8f8f2",
    comment: "#75715e", keyword: "#f92672", string: "#e6db74", number: "#ae81ff",
    type: "#66d9ef", func: "#a6e22e", variable: "#f8f8f2",
    lineHighlight: "#3e3d32", lineNumber: "#75715e", lineNumberActive: "#f8f8f2", indent: "#3b3a32",
  },
  "github-dark": {
    base: "vs-dark",
    bg: "#0d1117", fg: "#c9d1d9",
    comment: "#8b949e", keyword: "#ff7b72", string: "#a5d6ff", number: "#79c0ff",
    type: "#ffa657", func: "#d2a8ff", variable: "#c9d1d9",
    lineHighlight: "#161b22", lineNumber: "#484f58", lineNumberActive: "#c9d1d9", indent: "#21262d",
  },
  "github-light": {
    base: "vs",
    bg: "#ffffff", fg: "#24292f",
    comment: "#6e7781", keyword: "#cf222e", string: "#0a3069", number: "#0550ae",
    type: "#953800", func: "#8250df", variable: "#24292f",
    lineHighlight: "#f6f8fa", lineNumber: "#8c959f", lineNumberActive: "#24292f", indent: "#eaeef2",
  },
};

const noHash = (c: string) => c.replace(/^#/, "");

function themeData(p: Palette): monaco.editor.IStandaloneThemeData {
  return {
    base: p.base,
    inherit: true,
    rules: [
      { token: "comment", foreground: noHash(p.comment), fontStyle: "italic" },
      { token: "keyword", foreground: noHash(p.keyword) },
      { token: "keyword.flow", foreground: noHash(p.keyword) },
      { token: "string", foreground: noHash(p.string) },
      { token: "number", foreground: noHash(p.number) },
      { token: "regexp", foreground: noHash(p.string) },
      { token: "type", foreground: noHash(p.type) },
      { token: "type.identifier", foreground: noHash(p.type) },
      { token: "identifier", foreground: noHash(p.variable) },
      { token: "delimiter", foreground: noHash(p.fg) },
      { token: "operator", foreground: noHash(p.keyword) },
      { token: "tag", foreground: noHash(p.keyword) },
      { token: "attribute.name", foreground: noHash(p.func) },
      { token: "attribute.value", foreground: noHash(p.string) },
    ],
    colors: {
      "editor.background": p.bg,
      "editor.foreground": p.fg,
      "editorGutter.background": p.bg,
      "editor.lineHighlightBackground": p.lineHighlight,
      "editorLineNumber.foreground": p.lineNumber,
      "editorLineNumber.activeForeground": p.lineNumberActive,
      "editorIndentGuide.background1": p.indent,
    },
  };
}

// Register every theme once, before the first editor mounts.
export function registerThemes(m: Monaco) {
  m.editor.defineTheme("cortex-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#15171c",
      "editorGutter.background": "#15171c",
      "editor.lineHighlightBackground": "#1b1e25",
      "editorLineNumber.foreground": "#4b5160",
      "editorLineNumber.activeForeground": "#a1a6b0",
      "editorIndentGuide.background1": "#23262e",
    },
  });
  m.editor.defineTheme("cortex-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#ffffff",
      "editorGutter.background": "#ffffff",
      "editor.lineHighlightBackground": "#f4f5f7",
      "editorLineNumber.foreground": "#b3b8c2",
      "editorLineNumber.activeForeground": "#565c67",
      "editorIndentGuide.background1": "#e3e5ea",
    },
  });
  for (const [id, p] of Object.entries(PALETTES)) m.editor.defineTheme(id, themeData(p));
}

// "auto" tracks the app chrome; named themes are fixed.
export function resolveMonacoTheme(themeId: string, dark: boolean): string {
  if (themeId === "auto") return dark ? "cortex-dark" : "cortex-light";
  return themeId;
}

export function useEditorThemeId() {
  return useLocalStorageState<string>("cortex-editor-theme", { defaultValue: "auto" });
}
