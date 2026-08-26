// Spreadsheet parsing worker. XLSX/CSV parsing of a large workbook can take
// hundreds of milliseconds to seconds; running it here keeps the main thread
// (typing, chat polls, editor) completely responsive while it happens.
//
// Protocol:
//   → { id: number, buf: ArrayBuffer }
//   ← { id, ok: true, sheets: { name, data }[] } | { id, ok: false, error }
import * as XLSX from "xlsx";

type SheetRow = (string | number | boolean | null)[];

// The worker global's postMessage isn't the Window signature under the DOM lib.
const ctx = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

self.addEventListener("message", async (e: MessageEvent) => {
  const { id, buf } = e.data as { id: number; buf: ArrayBuffer };
  try {
    const wb = XLSX.read(buf, { type: "array" });
    const sheets = wb.SheetNames.map((name) => ({
      name,
      data: XLSX.utils.sheet_to_json<SheetRow>(wb.Sheets[name], {
        header: 1,
        defval: null,
      }),
    }));
    ctx.postMessage({ id, ok: true, sheets });
  } catch (err) {
    ctx.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
