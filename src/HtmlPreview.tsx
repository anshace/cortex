import { Box } from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";

import * as api from "./api";
import { FileRow } from "./api";

// Resolve a relative href against the previewed file's directory, normalizing
// ./ and ../ and stripping a leading slash (workspace-root-relative). Returns
// null for external/inline refs (http:, data:, #…) which we leave untouched.
function resolvePath(dir: string, href: string): string | null {
  let p = href.trim();
  if (/^(https?:|data:|blob:|#|mailto:|\/\/)/i.test(p)) return null;
  p = p.split(/[?#]/, 1)[0];
  if (p.startsWith("/")) p = p.slice(1);
  else p = dir ? `${dir}/${p}` : p;
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

// Inline linked stylesheets from the workspace so the sandboxed srcDoc frame
// renders accurately without granting uploaded documents script execution.
function inlineAssets(
  html: string,
  dir: string,
  assets: Record<string, string>,
): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  for (const link of Array.from(doc.querySelectorAll("link[rel][href]"))) {
    const rel = (link.getAttribute("rel") || "").toLowerCase();
    const isStylesheet = rel.split(/\s+/).includes("stylesheet");
    if (!isStylesheet) continue;

    const href = link.getAttribute("href");
    if (!href) continue;
    const p = resolvePath(dir, href);
    if (p != null && assets[p] != null) {
      const style = doc.createElement("style");
      style.textContent = `\n${assets[p]}\n`;
      link.replaceWith(style);
    }
  }

  for (const script of Array.from(doc.querySelectorAll("script")))
    script.remove();

  return doc.documentElement.outerHTML;
}

// Renders uploaded HTML as a static document in a fully sandboxed iframe.
function HtmlPreview({ text, file }: { text: string; file?: FileRow }) {
  const [assets, setAssets] = useState<Record<string, string>>({});

  // Load sibling text files (CSS/JS/…) once per file so relative <link>/<script>
  // references can be inlined — an iframe srcDoc has no URL to fetch them itself.
  useEffect(() => {
    if (!file) {
      setAssets({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const ws = await api.getWorkspace(file.workspace_id);
        const siblings = ws.files.filter(
          (f) => f.kind === "text" && f.id !== file.id,
        );
        const entries = await Promise.all(
          siblings.map(async (f) => {
            try {
              const res = await fetch(api.rawUrl(f), {
                credentials: "include",
              });
              return [f.path, res.ok ? await res.text() : ""] as const;
            } catch {
              return [f.path, ""] as const;
            }
          }),
        );
        if (!cancelled) setAssets(Object.fromEntries(entries));
      } catch {
        if (!cancelled) setAssets({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file?.id, file?.workspace_id]);

  const dir =
    file && file.path.includes("/")
      ? file.path.slice(0, file.path.lastIndexOf("/"))
      : "";
  const doc = useMemo(
    () => (file ? inlineAssets(text, dir, assets) : text),
    [text, dir, assets, file],
  );

  return (
    <Box flex={1} minH={0} bg="white">
      <iframe
        title="HTML preview"
        srcDoc={doc}
        sandbox=""
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          background: "white",
        }}
      />
    </Box>
  );
}

export default HtmlPreview;
