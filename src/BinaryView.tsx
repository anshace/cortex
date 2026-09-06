import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Center,
  Flex,
  HStack,
  Icon,
  IconButton,
  Spinner,
  Text,
  Tooltip,
  useToast,
} from "@chakra-ui/react";
import { useEffect, useState } from "react";
import {
  VscDesktopDownload,
  VscFileBinary,
  VscZoomIn,
  VscZoomOut,
} from "react-icons/vsc";

import SpreadsheetView, { isSpreadsheet } from "./Spreadsheet";
import * as api from "./api";
import { type FileRow, rawUrl } from "./api";

function extension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function isDocx(mime: string, name: string) {
  return (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    extension(name) === "docx"
  );
}

function isLegacyDoc(mime: string, name: string) {
  return mime === "application/msword" || extension(name) === "doc";
}

function isPdf(mime: string, name: string) {
  return mime === "application/pdf" || extension(name) === "pdf";
}

function isImage(mime: string, name: string) {
  return (
    mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name)
  );
}

const ALLOWED_DOC_TAGS = new Set([
  "A",
  "B",
  "BLOCKQUOTE",
  "BR",
  "CODE",
  "EM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "I",
  "IMG",
  "LI",
  "OL",
  "P",
  "PRE",
  "S",
  "STRONG",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "U",
  "UL",
]);

