/**
 * Pure helpers shared by <DataGrid> and reusable on their own:
 * natural ("HV-2 < HV-10") comparison, TSV parse/serialize compatible with
 * Excel / Google Sheets clipboard data, and CSV with formula-injection guard.
 */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Natural, case-insensitive string compare: digit runs compare as numbers,
 * so "HV-2" < "HV-10" and "P-9A" < "P-10". Ties fall back to a plain code-unit
 * compare so the order is total and deterministic.
 */
export function naturalCompare(a: string, b: string): number {
  const primary = collator.compare(a, b);
  if (primary !== 0) return primary;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True for values that count as an empty cell (sorted last, matched by "="). */
export function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (typeof value === "number" && Number.isNaN(value));
}

/** Type-aware compare for non-blank values: numbers, booleans, dates, then natural text. */
export function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return naturalCompare(String(a), String(b));
}

/**
 * Parse clipboard TSV as produced by Excel / Google Sheets / LibreOffice.
 * - Cells separated by TAB, rows by LF, CRLF or CR.
 * - A cell that *starts* with a double quote is quoted: it may contain tabs and
 *   newlines, and `""` is an escaped quote. Quotes elsewhere are literal
 *   (e.g. `2" pipe`). An unterminated quote is treated as literal text.
 * - A single trailing newline (Excel always appends one) does not add a row.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  if (!text) return rows;
  let row: string[] = [];
  let cell = "";
  let atCellStart = true;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (atCellStart && ch === '"') {
      let j = i + 1;
      let quoted = "";
      let closed = false;
      while (j < n) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            quoted += '"';
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        quoted += text[j];
        j += 1;
      }
      atCellStart = false;
      if (closed) {
        cell += quoted;
        i = j;
      } else {
        cell += '"';
        i += 1;
      }
      continue;
    }
    atCellStart = false;
    if (ch === "\t") {
      row.push(cell);
      cell = "";
      atCellStart = true;
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      atCellStart = true;
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (!atCellStart || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function tsvCell(value: string): string {
  if (/[\t\r\n]/.test(value) || value.startsWith('"')) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Serialize a block of cells to TSV that Excel / Sheets paste back cell-for-cell. */
export function toTsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return rows.map((row) => row.map(tsvCell).join("\t")).join("\n");
}

/**
 * Formula-injection guard, identical to the backend's `spreadsheet_safe`:
 * strings starting with = + - @ TAB or CR get a leading apostrophe so a
 * spreadsheet shows them as text instead of evaluating them. Numbers are
 * left alone (a negative number is data, not a formula).
 */
export function spreadsheetSafe(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "number") text = Number.isFinite(value) ? String(value) : "";
  else if (typeof value === "boolean") text = value ? "TRUE" : "FALSE";
  else text = spreadsheetSafe(String(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV (CRLF line ends, trailing CRLF) with the formula-injection guard. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** UTF-8 byte-order mark: lets Excel detect UTF-8 in a CSV. */
const BOM = String.fromCharCode(0xfeff);

/** Trigger a browser download of a text file (UTF-8; CSV gets a BOM so Excel detects UTF-8). */
export function downloadText(filename: string, contents: string, mime = "text/csv;charset=utf-8"): void {
  const blob = new Blob([mime.startsWith("text/csv") ? BOM + contents : contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
