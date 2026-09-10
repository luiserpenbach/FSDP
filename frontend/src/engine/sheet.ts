import type { Point, Rect, Sheet, SheetSizeId, Size } from "./types";

/** Paper sizes in mm, landscape (ISO 5457 / ASME Y14.1). */
export const SHEET_SIZES: Record<SheetSizeId, Size & { label: string; columns: number; rows: number }> = {
  A4: { label: "ISO A4", width: 297, height: 210, columns: 4, rows: 2 },
  A3: { label: "ISO A3", width: 420, height: 297, columns: 4, rows: 3 },
  A2: { label: "ISO A2", width: 594, height: 420, columns: 4, rows: 4 },
  A1: { label: "ISO A1", width: 841, height: 594, columns: 6, rows: 5 },
  A0: { label: "ISO A0", width: 1189, height: 841, columns: 8, rows: 8 },
  ANSI_A: { label: "ANSI A", width: 279.4, height: 215.9, columns: 2, rows: 2 },
  ANSI_B: { label: "ANSI B", width: 431.8, height: 279.4, columns: 4, rows: 2 },
  ANSI_C: { label: "ANSI C", width: 558.8, height: 431.8, columns: 4, rows: 4 },
  ANSI_D: { label: "ANSI D", width: 863.6, height: 558.8, columns: 8, rows: 4 },
  ANSI_E: { label: "ANSI E", width: 1117.6, height: 863.6, columns: 8, rows: 8 }
};

export function sheetSize(sheet: Sheet): Size {
  const base = SHEET_SIZES[sheet.size];
  return sheet.orientation === "portrait"
    ? { width: base.height, height: base.width }
    : { width: base.width, height: base.height };
}

export function makeSheet(size: SheetSizeId, orientation: Sheet["orientation"] = "landscape"): Sheet {
  const base = SHEET_SIZES[size];
  const columns = orientation === "portrait" ? base.rows : base.columns;
  const rows = orientation === "portrait" ? base.columns : base.rows;
  return { size, orientation, frame: { kind: "basic", columns, rows, margin: 10 } };
}

/** Drawing area inside the border. */
export function frameRect(sheet: Sheet): Rect {
  const { width, height } = sheetSize(sheet);
  const margin = sheet.frame.kind === "none" ? 0 : sheet.frame.margin;
  return { x: margin, y: margin, width: width - margin * 2, height: height - margin * 2 };
}

const ZONE_LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ";

/**
 * Zone reference for a point, e.g. "D-4". Columns are numbered right to left
 * and rows lettered bottom to top, as on ANSI/ISO frames.
 */
export function zoneAt(sheet: Sheet, point: Point): string | null {
  if (sheet.frame.kind === "none") return null;
  const rect = frameRect(sheet);
  const columns = Math.max(1, sheet.frame.columns);
  const rows = Math.max(1, sheet.frame.rows);
  const fx = (point.x - rect.x) / rect.width;
  const fy = (point.y - rect.y) / rect.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  const column = columns - Math.min(columns - 1, Math.floor(fx * columns));
  const row = rows - 1 - Math.min(rows - 1, Math.floor(fy * rows));
  return `${ZONE_LETTERS[row] ?? "?"}-${column}`;
}

export function zoneLabels(sheet: Sheet): { columns: string[]; rows: string[] } {
  const columns = Array.from({ length: sheet.frame.columns }, (_, index) => String(sheet.frame.columns - index));
  const rows = Array.from({ length: sheet.frame.rows }, (_, index) => ZONE_LETTERS[sheet.frame.rows - 1 - index] ?? "?");
  return { columns, rows };
}
