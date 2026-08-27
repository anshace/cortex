import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Center,
  Checkbox,
  Flex,
  HStack,
  Icon,
  IconButton,
  Input,
  Spinner,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Table,
  TableContainer,
  Tabs,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tooltip,
  Tr,
  useToast,
} from "@chakra-ui/react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  VscChevronLeft,
  VscChevronRight,
  VscDesktopDownload,
  VscFileBinary,
  VscZoomIn,
  VscZoomOut,
} from "react-icons/vsc";

import * as api from "./api";
import { type FileRow, rawUrl } from "./api";

type SheetRow = (string | number | boolean | null)[];
type SheetData = {
  name: string;
  data: SheetRow[];
  totalRows: number;
  totalColumns: number;
  startRow: number;
  startColumn: number;
  truncated: boolean;
};

function extension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function isExcel(mime: string, name: string) {
  return (
    [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/csv",
    ].includes(mime) || ["xlsx", "xls", "csv"].includes(extension(name))
  );
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

function columnName(index: number) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  }
  return name;
}

const PAGE_ROWS = 100;

function SheetTable({ sheet }: { sheet: SheetData }) {
  const [query, setQuery] = useState("");
  const [firstRowHeader, setFirstRowHeader] = useState(true);
  const [page, setPage] = useState(0);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const header = firstRowHeader ? (sheet.data[0] ?? []) : [];
  const sourceRows = useMemo(
    () =>
      sheet.data.slice(firstRowHeader ? 1 : 0).map((row, index) => ({
        row,
        source: sheet.startRow + index + (firstRowHeader ? 2 : 1),
      })),
    [sheet.data, sheet.startRow, firstRowHeader],
  );
  const rows = useMemo(() => {
    if (!deferredQuery) return sourceRows;
    return sourceRows.filter(({ row }) =>
      row.some(
        (cell) =>
          cell != null && String(cell).toLowerCase().includes(deferredQuery),
      ),
    );
  }, [sourceRows, deferredQuery]);
  const columns = Math.min(200, Math.max(header.length, sheet.totalColumns, 0));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_ROWS));
  const currentPage = Math.min(page, pages - 1);
  const visible = rows.slice(
    currentPage * PAGE_ROWS,
    (currentPage + 1) * PAGE_ROWS,
  );

  useEffect(() => setPage(0), [deferredQuery, firstRowHeader, sheet.name]);

  return (
    <Flex direction="column" minH={0} h="100%">
      <Flex
        align={{ base: "stretch", md: "center" }}
        direction={{ base: "column", md: "row" }}
        gap={3}
        px={3}
        py={2}
        bg="surface.panel"
        borderBottom="1px solid"
        borderColor="surface.border"
        flexShrink={0}
      >
        <Input
          aria-label={`Search ${sheet.name}`}
          size="xs"
          placeholder="Search this sheet..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxW={{ md: "240px" }}
          bg="surface.bg"
        />
        <Checkbox
          size="sm"
          isChecked={firstRowHeader}
          onChange={(event) => setFirstRowHeader(event.target.checked)}
        >
          <Text fontSize="xs">First row is header</Text>
        </Checkbox>
        <Text fontSize="11px" color="ink.subtle" flex={1}>
          {sheet.totalRows.toLocaleString()} rows x{" "}
          {sheet.totalColumns.toLocaleString()} columns
          {deferredQuery
            ? ` · ${rows.length.toLocaleString()} preview matches`
            : ""}
          {sheet.truncated ? " · preview limited for performance" : ""}
        </Text>
        <HStack spacing={1}>
          <IconButton
            aria-label="Previous spreadsheet page"
            icon={<Icon as={VscChevronLeft} />}
            size="xs"
            variant="ghost"
            isDisabled={currentPage === 0}
            onClick={() => setPage((value) => Math.max(0, value - 1))}
          />
          <Text fontSize="11px" minW="72px" textAlign="center">
            {currentPage + 1} / {pages}
          </Text>
          <IconButton
            aria-label="Next spreadsheet page"
            icon={<Icon as={VscChevronRight} />}
            size="xs"
            variant="ghost"
            isDisabled={currentPage >= pages - 1}
            onClick={() => setPage((value) => Math.min(pages - 1, value + 1))}
          />
        </HStack>
      </Flex>
      {sheet.data.length === 0 || (visible.length === 0 && !!deferredQuery) ? (
        <Center flex={1} flexDirection="column" gap={2} color="ink.muted">
          <Icon as={VscFileBinary} fontSize="2xl" color="ink.subtle" />
          <Text fontSize="sm">
            {deferredQuery
              ? `No previewed cells match “${query}”`
              : "This sheet is empty"}
          </Text>
        </Center>
      ) : (
        <TableContainer flex={1} overflow="auto">
          <Table size="sm" variant="striped" colorScheme="gray" w="100%">
            <Thead
              position="sticky"
              top={0}
              zIndex={1}
              sx={{ "& th": { bg: "surface.panel" } }}
            >
              <Tr>
                <Th
                  scope="col"
                  fontSize="xs"
                  color="ink.subtle"
                  isNumeric
                  w="1px"
                >
                  #
                </Th>
                {Array.from({ length: columns }, (_, index) => (
                  <Th scope="col" key={index} fontSize="xs" whiteSpace="nowrap">
                    {firstRowHeader &&
                    header[index] != null &&
                    String(header[index]).trim()
                      ? String(header[index])
                      : columnName(index + sheet.startColumn)}
                  </Th>
                ))}
              </Tr>
            </Thead>
            <Tbody>
              {visible.map(({ row, source }) => (
                <Tr key={source}>
                  <Th
                    scope="row"
                    fontSize="xs"
                    color="ink.subtle"
                    isNumeric
                    fontWeight="normal"
                  >
                    {source}
                  </Th>
                  {Array.from({ length: columns }, (_, index) => (
                    <Td key={index} fontSize="xs" whiteSpace="nowrap">
                      {row[index] != null ? String(row[index]) : ""}
                    </Td>
                  ))}
                </Tr>
              ))}
            </Tbody>
          </Table>
        </TableContainer>
      )}
    </Flex>
  );
}

