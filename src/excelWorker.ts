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
  postMessage(message: unknown): void;
};

self.addEventListener("message", (event: MessageEvent) => {
  const { id, buf } = event.data as { id: number; buf: ArrayBuffer };
  try {
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
      id,
      ok: true,
      sheets,
      omittedSheets: Math.max(0, workbook.SheetNames.length - MAX_SHEETS),
    });
  } catch (error) {
    ctx.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
