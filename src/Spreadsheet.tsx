// Spreadsheet viewer/editor. Parses in a worker (excelWorker.ts), renders a
// spreadsheet-style grid: click/arrow-key cell selection, type-to-edit,
// Ctrl+C copy (TSV), Ctrl+V paste, and save back to the server for binary
// workbooks via the blob route (text-kind CSVs stay read-only — they're
// plain OT documents editable in the code editor).
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
  Text,
  Tooltip,
  chakra,
  useToast,
} from "@chakra-ui/react";
import {
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  VscChevronLeft,
  VscChevronRight,
  VscCopy,
  VscDesktopDownload,
  VscDiscard,
  VscFileBinary,
  VscSave,
} from "react-icons/vsc";

import * as api from "./api";
import { FileRow, rawUrl } from "./api";

type SheetRow = (string | number | boolean | null)[];
export type SheetData = {
  name: string;
  data: SheetRow[];
  totalRows: number;
  totalColumns: number;
  startRow: number;
  startColumn: number;
  truncated: boolean;
};

// Edited cell values keyed "absRow:absCol" per sheet ("" = cleared cell).
type SheetEdits = Record<string, Record<string, string>>;

const PAGE_ROWS = 100;

function extension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

export function isSpreadsheet(mime: string, name: string) {
  return (
    [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/csv",
    ].includes(mime) || ["xlsx", "xls", "xlsm", "csv"].includes(extension(name))
  );
}

function columnName(index: number) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  }
  return name;
}

// New values become numbers/booleans when they clearly are one; everything
// else stays text.
function coerce(value: string): string | number | boolean {
  const t = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(t) && t.length < 16) return Number(t);
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === "true";
  return value;
}

type Sel = { ar: number; ac: number; fr: number; fc: number };

function normSel(sel: Sel) {
  return {
    r0: Math.min(sel.ar, sel.fr),
    r1: Math.max(sel.ar, sel.fr),
    c0: Math.min(sel.ac, sel.fc),
    c1: Math.max(sel.ac, sel.fc),
  };
}

type GridProps = {
  sheet: SheetData;
  edits: Record<string, string>;
  onEdit: (row: number, col: number, value: string) => void;
  onEditsClear: () => void;
  editable: boolean;
  search: string;
  firstRowHeader: boolean;
};

