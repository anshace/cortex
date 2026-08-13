import { Box, useColorMode } from "@chakra-ui/react";
import mermaid from "mermaid";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Renders one ```mermaid fenced block as an SVG diagram.
function Mermaid({ code, dark }: { code: string; dark: boolean }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default", securityLevel: "strict" });
    const id = "mmd-" + Math.abs(hash(code)).toString(36);
    mermaid
      .render(id, code)
      .then((res) => {
        if (alive) {
          setSvg(res.svg);
          setError("");
        }
      })
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [code, dark]);

  if (error) {
    return (
      <Box color="red.400" fontSize="sm" fontFamily="mono" whiteSpace="pre-wrap" my={3}>
        {error}
      </Box>
    );
  }
  return (
    <Box
      my={4}
      overflowX="auto"
      display="flex"
      justifyContent="center"
      sx={{ "& svg": { maxW: "100%", height: "auto" } }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

const previewSx = {
  maxW: "820px",
  mx: "auto",
  "& h1": { fontSize: "1.9em", fontWeight: 700, mt: 6, mb: 3, pb: 2, borderBottom: "1px solid", borderColor: "surface.border", lineHeight: 1.25 },
  "& h2": { fontSize: "1.5em", fontWeight: 700, mt: 6, mb: 3, pb: 1, borderBottom: "1px solid", borderColor: "surface.border" },
  "& h3": { fontSize: "1.25em", fontWeight: 700, mt: 5, mb: 2 },
  "& h4, & h5, & h6": { fontWeight: 700, mt: 4, mb: 2 },
  "& p": { lineHeight: 1.7, my: 3 },
  "& a": { color: "brand.400", textDecoration: "underline" },
  "& ul, & ol": { pl: 6, my: 3 },
  "& li": { mb: 1.5, lineHeight: 1.6 },
  "& code": { fontFamily: "mono", fontSize: "0.85em", bg: "surface.hover", px: 1.5, py: 0.5, borderRadius: "sm" },
  "& pre": { bg: "surface.raised", border: "1px solid", borderColor: "surface.border", p: 4, borderRadius: "md", overflowX: "auto", my: 4 },
  "& pre code": { bg: "transparent", p: 0, fontSize: "0.85em" },
  "& blockquote": { bg: "surface.panel", borderRadius: "md", px: 4, py: 2, my: 4, color: "ink.muted" },
  "& table": { borderCollapse: "collapse", my: 4, fontSize: "0.95em", display: "block", overflowX: "auto" },
  "& th, & td": { border: "1px solid", borderColor: "surface.border", px: 3, py: 2 },
  "& th": { bg: "surface.hover", fontWeight: 700 },
  "& img": { maxW: "100%", borderRadius: "md", my: 2 },
  "& hr": { borderColor: "surface.border", my: 6 },
};

function MarkdownPreview({ text }: { text: string }) {
  const { colorMode } = useColorMode();
  const dark = colorMode === "dark";

  return (
    <Box flex={1} minH={0} overflowY="auto" bg="surface.bg" color="ink.base" px={{ base: 5, md: 8 }} py={8}>
      <Box sx={previewSx} fontSize="15px">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ node, className, children, ...props }) {
              void node;
              const match = /language-(\w+)/.exec(className || "");
              if (match && match[1] === "mermaid") {
                return <Mermaid code={String(children).replace(/\n$/, "")} dark={dark} />;
              }
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            },
          }}
        >
          {text || "*Nothing to preview yet.*"}
        </ReactMarkdown>
      </Box>
    </Box>
  );
}

export default MarkdownPreview;
