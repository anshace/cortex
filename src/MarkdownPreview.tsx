import {
  Box,
  Center,
  Flex,
  Icon,
  IconButton,
  Spinner,
  Text,
  Tooltip,
  useColorMode,
} from "@chakra-ui/react";
import {
  type ReactNode,
  useDeferredValue,
  useEffect,
  useId,
  useState,
} from "react";
import { VscCheck, VscCopy } from "react-icons/vsc";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import * as api from "./api";

type Heading = { level: number; text: string; id: string; line: number };

function slug(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function headingsFromMarkdown(markdown: string): Heading[] {
  const headings: Heading[] = [];
  const counts = new Map<string, number>();
  const lines = markdown.split("\n");
  let fence: { marker: "`" | "~"; length: number } | null = null;
  const add = (level: number, source: string, line: number) => {
    const text = source
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_`~\[\]]/g, "")
      .trim();
    const base = slug(text) || "section";
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    headings.push({
      level,
      text,
      id: count ? `${base}-${count + 1}` : base,
      line,
    });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length)
        fence = null;
      continue;
    }
    if (fence) continue;
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*?)\s*#*\s*$/.exec(line);
    if (atx) {
      add(atx[1].length, atx[2], index + 1);
      continue;
    }
    if (line.trim() && index + 1 < lines.length) {
      const setext = /^\s*(=+|-+)\s*$/.exec(lines[index + 1]);
      if (setext) add(setext[1][0] === "=" ? 1 : 2, line, index + 1);
    }
  }
  return headings;
}

function childText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number")
    return String(children);
  if (Array.isArray(children)) return children.map(childText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return childText(
      (children as { props: { children?: ReactNode } }).props.children,
    );
  }
  return "";
}

function Mermaid({ code, dark }: { code: string; dark: boolean }) {
  const reactId = useId();
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setSvg("");
    setError("");
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          theme: dark ? "dark" : "default",
          securityLevel: "strict",
        });
        return mermaid.render(`mmd-${reactId.replace(/:/g, "")}`, code);
      })
      .then(({ svg: rendered }) => {
        if (active) setSvg(rendered);
      })
      .catch((reason) => {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [code, dark, reactId]);

  if (error) {
    return (
      <Box
        role="alert"
        color="red.400"
        fontSize="sm"
        fontFamily="mono"
        whiteSpace="pre-wrap"
        my={4}
      >
        Mermaid diagram: {error}
      </Box>
    );
  }
  if (!svg) {
    return (
      <Center role="status" gap={2} minH="120px" my={4} color="ink.muted">
        <Spinner size="sm" />
        <Text fontSize="sm">Rendering diagram...</Text>
      </Center>
    );
  }
  return (
    <Box
      as="figure"
      aria-label="Mermaid diagram"
      my={5}
      p={4}
      overflowX="auto"
      border="1px solid"
      borderColor="surface.border"
      borderRadius="lg"
      bg="surface.panel"
      sx={{ "& svg": { maxW: "100%", height: "auto", mx: "auto" } }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Box
      my={4}
      border="1px solid"
      borderColor="surface.border"
      borderRadius="lg"
      overflow="hidden"
      bg="surface.raised"
    >
      <Flex
        align="center"
        h="34px"
        px={3}
        borderBottom="1px solid"
        borderColor="surface.border"
        bg="surface.panel"
      >
        <Text
          flex={1}
          fontSize="11px"
          color="ink.subtle"
          fontFamily="mono"
          textTransform="lowercase"
        >
          {language || "text"}
        </Text>
        <Tooltip label={copied ? "Copied" : "Copy code"}>
          <IconButton
            aria-label={copied ? "Code copied" : "Copy code"}
            icon={<Icon as={copied ? VscCheck : VscCopy} />}
            size="xs"
            variant="ghost"
            onClick={() => {
              void navigator.clipboard.writeText(code).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              });
            }}
          />
        </Tooltip>
      </Flex>
      <Box
        as="pre"
        m={0}
        p={4}
        overflowX="auto"
        fontSize="13px"
        lineHeight={1.65}
      >
        <code className={language ? `language-${language}` : undefined}>
          {code}
        </code>
      </Box>
    </Box>
  );
}

const previewSx = {
  "& h1": {
    fontSize: "2rem",
    fontWeight: 750,
    mt: 8,
    mb: 3,
    letterSpacing: "-0.025em",
    lineHeight: 1.2,
  },
  "& h2": {
    fontSize: "1.5rem",
    fontWeight: 700,
    mt: 8,
    mb: 3,
    pb: 2,
    borderBottom: "1px solid",
    borderColor: "surface.border",
    letterSpacing: "-0.015em",
  },
  "& h3": { fontSize: "1.2rem", fontWeight: 700, mt: 6, mb: 2 },
  "& h4, & h5, & h6": { fontWeight: 700, mt: 5, mb: 2 },
  "& p": { lineHeight: 1.75, my: 3 },
  "& a": {
    color: "brand.400",
    textDecoration: "underline",
    textUnderlineOffset: "3px",
  },
  "& ul, & ol": { pl: 6, my: 3 },
  "& li": { mb: 1.5, lineHeight: 1.65 },
  "& li > input[type=checkbox]": {
    mr: 2,
    accentColor: "var(--chakra-colors-brand-500)",
  },
  "& :not(pre) > code": {
    fontFamily: "mono",
    fontSize: "0.85em",
    bg: "surface.hover",
    px: 1.5,
    py: 0.5,
    borderRadius: "sm",
  },
  "& blockquote": {
    borderLeft: "1px solid",
    borderColor: "brand.400",
    bg: "surface.panel",
    px: 4,
    py: 2,
    my: 5,
    color: "ink.muted",
  },
  "& th, & td": {
    border: "1px solid",
    borderColor: "surface.border",
    px: 3,
    py: 2,
  },
  "& th": { bg: "surface.hover", fontWeight: 700 },
  "& img": { maxW: "100%", borderRadius: "lg", my: 4 },
  "& hr": { borderColor: "surface.border", my: 8 },
};

function MarkdownPreview({ text, file }: { text: string; file?: api.FileRow }) {
  const { colorMode } = useColorMode();
  const deferredText = useDeferredValue(text);
  const headings = headingsFromMarkdown(deferredText);
  const [workspaceFiles, setWorkspaceFiles] = useState<api.FileRow[]>([]);

  useEffect(() => {
    let active = true;
    if (!file) {
      setWorkspaceFiles([]);
      return;
    }
    void api.getWorkspace(file.workspace_id).then(
      (workspace) => active && setWorkspaceFiles(workspace.files),
      () => active && setWorkspaceFiles([]),
    );
    return () => {
      active = false;
    };
  }, [file?.id, file?.workspace_id]);

  const resolveUrl = (value?: string) => {
    if (!value || /^(https?:|mailto:|data:|blob:|#|\/\/)/i.test(value) || !file)
      return value;
    const dir = file.path.includes("/")
      ? file.path.slice(0, file.path.lastIndexOf("/"))
      : "";
    const suffixIndex = value.search(/[?#]/);
    const encodedPath = suffixIndex >= 0 ? value.slice(0, suffixIndex) : value;
    let path = encodedPath;
    try {
      path = decodeURIComponent(encodedPath);
    } catch {
      // Leave malformed percent escapes unresolved.
    }
    const suffix = suffixIndex >= 0 ? value.slice(suffixIndex) : "";
    const segments =
      `${path.startsWith("/") ? "" : `${dir}/`}${path.replace(/^\//, "")}`.split(
        "/",
      );
    const normalized: string[] = [];
    for (const segment of segments) {
      if (!segment || segment === ".") continue;
      if (segment === "..") normalized.pop();
      else normalized.push(segment);
    }
    const target = workspaceFiles.find(
      (candidate) => candidate.path === normalized.join("/"),
    );
    return target ? `${api.rawUrl(target)}${suffix}` : value;
  };

  const heading = (level: 1 | 2 | 3 | 4 | 5 | 6) => {
    return ({
      node,
      children,
    }: {
      node?: { position?: { start?: { line?: number } } };
      children?: ReactNode;
    }) => {
      const line = node?.position?.start?.line ?? 0;
      const id =
        headings.find((item) => item.line === line)?.id ??
        (slug(childText(children)) || "section");
      return (
        <Box as={`h${level}`} id={id}>
          {children}
        </Box>
      );
    };
  };

  return (
    <Box
      flex={1}
      minH={0}
      overflowY="auto"
      bg="surface.bg"
      color="ink.base"
      px={{ base: 3, md: 5 }}
      py={{ base: 4, md: 5 }}
    >
      <Flex w="100%" align="flex-start" gap={{ base: 0, xl: 8 }}>
        <Box as="article" minW={0} flex={1} sx={previewSx} fontSize="15px">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: heading(1),
              h2: heading(2),
              h3: heading(3),
              h4: heading(4),
              h5: heading(5),
              h6: heading(6),
              pre({ children }) {
                return <>{children}</>;
              },
              code({ node, className, children, ...props }) {
                void node;
                const language =
                  /language-([\w-]+)/.exec(className || "")?.[1] ?? "";
                const code = String(children).replace(/\n$/, "");
                if (language === "mermaid")
                  return <Mermaid code={code} dark={colorMode === "dark"} />;
                if (language || code.includes("\n"))
                  return <CodeBlock language={language} code={code} />;
                return (
                  <code className={className} {...props}>
                    {children}
                  </code>
                );
              },
              table({ children }) {
                return (
                  <Box overflowX="auto" my={5}>
                    <Box
                      as="table"
                      w="max-content"
                      minW="100%"
                      sx={{ borderCollapse: "collapse" }}
                    >
                      {children}
                    </Box>
                  </Box>
                );
              },
              a({ href, children, ...props }) {
                const resolved = resolveUrl(href);
                const external =
                  !!resolved && /^(https?:)?\/\//i.test(resolved);
                return (
                  <a
                    href={resolved}
                    target={external ? "_blank" : undefined}
                    rel={external ? "noreferrer" : undefined}
                    {...props}
                  >
                    {children}
                  </a>
                );
              },
              img({ src, alt, ...props }) {
                return (
                  <img
                    src={resolveUrl(src)}
                    alt={alt || ""}
                    loading="lazy"
                    {...props}
                  />
                );
              },
            }}
          >
            {deferredText || "*Nothing to preview yet.*"}
          </ReactMarkdown>
        </Box>
        {headings.length >= 2 && (
          <Box
            as="nav"
            aria-label="On this page"
            display={{ base: "none", xl: "block" }}
            position="sticky"
            top={4}
            w="190px"
            maxH="calc(100vh - 160px)"
            overflowY="auto"
            flexShrink={0}
          >
            <Text
              fontSize="11px"
              fontWeight={700}
              color="ink.subtle"
              mb={2}
              textTransform="uppercase"
              letterSpacing="0.06em"
            >
              On this page
            </Text>
            {headings.map((item) => (
              <Box
                as="a"
                key={item.id}
                href={`#${item.id}`}
                display="block"
                py={1}
                pl={(item.level - 1) * 3}
                fontSize="12px"
                lineHeight={1.45}
                color="ink.muted"
                _hover={{ color: "ink.base" }}
              >
                {item.text}
              </Box>
            ))}
          </Box>
        )}
      </Flex>
    </Box>
  );
}

export default MarkdownPreview;