function ViewerState({ error, label }: { error?: string; label: string }) {
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
      <Text fontSize="sm">{label}</Text>
    </Center>
  );
}

function ExcelPreview({ file }: { file: FileRow }) {
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [omittedSheets, setOmittedSheets] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    const worker = new Worker(new URL("./excelWorker", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent) => {
      const result = event.data as
        | { ok: true; sheets: SheetData[]; omittedSheets: number }
        | { ok: false; error: string };
      if (cancelled) return;
      if (result.ok) {
        setSheets(result.sheets);
        setOmittedSheets(result.omittedSheets);
      } else setError(result.error || "Failed to load spreadsheet");
      setLoading(false);
      worker.terminate();
    };
    worker.onerror = () => {
      if (!cancelled) {
        setError("Failed to load spreadsheet");
        setLoading(false);
      }
      worker.terminate();
    };
    void fetch(rawUrl(file), { credentials: "include" })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((buffer) => worker.postMessage({ id: 1, buf: buffer }, [buffer]))
      .catch((reason) => {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Failed to load spreadsheet",
          );
          setLoading(false);
        }
        worker.terminate();
      });
    return () => {
      cancelled = true;
      worker.terminate();
    };
  }, [file.id]);

  if (loading || error)
    return <ViewerState error={error} label="Loading spreadsheet..." />;
  if (sheets.length === 0) {
    return (
      <Center flex={1} color="ink.muted">
        <Text fontSize="sm">
          This workbook does not contain any visible sheets.
        </Text>
      </Center>
    );
  }
  return (
    <Flex direction="column" flex={1} minH={0}>
      {omittedSheets > 0 && (
        <Alert status="warning" py={1.5} fontSize="xs" flexShrink={0}>
          <AlertIcon boxSize="14px" />
          {omittedSheets} additional sheet
          {omittedSheets === 1 ? " was" : "s were"} omitted from this preview.
        </Alert>
      )}
      <Tabs
        flex={1}
        minH={0}
        display="flex"
        flexDirection="column"
        overflow="hidden"
        isLazy
      >
        {sheets.length > 1 && (
          <TabList flexShrink={0} overflowX="auto" overflowY="hidden">
            {sheets.map((sheet) => (
              <Tab key={sheet.name} fontSize="xs" whiteSpace="nowrap">
                {sheet.name}
              </Tab>
            ))}
          </TabList>
        )}
        <TabPanels flex={1} minH={0}>
          {sheets.map((sheet) => (
            <TabPanel key={sheet.name} p={0} h="100%">
              <SheetTable sheet={sheet} />
            </TabPanel>
          ))}
        </TabPanels>
      </Tabs>
    </Flex>
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

  if (loading || error)
    return <ViewerState error={error} label="Converting document..." />;
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

  if (!url || error)
    return <ViewerState error={error} label="Loading PDF..." />;
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
  let body;

  if (isImage(mime, name)) {
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
  else if (isExcel(mime, name)) body = <ExcelPreview file={file} />;
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
        {canManage && (
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
