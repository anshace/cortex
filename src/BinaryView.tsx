import {
  Box,
  Center,
  Flex,
  Icon,
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
import { useEffect, useState } from "react";
import { VscDesktopDownload, VscFileBinary } from "react-icons/vsc";
import * as XLSX from "xlsx";

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

function ExcelPreview({ file }: { file: FileRow }) {
  const [sheets, setSheets] = useState<
    { name: string; data: (string | number | boolean | null)[][] }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(rawUrl(file));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const result = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name];
          const raw = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(
            ws,
            { header: 1, defval: null },
          );
          return { name, data: raw };
        });
        if (!cancelled) setSheets(result);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load spreadsheet");
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
      <Center flex={1} minH={0} flexDirection="column" gap={2} color="ink.muted">
        <Text fontSize="sm">{error}</Text>
      </Center>
    );

  return (
    <Tabs flex={1} minH={0} display="flex" flexDirection="column" overflow="hidden">
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
            <TableContainer overflow="auto" maxH="calc(100vh - 160px)">
              <Table size="sm" variant="striped" colorScheme="gray">
                {s.data.length > 0 && (
                  <Thead>
                    <Tr>
                      {s.data[0].map((cell, ci) => (
                        <Th key={ci} fontSize="xs" whiteSpace="nowrap">
                          {cell != null ? String(cell) : ""}
                        </Th>
                      ))}
                    </Tr>
                  </Thead>
                )}
                <Tbody>
                  {s.data.slice(1).map((row, ri) => (
                    <Tr key={ri}>
                      {row.map((cell, ci) => (
                        <Td key={ci} fontSize="xs" whiteSpace="nowrap">
                          {cell != null ? String(cell) : ""}
                        </Td>
                      ))}
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </TableContainer>
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
      <Center flex={1} minH={0} flexDirection="column" gap={2} color="ink.muted">
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
function BinaryView({ file, canManage }: { file: FileRow; canManage: boolean }) {
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
    <Flex flex={1} minW={0} direction="column" bg="surface.bg" overflow="hidden">
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