function safeLink(value: string) {
  return /^(https?:|mailto:|#)/i.test(value.trim());
}

function sanitizeDocumentHtml(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  for (const element of Array.from(document.body.querySelectorAll("*"))) {
    if (!ALLOWED_DOC_TAGS.has(element.tagName)) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (
        !["href", "src", "alt", "title", "colspan", "rowspan"].includes(name)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element instanceof HTMLAnchorElement) {
      if (!safeLink(element.href)) element.removeAttribute("href");
      else {
        element.target = "_blank";
        element.rel = "noreferrer";
      }
    }
    if (
      element instanceof HTMLImageElement &&
      !/^data:image\/(png|jpeg|gif|webp);/i.test(element.src)
    ) {
      element.removeAttribute("src");
    }
  }
  return document.body.innerHTML;
}

function WordPreview({ file }: { file: FileRow }) {
  const [html, setHtml] = useState("");
  const [warnings, setWarnings] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch(rawUrl(file), { credentials: "include" }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      }),
      import("mammoth"),
    ])
      .then(([buffer, mammoth]) =>
        mammoth.default.convertToHtml({ arrayBuffer: buffer }),
      )
      .then((result) => {
        if (!cancelled) {
          setHtml(sanitizeDocumentHtml(result.value));
          setWarnings(result.messages.length);
        }
      })
      .catch((reason) => {
        if (!cancelled)
          setError(
            reason instanceof Error
              ? reason.message
              : "Failed to load document",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file.id]);

  if (loading)
    return (
      <Center flex={1} gap={2} role="status" color="ink.muted">
        <Spinner size="sm" />
        <Text fontSize="sm">Converting document...</Text>
      </Center>
    );
  if (error)
    return (
      <Center flex={1} p={6}>
        <Alert status="error" maxW="560px" borderRadius="lg" role="alert">
          <AlertIcon />
          {error}
        </Alert>
      </Center>
    );
  return (
    <Box flex={1} minH={0} overflow="auto" p={{ base: 2, md: 4 }}>
      <Flex
        justify="flex-end"
        mb={2}
        position="sticky"
        top={2}
        zIndex={2}
        pointerEvents="none"
      >
        <HStack
          spacing={1}
          px={1}
          py={0.5}
          bg="surface.raised"
          border="1px solid"
          borderColor="surface.border"
          borderRadius="md"
          boxShadow="xs"
          pointerEvents="auto"
        >
          {warnings > 0 && (
            <Text fontSize="10px" color="orange.400" px={1}>
              {warnings} warning{warnings === 1 ? "" : "s"}
            </Text>
          )}
          <Tooltip label="Zoom out">
            <IconButton
              aria-label="Zoom document out"
              icon={<Icon as={VscZoomOut} />}
              size="xs"
              variant="ghost"
              onClick={() => setZoom((value) => Math.max(0.6, value - 0.1))}
            />
          </Tooltip>
          <Text fontSize="11px" w="42px" textAlign="center">
            {Math.round(zoom * 100)}%
          </Text>
          <Tooltip label="Zoom in">
            <IconButton
              aria-label="Zoom document in"
              icon={<Icon as={VscZoomIn} />}
              size="xs"
              variant="ghost"
              onClick={() => setZoom((value) => Math.min(1.8, value + 0.1))}
            />
          </Tooltip>
        </HStack>
      </Flex>
      <Box
        bg="surface.panel"
        border="1px solid"
        borderColor="surface.border"
        borderRadius="lg"
        p={{ base: 4, md: 6 }}
        w="100%"
        sx={{
          zoom,
          "& h1": { fontSize: "2xl", fontWeight: 700, mt: 5, mb: 3 },
          "& h2": { fontSize: "xl", fontWeight: 700, mt: 5, mb: 2 },
          "& h3": { fontSize: "lg", fontWeight: 700, mt: 4, mb: 2 },
          "& p": { mb: 3, lineHeight: 1.75 },
          "& ul, & ol": { pl: 6, mb: 3 },
          "& table": {
            borderCollapse: "collapse",
            my: 4,
            w: "100%",
            display: "block",
            overflowX: "auto",
          },
          "& th, & td": {
            border: "1px solid",
            borderColor: "surface.border",
            px: 3,
            py: 2,
            textAlign: "left",
          },
          "& th": { bg: "surface.hover", fontWeight: 700 },
          "& img": { maxW: "100%", h: "auto" },
          "& a": {
            color: "brand.400",
            textDecoration: "underline",
            textUnderlineOffset: "3px",
          },
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </Box>
  );
}

function PdfPreview({ file }: { file: FileRow }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    let objectUrl = "";
    let cancelled = false;
    void fetch(rawUrl(file), { credentials: "include" })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((buffer) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(
          new Blob([buffer], { type: "application/pdf" }),
        );
        setUrl(objectUrl);
      })
      .catch((reason) => {
        if (!cancelled)
          setError(
            reason instanceof Error ? reason.message : "Failed to load PDF",
          );
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id]);

  if (!url)
    return error ? (
      <Center flex={1} p={6}>
        <Alert status="error" maxW="560px" borderRadius="lg" role="alert">
          <AlertIcon />
          {error}
        </Alert>
      </Center>
    ) : (
      <Center flex={1} gap={2} role="status" color="ink.muted">
        <Spinner size="sm" />
        <Text fontSize="sm">Loading PDF...</Text>
      </Center>
    );
  return (
    <Box flex={1} minH={0} bg="surface.hover">
      <object
        data={`${url}#toolbar=1&navpanes=1&view=FitH`}
        type="application/pdf"
        width="100%"
        height="100%"
        aria-label={`PDF preview of ${file.path}`}
      >
        <Center h="100%" p={6}>
          <Text fontSize="sm" color="ink.muted">
            This browser cannot display PDFs inline. Use Download to open the
            file.
          </Text>
        </Center>
      </object>
    </Box>
  );
}

function BinaryView({
  file,
  canManage,
}: {
  file: FileRow;
  canManage: boolean;
}) {
  const toast = useToast();
  const mime = (file.mime ?? "").split(";")[0].toLowerCase();
  const name = file.path.split("/").pop() ?? file.path;
  const isSheet = isSpreadsheet(mime, name);
  let body;

  if (isSheet) {
    body = <SpreadsheetView file={file} />;
  } else if (isImage(mime, name)) {
    body = (
      <Center flex={1} minH={0} p={6} overflow="auto">
        <img
          src={rawUrl(file)}
          alt={name}
          loading="lazy"
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            objectFit: "contain",
            borderRadius: 8,
          }}
        />
      </Center>
    );
  } else if (isPdf(mime, name)) body = <PdfPreview file={file} />;
  else if (isDocx(mime, name)) body = <WordPreview file={file} />;
  else {
    body = (
      <Center
        flex={1}
        minH={0}
        flexDirection="column"
        gap={3}
        p={6}
        color="ink.muted"
      >
        <Icon as={VscFileBinary} fontSize="5xl" color="ink.subtle" />
        <Text color="ink.base" fontWeight="medium">
          {name}
        </Text>
        <Text fontSize="sm">{mime || "binary file"}</Text>
        <Text fontSize="xs" color="ink.subtle" textAlign="center" maxW="sm">
          {isLegacyDoc(mime, name)
            ? "Legacy .doc files cannot be safely rendered in the browser. Convert this file to DOCX or download it."
            : "Preview is not available for this file type. Download it to open in the matching app."}
        </Text>
      </Center>
    );
  }

  return (
    <Flex
      flex={1}
      minW={0}
      direction="column"
      bg="surface.bg"
      overflow="hidden"
    >
      <Flex
        align="center"
        gap={3}
        px={4}
        minH="40px"
        borderBottom="1px solid"
        borderColor="surface.border"
        bg="surface.panel"
        flexShrink={0}
      >
        <Text fontSize="sm" color="ink.base" isTruncated flex={1}>
          {name}
        </Text>
        {canManage && !isSheet && (
          <Button
            size="xs"
            variant="ghost"
            leftIcon={<Icon as={VscDesktopDownload} />}
            onClick={() =>
              api.downloadFile(file).catch(() =>
                toast({
                  title: "Download failed",
                  status: "error",
                  duration: 3000,
                }),
              )
            }
          >
            Download
          </Button>
        )}
      </Flex>
      {body}
    </Flex>
  );
}

export default BinaryView;
