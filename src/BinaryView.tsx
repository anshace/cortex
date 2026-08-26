import {
  Box,
  Center,
  Flex,
  Icon,
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
  Tr,
  useToast,
} from "@chakra-ui/react";
import mammoth from "mammoth";
import { useEffect, useMemo, useRef, useState } from "react";
import { VscDesktopDownload, VscFileBinary } from "react-icons/vsc";

import * as api from "./api";
import { FileRow, rawUrl } from "./api";

function isExcel(mime: string | null, name: string): boolean {
  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel" ||
    mime === "text/csv"
  )
    return true;
  return /\.(xlsx?|csv)$/i.test(name);
}

function isWord(mime: string | null, name: string): boolean {
  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword"
  )
    return true;
  return /\.docx?$/i.test(name);
}

// One sheet's grid. The full data lives in memory (parsing is fast), but only
// a window of rows is *rendered* at first — an IntersectionObserver on the
// bottom sentinel grows the window as you scroll, so a million-row sheet never
// mounts a million <tr> elements. Strictly read-only by design.
type SheetRow = (string | number | boolean | null)[];

const INITIAL_ROWS = 100;
const LOAD_MORE_ROWS = 250;

function SheetTable({ data }: { data: SheetRow[] }) {
  const [limit, setLimit] = useState(INITIAL_ROWS);
  const [query, setQuery] = useState("");
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Client-side text filter across every cell — cheap because it runs over the
  // already-parsed array, not the DOM.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return data.filter((row) =>
      row.some((c) => c != null && String(c).toLowerCase().includes(q)),
    );
  }, [data, query]);

  const rows = filtered ?? data;
  const shown = Math.min(limit, rows.length);

  // A new search starts from the top again.
  useEffect(() => {
    setLimit(INITIAL_ROWS);
  }, [query]);

  // Grow the rendered window when the sentinel scrolls into view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const ob = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting))
          setLimit((l) => Math.min(rows.length, l + LOAD_MORE_ROWS));
      },
      { rootMargin: "600px" }, // start loading before the user hits the edge
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, [rows.length]);

  if (rows.length === 0)
    return (
      <Center flexDirection="column" gap={2} py={16} color="ink.muted">
        <Icon as={VscFileBinary} fontSize="2xl" color="ink.subtle" />
        <Text fontSize="sm">
          {filtered ? `No cells match “${query}”` : "This sheet is empty"}
        </Text>
      </Center>
    );

  return (
    <Box>
      <Flex
        align="center"
        gap={3}
        px={3}
        py={2}
        position="sticky"
        top={0}
        bg="surface.panel"
        zIndex={1}
        borderBottom="1px solid"
        borderColor="surface.border"
      >
        <Input
          size="xs"
          placeholder="Search this sheet…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxW="240px"
          bg="surface.bg"
        />
        <Text fontSize="0.7rem" color="ink.subtle" flexShrink={0}>
          {data.length.toLocaleString()} rows
          {filtered
            ? ` · ${rows.length.toLocaleString()} match${rows.length === 1 ? "" : "es"}`
            : ""}
          {shown < rows.length
            ? ` · showing ${shown.toLocaleString()} — scroll for more`
            : shown > INITIAL_ROWS
              ? " · all loaded"
              : ""}
        </Text>
      </Flex>
      <TableContainer overflow="auto">
        <Table size="sm" variant="striped" colorScheme="gray">
          {rows[0].length > 0 && (
            <Thead
              position="sticky"
              top="33px"
              zIndex={1}
              sx={{ "& th": { bg: "surface.panel" } }}
            >
              <Tr>
                <Th fontSize="xs" color="ink.subtle" isNumeric w="1px">
                  #
                </Th>
                {rows[0].map((cell, ci) => (
                  <Th key={ci} fontSize="xs" whiteSpace="nowrap">
                    {cell != null ? String(cell) : ""}
                  </Th>
                ))}
              </Tr>
            </Thead>
          )}
          <Tbody>
            {rows.slice(1, shown).map((row, ri) => (
              <Tr key={ri}>
                <Td fontSize="xs" color="ink.subtle" isNumeric w="1px">
                  {ri + 2}
                </Td>
                {row.map((cell, ci) => (
                  <Td key={ci} fontSize="xs" whiteSpace="nowrap">
                    {cell != null ? String(cell) : ""}
                  </Td>
                ))}
              </Tr>
            ))}
          </Tbody>
        </Table>
        {shown < rows.length && (
          <Center ref={sentinelRef} py={4}>
            <Spinner size="sm" />
          </Center>
        )}
      </TableContainer>
    </Box>
  );
}

