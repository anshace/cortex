// Spreadsheet parsing stays off the main thread and is deliberately bounded:
// compressed workbooks can expand far beyond their upload size.
import * as XLSX from "xlsx";

type SheetRow = (string | number | boolean | null)[];

const MAX_SHEETS = 25;
const MAX_COLUMNS = 200;
const MAX_CELLS_PER_SHEET = 50_000;
const MAX_ROWS_PER_SHEET = 5_000;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;

// One edited cell, addressed in absolute 0-based sheet coordinates.
type CellEdit = { row: number; col: number; value: string | number | boolean };

type ParseRequest = { id: number; cmd?: "parse"; buf: ArrayBuffer };
type SaveRequest = {
  id: number;
  cmd: "save";
  buf: ArrayBuffer;
  edits: Record<string, CellEdit[]>; // sheet name -> edits
  bookType: "xlsx" | "xls" | "csv";
};

function checkZipExpansion(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint32(0, true) !== 0x04034b50) return;
  let expanded = 0;
  let entries = 0;
  for (let offset = 0; offset + 46 <= view.byteLength; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    expanded += view.getUint32(offset + 24, true);
    entries += 1;
    if (expanded > MAX_EXPANDED_BYTES || entries > MAX_ZIP_ENTRIES) {
      throw new Error("Workbook is too large to preview safely");
    }
  }
}

const ctx = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

// Parse a workbook fully (no row cap) and apply edited cells, keeping the
// original typed values for everything the user didn't touch.
function saveWorkbook(req: SaveRequest) {
  checkZipExpansion(req.buf);
  const workbook = XLSX.read(new Uint8Array(req.buf), {
    type: "array",
    cellDates: true,
    cellNF: false,
    cellStyles: false,
  });
  for (const [sheetName, edits] of Object.entries(req.edits)) {
    if (!edits.length) continue;
    let worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
      worksheet = XLSX.utils.aoa_to_sheet([]);
      XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    }
    const range = worksheet["!ref"]
      ? XLSX.utils.decode_range(worksheet["!ref"])
      : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    for (const edit of edits) {
      const addr = XLSX.utils.encode_cell({ r: edit.row, c: edit.col });
      const cell: XLSX.CellObject =
        typeof edit.value === "number"
          ? { t: "n", v: edit.value }
          : typeof edit.value === "boolean"
            ? { t: "b", v: edit.value }
            : edit.value === ""
              ? { t: "z" }
              : { t: "s", v: edit.value };
      if (cell.t === "z") delete worksheet[addr];
      else worksheet[addr] = cell;
      range.s.r = Math.min(range.s.r, edit.row);
      range.s.c = Math.min(range.s.c, edit.col);
      range.e.r = Math.max(range.e.r, edit.row);
      range.e.c = Math.max(range.e.c, edit.col);
    }
    worksheet["!ref"] = XLSX.utils.encode_range(range);
  }
  const out = XLSX.write(workbook, {
    type: "array",
    bookType: req.bookType,
  }) as ArrayBuffer;
  ctx.postMessage({ id: req.id, ok: true, buf: out }, [out]);
}

self.addEventListener("message", (event: MessageEvent) => {
  const req = event.data as ParseRequest | SaveRequest;
  try {
    if (req.cmd === "save") {
      saveWorkbook(req);
      return;
    }
    const buf = req.buf;
    checkZipExpansion(buf);
    const workbook = XLSX.read(buf, {
      type: "array",
      cellDates: true,
      cellHTML: false,
      cellNF: false,
      cellStyles: false,
      sheetRows: MAX_ROWS_PER_SHEET + 1,
    });
    const sheets = workbook.SheetNames.slice(0, MAX_SHEETS).map((name) => {
      const worksheet = workbook.Sheets[name];
      const original = worksheet["!ref"]
        ? XLSX.utils.decode_range(worksheet["!ref"])
        : null;
      const totalRows = original ? original.e.r - original.s.r + 1 : 0;
      const totalColumns = original ? original.e.c - original.s.c + 1 : 0;
      const columns = Math.max(1, Math.min(totalColumns, MAX_COLUMNS));
      const rows = Math.max(
        0,
        Math.min(totalRows, Math.floor(MAX_CELLS_PER_SHEET / columns)),
      );
      const range =
        original && rows > 0
          ? {
              s: original.s,
              e: {
                r: original.s.r + Math.max(0, rows - 1),
                c: original.s.c + Math.max(0, columns - 1),
              },
            }
          : undefined;
      const data = range
        ? XLSX.utils.sheet_to_json<SheetRow>(worksheet, {
            header: 1,
            defval: null,
            raw: false,
            dateNF: "yyyy-mm-dd",
            range,
          })
        : [];
      return {
        name,
        data,
        totalRows,
        totalColumns,
        startRow: original?.s.r ?? 0,
        startColumn: original?.s.c ?? 0,
        truncated: rows < totalRows || columns < totalColumns,
      };
    });
    ctx.postMessage({
      id: req.id,
      ok: true,
      sheets,
      omittedSheets: Math.max(0, workbook.SheetNames.length - MAX_SHEETS),
    });
  } catch (error) {
    ctx.postMessage({
      id: req.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