// The interactive grid for one sheet. Coordinates in selection/edit state are
// absolute (0-based workbook) coordinates so they survive pagination and map
// straight onto the saved workbook.
function SheetGrid({
  sheet,
  edits,
  onEdit,
  onEditsClear,
  editable,
  search,
  firstRowHeader,
}: GridProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [sel, setSel] = useState<Sel>({
    ar: sheet.startRow,
    ac: sheet.startColumn,
    fr: sheet.startRow,
    fc: sheet.startColumn,
  });
  const [editing, setEditing] = useState<{
    r: number;
    c: number;
    value: string;
  } | null>(null);

  const columns = Math.min(
    200,
    Math.max(sheet.data[0]?.length ?? 0, sheet.totalColumns, 1),
  );

  // Map of preview-index -> display row, honoring the search filter.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out: { i: number; row: SheetRow }[] = [];
    for (let i = 0; i < sheet.data.length; i++) {
      const row = sheet.data[i];
      if (
        q &&
        !row.some(
          (cell) => cell != null && String(cell).toLowerCase().includes(q),
        )
      )
        continue;
      out.push({ i, row });
    }
    return out;
  }, [sheet.data, search]);

  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_ROWS));
  const currentPage = Math.min(page, pages - 1);
  useEffect(() => setPage(0), [search, sheet.name, firstRowHeader]);
  const visible = rows.slice(
    currentPage * PAGE_ROWS,
    (currentPage + 1) * PAGE_ROWS,
  );

  const absRow = (i: number) => sheet.startRow + i;
  const valueAt = useCallback(
    (r: number, c: number) => {
      const e = edits[`${r}:${c}`];
      if (e !== undefined) return e;
      const i = r - sheet.startRow;
      const row = sheet.data[i];
      const v = row ? row[c - sheet.startColumn] : null;
      return v == null ? "" : String(v);
    },
    [edits, sheet.data, sheet.startRow, sheet.startColumn],
  );

  const copySelection = useCallback(() => {
    const { r0, r1, c0, c1 } = normSel(sel);
    const lines: string[] = [];
    for (let r = r0; r <= r1; r++) {
      const cells: string[] = [];
      for (let c = c0; c <= c1; c++) {
        const v = valueAt(r, c);
        cells.push(/[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      }
      lines.push(cells.join("\t"));
    }
    navigator.clipboard?.writeText(lines.join("\n")).catch(() => {});
  }, [sel, valueAt]);

  const pasteText = useCallback(
    (text: string) => {
      if (!editable) return;
      const matrix = text
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => (line.includes("\t") ? line.split("\t") : [line]))
        .filter((cells) => cells.length > 1 || cells[0] !== "");
      if (!matrix.length) return;
      for (let dr = 0; dr < matrix.length; dr++) {
        for (let dc = 0; dc < matrix[dr].length; dc++) {
          const r = sel.fr + dr;
          const c = sel.fc + dc;
          if (r < 0 || c < 0) continue;
          onEdit(r, c, matrix[dr][dc]);
        }
      }
      setSel({
        ar: sel.fr,
        ac: sel.fc,
        fr: sel.fr + matrix.length - 1,
        fc: sel.fc + matrix[0].length - 1,
      });
    },
    [editable, sel.fr, sel.fc, onEdit],
  );

  const startEdit = (r: number, c: number, initial?: string) => {
    if (!editable) return;
    setEditing({ r, c, value: initial ?? valueAt(r, c) });
  };

  const commitEdit = (move: "down" | "right" | null) => {
    if (!editing) return;
    onEdit(editing.r, editing.c, editing.value);
    const { r, c } = editing;
    setEditing(null);
    gridRef.current?.focus();
    if (move === "down") setSel({ ar: r + 1, ac: c, fr: r + 1, fc: c });
    else if (move === "right") setSel({ ar: r, ac: c + 1, fr: r, fc: c + 1 });
    else setSel({ ar: r, ac: c, fr: r, fc: c });
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (editing) return; // the input handles its own keys
    const { r0, r1, c0, c1 } = normSel(sel);
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      const r = Math.max(sheet.startRow, sel.fr + dr);
      const c = Math.max(sheet.startColumn, sel.fc + dc);
      setSel(
        e.shiftKey ? { ...sel, fr: r, fc: c } : { ar: r, ac: c, fr: r, fc: c },
      );
    };
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copySelection();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
      e.preventDefault();
      navigator.clipboard
        ?.readText()
        .then((t) => pasteText(t))
        .catch(() => {});
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      const lastRow = sheet.startRow + sheet.data.length - 1;
      setSel({
        ar: sheet.startRow,
        ac: sheet.startColumn,
        fr: lastRow,
        fc: sheet.startColumn + columns - 1,
      });
    } else if (e.key === "ArrowUp") move(-1, 0);
    else if (e.key === "ArrowDown") move(1, 0);
    else if (e.key === "ArrowLeft") move(0, -1);
    else if (e.key === "ArrowRight") move(0, 1);
    else if (e.key === "Tab") move(0, e.shiftKey ? -1 : 1);
    else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      startEdit(sel.fr, sel.fc);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (!editable) return;
      e.preventDefault();
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) onEdit(r, c, "");
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (!editable) return;
      e.preventDefault();
      startEdit(sel.fr, sel.fc, e.key);
    }
  };

  const isSel = (r: number, c: number) => {
    const { r0, r1, c0, c1 } = normSel(sel);
    return r >= r0 && r <= r1 && c >= c0 && c <= c1;
  };

  const headerCells = Array.from({ length: columns }, (_, k) => {
    const c = sheet.startColumn + k;
    const name =
      firstRowHeader && sheet.data[0]?.[k] != null
        ? String(sheet.data[0][k])
        : columnName(c);
    const inSel = isSel(sheet.startRow, c);
    return (
      <chakra.th
        key={c}
        onClick={(e) =>
          setSel({
            ar: sheet.startRow,
            ac: c,
            fr: e.shiftKey ? sel.fr : sheet.startRow + sheet.data.length - 1,
            fc: c,
          })
        }
        sx={{
          position: "sticky",
          top: 0,
          zIndex: 2,
          bg: inSel ? "rgba(107,91,255,0.16)" : "surface.hover",
          color: "ink.muted",
          fontWeight: 600,
          fontSize: "10.5px",
          letterSpacing: "0.03em",
          textTransform: "uppercase",
          px: 2,
          py: 1,
          borderBottom: "1px solid",
          borderColor: "surface.borderStrong",
          borderLeft: "1px solid",
          borderLeftColor: "surface.border",
          whiteSpace: "nowrap",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        {name}
      </chakra.th>
    );
  });

  return (
    <Flex
      direction="column"
      minH={0}
      h="100%"
      outline="none"
      tabIndex={0}
      ref={gridRef}
      onKeyDown={onKeyDown}
      _focusVisible={{ boxShadow: "none" }}
    >
      <Box flex={1} minH={0} overflow="auto" bg="surface.bg">
        <chakra.table
          sx={{
            borderCollapse: "separate",
            borderSpacing: 0,
            fontSize: "12px",
            tableLayout: "auto",
            "& td, & th": { minWidth: "88px", maxWidth: "360px" },
          }}
        >
          <chakra.thead>
            <tr>{headerCells}</tr>
          </chakra.thead>
          <chakra.tbody>
            {visible.map(({ i, row }) => {
              const r = absRow(i);
              return (
                <chakra.tr key={r}>
                  <chakra.th
                    onClick={(e) =>
                      setSel({
                        ar: r,
                        ac: sheet.startColumn,
                        fr: e.shiftKey ? sel.fr : r,
                        fc: sheet.startColumn + columns - 1,
                      })
                    }
                    sx={{
                      position: "sticky",
                      left: 0,
                      zIndex: 1,
                      bg: "surface.hover",
                      color: "ink.subtle",
                      fontWeight: 400,
                      fontSize: "10.5px",
                      fontVariantNumeric: "tabular-nums",
                      px: 2,
                      textAlign: "right",
                      borderBottom: "1px solid",
                      borderColor: "surface.border",
                      borderRight: "1px solid",
                      borderRightColor: "surface.borderStrong",
                      minWidth: "44px",
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                  >
                    {r + 1}
                  </chakra.th>
                  {Array.from({ length: columns }, (_, k) => {
                    const c = sheet.startColumn + k;
                    const selected = isSel(r, c);
                    const isFocus = sel.fr === r && sel.fc === c;
                    const isEditing = editing?.r === r && editing?.c === c;
                    const v = valueAt(r, c);
                    const changed = edits[`${r}:${c}`] !== undefined;
                    return (
                      <chakra.td
                        key={c}
                        onMouseDown={(e) => {
                          if (editing) commitEdit(null);
                          if (e.shiftKey)
                            setSel((s) => ({ ...s, fr: r, fc: c }));
                          else {
                            setSel({ ar: r, ac: c, fr: r, fc: c });
                            if (e.detail === 2) startEdit(r, c);
                          }
                          dragging.current = true;
                          gridRef.current?.focus();
                        }}
                        onMouseMove={() => {
                          if (dragging.current)
                            setSel((s) => ({ ...s, fr: r, fc: c }));
                        }}
                        onMouseUp={() => (dragging.current = false)}
                        onDoubleClick={() => startEdit(r, c)}
                        sx={{
                          px: 2,
                          py: "3px",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          maxWidth: "360px",
                          color: "ink.base",
                          fontVariantNumeric: "tabular-nums",
                          borderBottom: "1px solid",
                          borderColor: "surface.border",
                          borderRight: "1px solid",
                          borderRightColor: "surface.border",
                          bg: isEditing
                            ? "surface.bg"
                            : selected
                              ? "accent.tint"
                              : changed
                                ? "rgba(230,168,42,0.12)"
                                : "transparent",
                          outline: isFocus ? "2px solid" : "none",
                          outlineColor: "brand.500",
                          outlineOffset: "-2px",
                          cursor: editable ? "cell" : "default",
                          userSelect: "none",
                        }}
                      >
                        {isEditing ? (
                          <Input
                            autoFocus
                            size="xs"
                            variant="unstyled"
                            value={editing.value}
                            fontSize="12px"
                            h="20px"
                            onChange={(e) =>
                              setEditing((ed) =>
                                ed ? { ...ed, value: e.target.value } : ed,
                              )
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitEdit("down");
                              } else if (e.key === "Tab") {
                                e.preventDefault();
                                commitEdit("right");
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                setEditing(null);
                                gridRef.current?.focus();
                              }
                            }}
                            onBlur={() => commitEdit(null)}
                            sx={{ my: "-3px" }}
                          />
                        ) : (
                          v
                        )}
                      </chakra.td>
                    );
                  })}
                </chakra.tr>
              );
            })}
          </chakra.tbody>
        </chakra.table>
        {visible.length === 0 && (
          <Center flexDirection="column" gap={2} p={10} color="ink.muted">
            <Icon as={VscFileBinary} fontSize="2xl" color="ink.subtle" />
            <Text fontSize="sm">
              {search ? `No cells match “${search}”` : "This sheet is empty"}
            </Text>
          </Center>
        )}
      </Box>

      {/* Bottom bar: pagination + selection summary + clipboard actions. */}
      <Flex
        align="center"
        gap={3}
        px={3}
        py={1}
        borderTop="1px solid"
        borderColor="surface.border"
        bg="surface.panel"
        flexShrink={0}
      >
        <HStack spacing={1}>
          <IconButton
            aria-label="Previous rows"
            icon={<Icon as={VscChevronLeft} />}
            size="xs"
            variant="ghost"
            isDisabled={currentPage === 0}
            onClick={() => setPage((v) => Math.max(0, v - 1))}
          />
          <Text
            fontSize="11px"
            minW="70px"
            textAlign="center"
            color="ink.muted"
          >
            {currentPage + 1} / {pages}
          </Text>
          <IconButton
            aria-label="Next rows"
            icon={<Icon as={VscChevronRight} />}
            size="xs"
            variant="ghost"
            isDisabled={currentPage >= pages - 1}
            onClick={() => setPage((v) => Math.min(pages - 1, v + 1))}
          />
        </HStack>
        <Text fontSize="11px" color="ink.subtle" flex={1} noOfLines={1}>
          {(() => {
            const { r0, r1, c0, c1 } = normSel(sel);
            const n = (r1 - r0 + 1) * (c1 - c0 + 1);
            if (n === 1) return `${columnName(sel.fc)}${sel.fr + 1}`;
            return `${columnName(c0)}${r0 + 1}:${columnName(c1)}${r1 + 1} · ${n.toLocaleString()} cells`;
          })()}
        </Text>
        <Button
          size="xs"
          variant="ghost"
          leftIcon={<Icon as={VscCopy} />}
          onClick={copySelection}
        >
          Copy
        </Button>
        {editable && Object.keys(edits).length > 0 && (
          <Button
            size="xs"
            variant="ghost"
            color="orange.400"
            leftIcon={<Icon as={VscDiscard} />}
            onClick={onEditsClear}
          >
            Revert
          </Button>
        )}
      </Flex>
    </Flex>
  );
}

function SpreadsheetView({ file }: { file: FileRow }) {
  const toast = useToast();
  const name = file.path.split("/").pop() ?? file.path;
  const ext = extension(name);
  const editable = file.kind === "binary";
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [omittedSheets, setOmittedSheets] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [active, setActive] = useState(0);
  const [edits, setEdits] = useState<SheetEdits>({});
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [firstRowHeader, setFirstRowHeader] = useState(true);
  // Latest blob revision from the server; sent back with every save.
  const revision = useRef(0);
  // Original workbook bytes, kept so saving can re-serialize the full file.
  const original = useRef<ArrayBuffer | null>(null);
  // Bumped to re-run the load effect after a save conflict.
  const [reloadKey, setReloadKey] = useState(0);

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
        setActive(0);
        setEdits({});
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
    // Keep a copy of the bytes: the same buffer is re-parsed on save so the
    // untouched sheets/cells keep their exact values and types.
    void fetch(rawUrl(file), { credentials: "include" })
      .then((response) => {
        revision.current = Number(
          response.headers.get("x-cortex-revision") ?? 0,
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((buffer) => {
        if (cancelled) return;
        original.current = buffer;
        worker.postMessage({ id: 1, buf: buffer });
      })
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
  }, [file.id, reloadKey]);

  const sheet = sheets[active];
  const sheetEdits = sheet ? (edits[sheet.name] ?? {}) : {};
  const editCount = Object.values(edits).reduce(
    (n, m) => n + Object.keys(m).length,
    0,
  );

  const onEdit = (row: number, col: number, value: string) => {
    if (!sheet) return;
    setEdits((prev) => ({
      ...prev,
      [sheet.name]: {
        ...(prev[sheet.name] ?? {}),
        [`${row}:${col}`]: value,
      },
    }));
  };

  const revert = () =>
    setEdits((prev) => {
      if (!sheet) return prev;
      const next = { ...prev };
      delete next[sheet.name];
      return next;
    });

  const save = async () => {
    if (!sheet || saving) return;
    const buf = original.current;
    if (!buf) return;
    setSaving(true);
    try {
      const payload: Record<
        string,
        { row: number; col: number; value: string | number | boolean }[]
      > = {};
      for (const [sheetName, cells] of Object.entries(edits)) {
        const list = Object.entries(cells).map(([key, value]) => {
          const [r, c] = key.split(":").map(Number);
          return { row: r, col: c, value: coerce(value) };
        });
        if (list.length) payload[sheetName] = list;
      }
      const worker = new Worker(new URL("./excelWorker", import.meta.url), {
        type: "module",
      });
      // Transfer a copy: if the save fails or conflicts, the original stays
      // usable for the next attempt.
      const transferable = buf.slice(0);
      const out = await new Promise<ArrayBuffer>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent) => {
          const result = event.data as
            | { ok: true; buf: ArrayBuffer }
            | { ok: false; error: string };
          if (result.ok) resolve(result.buf);
          else reject(new Error(result.error));
        };
        worker.onerror = () => reject(new Error("Failed to save spreadsheet"));
        worker.postMessage(
          {
            id: 2,
            cmd: "save",
            buf: transferable,
            edits: payload,
            bookType: ext === "xls" ? "xls" : ext === "csv" ? "csv" : "xlsx",
          },
          [transferable],
        );
      }).finally(() => worker.terminate());
      revision.current = await api.saveFileBlob(
        file.id,
        new Uint8Array(out),
        revision.current,
      );
      original.current = out;
      setEdits({});
      toast({ title: "Spreadsheet saved", status: "success", duration: 2000 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Save failed";
      toast({
        title:
          msg.includes("changed") || msg.includes("CONFLICT")
            ? "File changed elsewhere — reopening the latest version"
            : msg,
        status: "error",
        duration: 4000,
      });
      if (msg.includes("changed") || msg.includes("CONFLICT")) {
        setLoading(true);
        setSheets([]);
        setEdits({});
        // Reload: bumping state below re-triggers the load effect.
        setReloadKey((k) => k + 1);
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading || error)
    return (
      <Center flex={1} gap={2} role="status" color="ink.muted">
        {error ? (
          <Alert status="error" maxW="560px" borderRadius="lg" role="alert">
            <AlertIcon />
            {error}
          </Alert>
        ) : (
          <>
            <Spinner size="sm" />
            <Text fontSize="sm">Loading spreadsheet...</Text>
          </>
        )}
      </Center>
    );

  if (sheets.length === 0)
    return (
      <Center flex={1} color="ink.muted">
        <Text fontSize="sm">
          This workbook does not contain any visible sheets.
        </Text>
      </Center>
    );

  return (
    <Flex direction="column" flex={1} minH={0}>
      {/* Toolbar */}
      <Flex
        align="center"
        gap={3}
        px={3}
        py={1.5}
        bg="surface.panel"
        borderBottom="1px solid"
        borderColor="surface.border"
        flexShrink={0}
      >
        <Input
          aria-label={`Search ${sheet?.name ?? "sheet"}`}
          size="xs"
          placeholder="Search cells…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          maxW="220px"
          bg="surface.bg"
        />
        <Checkbox
          size="sm"
          isChecked={firstRowHeader}
          onChange={(event) => setFirstRowHeader(event.target.checked)}
        >
          <Text fontSize="xs">First row is header</Text>
        </Checkbox>
        {sheet && (
          <Text fontSize="11px" color="ink.subtle" flex={1} noOfLines={1}>
            {sheet.totalRows.toLocaleString()} rows ×{" "}
            {sheet.totalColumns.toLocaleString()} columns
            {sheet.truncated ? " · preview limited for performance" : ""}
          </Text>
        )}
        {editable && editCount > 0 && (
          <Text fontSize="11px" color="orange.400" fontWeight={600}>
            {editCount} unsaved change{editCount === 1 ? "" : "s"}
          </Text>
        )}
        {editable && (
          <Button
            size="xs"
            leftIcon={<Icon as={VscSave} />}
            isLoading={saving}
            isDisabled={editCount === 0}
            onClick={() => void save()}
          >
            Save
          </Button>
        )}
        <Tooltip label="Download" openDelay={300}>
          <IconButton
            aria-label="Download spreadsheet"
            icon={<Icon as={VscDesktopDownload} />}
            size="xs"
            variant="ghost"
            onClick={() =>
              api.downloadFile(file).catch(() =>
                toast({
                  title: "Download failed",
                  status: "error",
                  duration: 3000,
                }),
              )
            }
          />
        </Tooltip>
      </Flex>

      {!editable && (
        <Alert status="info" py={1} fontSize="xs" flexShrink={0}>
          <AlertIcon boxSize="14px" />
          This CSV opens read-only here — edit it as a text file, or convert to
          .xlsx for spreadsheet editing.
        </Alert>
      )}
      {omittedSheets > 0 && (
        <Alert status="warning" py={1} fontSize="xs" flexShrink={0}>
          <AlertIcon boxSize="14px" />
          {omittedSheets} additional sheet
          {omittedSheets === 1 ? " was" : "s were"} omitted from this preview.
        </Alert>
      )}

      {/* Grid */}
      {sheet && (
        <SheetGrid
          key={sheet.name}
          sheet={sheet}
          edits={sheetEdits}
          onEdit={onEdit}
          onEditsClear={revert}
          editable={editable}
          search={search}
          firstRowHeader={firstRowHeader}
        />
      )}

      {/* Sheet tabs (bottom strip, like a spreadsheet app) */}
      {sheets.length > 1 && (
        <Flex
          align="center"
          gap={1}
          px={2}
          py={1}
          borderTop="1px solid"
          borderColor="surface.border"
          bg="surface.panel"
          overflowX="auto"
          flexShrink={0}
          sx={{ "&::-webkit-scrollbar": { height: "0px" } }}
        >
          {sheets.map((s, i) => {
            const isActive = i === active;
            const dirty = Object.keys(edits[s.name] ?? {}).length > 0;
            return (
              <Flex
                key={s.name}
                as="button"
                align="center"
                gap={1.5}
                px={2.5}
                py={1}
                borderRadius="sm"
                fontSize="12px"
                fontWeight={isActive ? 600 : 400}
                color={isActive ? "ink.base" : "ink.muted"}
                bg={isActive ? "surface.hover" : "transparent"}
                _hover={{
                  bg: isActive ? "surface.hover" : "surface.panel",
                  color: "ink.base",
                }}
                whiteSpace="nowrap"
                onClick={() => setActive(i)}
              >
                {s.name}
                {dirty && (
                  <Box boxSize="6px" borderRadius="full" bg="orange.400" />
                )}
              </Flex>
            );
          })}
        </Flex>
      )}
    </Flex>
  );
}

export default SpreadsheetView;