function ExcelPreview({ file }: { file: FileRow }) {
  const [sheets, setSheets] = useState<{ name: string; data: SheetRow[] }[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Parsing happens in a Web Worker (excelWorker.ts) so a big workbook never
  // blocks the main thread while it's decoded.
  useEffect(() => {
    let cancelled = false;
    const worker = new Worker(new URL("./excelWorker", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent) => {
      const r = e.data as
        | { id: number; ok: true; sheets: { name: string; data: SheetRow[] }[] }
        | { id: number; ok: false; error: string };
      if (cancelled) return;
      if (r.ok) setSheets(r.sheets);
      else setError(r.error || "Failed to load spreadsheet");
      setLoading(false);
      worker.terminate();
    };
    worker.onerror = () => {
      if (!cancelled) {
        setError("Failed to load spreadsheet");
        setLoading(false);
      }
    };
    (async () => {
      try {
        const res = await fetch(rawUrl(file));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        worker.postMessage({ id: 1, buf }, [buf]);
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error ? e.message : "Failed to load spreadsheet",
          );
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      worker.terminate();
    };
  }, [file.id]);

  if (loading)
    return (
      <Center flex={1} minH={0}>
        <Spinner />
      </Center>
    );
  if (error)
    return (
      <Center
        flex={1}
        minH={0}
        flexDirection="column"
        gap={2}
        color="ink.muted"
      >
        <Text fontSize="sm">{error}</Text>
      </Center>
    );

  return (
    <Tabs
      flex={1}
      minH={0}
      display="flex"
      flexDirection="column"
      overflow="hidden"
    >
      <TabList flexShrink={0}>
        {sheets.map((s) => (
          <Tab key={s.name} fontSize="xs">
            {s.name}
          </Tab>
        ))}
      </TabList>
      <TabPanels flex={1} minH={0} overflow="auto">
        {sheets.map((s) => (
          <TabPanel key={s.name} p={0}>
            <SheetTable data={s.data} />
          </TabPanel>
        ))}
      </TabPanels>
    </Tabs>
  );
}

function WordPreview({ file }: { file: FileRow }) {
  const [html, setHtml] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(rawUrl(file));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const result = await mammoth.convertToHtml({ arrayBuffer: buf });
        if (!cancelled) {
          setHtml(result.value);
          if (result.messages.length > 0) {
            console.warn("Word conversion warnings:", result.messages);
          }
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load document");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file.id]);

  if (loading)
    return (
      <Center flex={1} minH={0}>
        <Spinner />
      </Center>
    );
  if (error)
    return (
      <Center
        flex={1}
        minH={0}
        flexDirection="column"
        gap={2}
        color="ink.muted"
      >
        <Text fontSize="sm">{error}</Text>
      </Center>
    );

  return (
    <Box
      flex={1}
      minH={0}
      overflow="auto"
      p={6}
      maxW="900px"
      mx="auto"
      w="100%"
      sx={{
        "& h1": { fontSize: "2xl", fontWeight: "bold", mt: 4, mb: 2 },
        "& h2": { fontSize: "xl", fontWeight: "bold", mt: 3, mb: 2 },
        "& h3": { fontSize: "lg", fontWeight: "bold", mt: 2, mb: 1 },
        "& p": { mb: 2, lineHeight: "tall" },
        "& ul, & ol": { pl: 6, mb: 2 },
        "& li": { mb: 1 },
        "& table": { borderCollapse: "collapse", my: 3, w: "100%" },
        "& th, & td": {
          border: "1px solid",
          borderColor: "gray.300",
          px: 3,
          py: 1.5,
          textAlign: "left",
        },
        "& th": { bg: "gray.100", fontWeight: "bold" },
        "& img": { maxW: "100%", h: "auto" },
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// Opens an uploaded binary document in its own view: images and PDFs preview
// inline; Excel/Word get interactive previews; anything else shows file info.
function BinaryView({
  file,
  canManage,
}: {
  file: FileRow;
  canManage: boolean;
}) {
  const toast = useToast();
  const mime = file.mime ?? "";
  const name = file.path.split("/").pop() ?? "";

  const excel = isExcel(mime, name);
  const word = isWord(mime, name);

  const body = mime.startsWith("image/") ? (
    <Center flex={1} minH={0} p={6} overflow="auto">
      <img
        src={rawUrl(file)}
        alt={name}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          borderRadius: 8,
        }}
      />
    </Center>
  ) : mime === "application/pdf" ? (
    <Box flex={1} minH={0}>
      <iframe
        title={name}
        src={rawUrl(file)}
        style={{ width: "100%", height: "100%", border: "none" }}
      />
    </Box>
  ) : excel ? (
    <ExcelPreview file={file} />
  ) : word ? (
    <WordPreview file={file} />
  ) : (
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
        Preview isn't available for this file type. Download it to open in the
        matching app.
      </Text>
    </Center>
  );

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
        justify="space-between"
        px={4}
        h={10}
        borderBottom="1px solid"
        borderColor="surface.border"
        bg="surface.panel"
        flexShrink={0}
      >
        <Text fontSize="sm" color="ink.base" isTruncated>
          {name}
        </Text>
        {canManage && (
          <Flex
            as="a"
            href={rawUrl(file)}
            download={name}
            align="center"
            gap={1.5}
            fontSize="xs"
            fontWeight="medium"
            color="green.500"
            _hover={{ color: "green.600" }}
            cursor="pointer"
            onClick={(e) => {
              e.preventDefault();
              api.downloadFile(file).catch(() =>
                toast({
                  title: "Download failed",
                  status: "error",
                  duration: 3000,
                }),
              );
            }}
          >
            <Icon as={VscDesktopDownload} />
            Download
          </Flex>
        )}
      </Flex>
      {body}
    </Flex>
  );
}

export default BinaryView;
