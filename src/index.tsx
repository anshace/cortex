import { ChakraProvider, ColorModeScript } from "@chakra-ui/react";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "rustpad-wasm";

import AuthGate from "./AuthGate";
import theme from "./theme";
import "./index.css";

// Serve Monaco from our own bundle, not the jsdelivr CDN that @monaco-editor/react
// loads by default — the CDN is blocked by our CSP and would break offline / on a
// locked-down box. Workers are bundled locally too (Vite ?worker → blob:, allowed
// by worker-src 'self' blob:).
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};
loader.config({ monaco });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ColorModeScript initialColorMode={theme.config.initialColorMode} />
    <ChakraProvider theme={theme}>
      <AuthGate />
    </ChakraProvider>
  </StrictMode>,
);
