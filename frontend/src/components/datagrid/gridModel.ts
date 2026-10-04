/**
 * Column-level model helpers for <DataGrid>: read/write/parse/format a cell by
 * column type, and the memoizable sort + filter pipeline. Pure functions.
 */
import type { DataGridColumn, DataGridColumnType, DataGridFilter, DataGridSort } from "./types";
import { compareValues, isBlank, naturalCompare } from "./utils";

export function columnType<T>(column: DataGridColumn<T>): DataGridColumnType {
  return column.type ?? "text";
}

const DEFAULT_WIDTH: Record<DataGridColumnType, number> = {
  text: 180,
  number: 110,
  enum: 140,
  boolean: 90,
  date: 120
};

export function defaultWidth<T>(column: DataGridColumn<T>): number {
  return column.width ?? DEFAULT_WIDTH[columnType(column)];
}

export function minWidth<T>(column: DataGridColumn<T>): number {
  return column.minWidth ?? 48;
}

export function columnAlign<T>(column: DataGridColumn<T>): "left" | "center" | "right" {
  if (column.align) return column.align;
  const type = columnType(column);
  if (type === "number") return "right";
  if (type === "boolean") return "center";
  return "left";
}

export function optionList<T>(column: DataGridColumn<T>): Array<{ value: string; label: string }> {
  return (column.options ?? []).map((option) => (typeof option === "string" ? { value: option, label: option } : option));
}

export function cellValue<T>(column: DataGridColumn<T>, row: T): unknown {
  return column.getValue ? column.getValue(row) : (row as Record<string, unknown>)[column.key];
}

export function withCellValue<T>(column: DataGridColumn<T>, row: T, value: unknown): T {
  if (column.setValue) return column.setValue(row, value);
  return { ...(row as object), [column.key]: value } as T;
}

export function isCellEditable<T>(column: DataGridColumn<T>, row: T): boolean {
  const editable = column.editable;
  if (typeof editable === "function") return editable(row);
  return Boolean(editable);
}

function formatDefault<T>(column: DataGridColumn<T>, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (columnType(column) === "enum") {
    const match = optionList(column).find((option) => option.value === String(value));
    if (match) return match.label;
  }
  return String(value);
}

/** Text shown/copied/exported for a cell. */
export function cellText<T>(column: DataGridColumn<T>, row: T, value: unknown = cellValue(column, row)): string {
  return column.format ? column.format(value, row) : formatDefault(column, value);
}

/** Initial editor text for a cell (enum editors work on the raw value). */
export function editText<T>(column: DataGridColumn<T>, row: T): string {
  const value = cellValue(column, row);
  if (columnType(column) === "enum") return value === null || value === undefined ? "" : String(value);
  return cellText(column, row, value);
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "x", "on", "✓", "✔"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "off", ""]);

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function parseDefault<T>(column: DataGridColumn<T>, text: string): unknown {
  const type = columnType(column);
  const trimmed = text.trim();
  switch (type) {
    case "text":
      return text;
    case "number": {
      if (trimmed === "") return null;
      const normalized = trimmed.replace(/[,\s]/g, "");
      const value = Number(normalized);
      if (!Number.isFinite(value) || normalized === "") throw new Error(`"${trimmed}" is not a number`);
      return value;
    }
    case "boolean": {
      const lower = trimmed.toLowerCase();
      if (TRUE_WORDS.has(lower)) return true;
      if (FALSE_WORDS.has(lower)) return false;
      throw new Error(`"${trimmed}" is not yes/no`);
    }
    case "enum": {
      if (trimmed === "") return null;
      const options = optionList(column);
      const exact = options.find((option) => option.value === trimmed);
      if (exact) return exact.value;
      const lower = trimmed.toLowerCase();
      const loose = options.find((option) => option.value.toLowerCase() === lower || option.label.toLowerCase() === lower);
      if (loose) return loose.value;
      if (options.length === 0) return trimmed;
      throw new Error(`"${trimmed}" is not one of: ${options.map((option) => option.label).join(", ")}`);
    }
    case "date": {
      if (trimmed === "") return null;
      const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
      if (iso) {
        const date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
        if (date.getMonth() === Number(iso[2]) - 1 && date.getDate() === Number(iso[3])) return trimmed;
        throw new Error(`"${trimmed}" is not a valid date`);
      }
      const parsed = new Date(trimmed);
      if (Number.isNaN(parsed.getTime())) throw new Error(`"${trimmed}" is not a date (use YYYY-MM-DD)`);
      return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
    }
  }
}

/** Text -> value for a column. Throws Error with a user-facing message when invalid. */
export function parseCellText<T>(column: DataGridColumn<T>, text: string, row: T): unknown {
  return column.parse ? column.parse(text, row) : parseDefault(column, text);
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (isBlank(a) && isBlank(b)) return true;
  return false;
}

function sortValue<T>(column: DataGridColumn<T>, row: T): unknown {
  if (column.sortValue) return column.sortValue(row);
  const value = cellValue(column, row);
  if (columnType(column) === "enum" && !isBlank(value)) return cellText(column, row, value);
  return value;
}

/** Stable multi-key sort; blanks always sort last regardless of direction (Excel behaviour). */
export function sortRows<T>(rows: ReadonlyArray<T>, columns: ReadonlyArray<DataGridColumn<T>>, sort: ReadonlyArray<DataGridSort>): T[] {
  const keys = sort
    .map((entry) => ({ column: columns.find((column) => column.key === entry.key), sign: entry.dir === "desc" ? -1 : 1 }))
    .filter((entry): entry is { column: DataGridColumn<T>; sign: number } => entry.column !== undefined);
  if (keys.length === 0) return rows.slice();
  const decorated = rows.map((row, index) => ({ row, index, values: keys.map((key) => sortValue(key.column, row)) }));
  decorated.sort((a, b) => {
    for (let k = 0; k < keys.length; k += 1) {
      const va = a.values[k];
      const vb = b.values[k];
      const blankA = isBlank(va);
      const blankB = isBlank(vb);
      if (blankA && blankB) continue;
      if (blankA) return 1;
      if (blankB) return -1;
      const result = compareValues(va, vb) * keys[k].sign;
      if (result !== 0) return result;
    }
    return a.index - b.index;
  });
  return decorated.map((entry) => entry.row);
}

/** Key a value under for set (multi-select) filters. */
export function setFilterKey(value: unknown): string {
  if (isBlank(value)) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function setFilterOptions<T>(column: DataGridColumn<T>): Array<{ value: string; label: string }> {
  if (columnType(column) === "boolean")
    return [
      { value: "true", label: "Yes" },
      { value: "false", label: "No" }
    ];
  return [...optionList(column), { value: "", label: "(Blanks)" }];
}

export function usesSetFilter<T>(column: DataGridColumn<T>): boolean {
  const type = columnType(column);
  return type === "boolean" || (type === "enum" && optionList(column).length > 0);
}

const OPERATOR = /^(>=|<=|<>|!=|>|<|=)\s*(.*)$/;
const RANGE = /^(-?\d*\.?\d+)\s*\.\.\s*(-?\d*\.?\d+)$/;

/**
 * Compile a column filter into a row predicate. Text filters are
 * case-insensitive "contains" and also accept `=x` (exact), `!=x`, `>x`,
 * `<=x` (numeric on number columns, natural order otherwise), `a..b` (number
 * range), `=` (blank) and `!=` (not blank).
 */
export function compileFilter<T>(column: DataGridColumn<T>, filter: DataGridFilter): ((row: T) => boolean) | null {
  if (filter.kind === "set") {
    const allowed = new Set(filter.values);
    return (row) => allowed.has(setFilterKey(cellValue(column, row)));
  }
  const expr = filter.text.trim();
  if (!expr) return null;
  const isNumber = columnType(column) === "number";
  const range = isNumber ? RANGE.exec(expr) : null;
  if (range) {
    const lo = Math.min(Number(range[1]), Number(range[2]));
    const hi = Math.max(Number(range[1]), Number(range[2]));
    return (row) => {
      const value = cellValue(column, row);
      return typeof value === "number" && value >= lo && value <= hi;
    };
  }
  const op = OPERATOR.exec(expr);
  if (op) {
    const operator = op[1];
    const operand = op[2].trim();
    if (operand === "") {
      if (operator === "=") return (row) => isBlank(cellValue(column, row));
      if (operator === "!=" || operator === "<>") return (row) => !isBlank(cellValue(column, row));
      return null;
    }
    const operandNumber = Number(operand.replace(/,/g, ""));
    const lowerOperand = operand.toLowerCase();
    return (row) => {
      const value = cellValue(column, row);
      if (isBlank(value)) return operator === "!=" || operator === "<>";
      let cmp: number;
      if (isNumber) {
        if (typeof value !== "number" || Number.isNaN(operandNumber)) return false;
        cmp = value - operandNumber;
      } else {
        const text = cellText(column, row, value).toLowerCase();
        cmp = operator === "=" || operator === "!=" || operator === "<>" ? (text === lowerOperand ? 0 : 1) : naturalCompare(text, lowerOperand);
      }
      switch (operator) {
        case "=":
          return cmp === 0;
        case "!=":
        case "<>":
          return cmp !== 0;
        case ">":
          return cmp > 0;
        case ">=":
          return cmp >= 0;
        case "<":
          return cmp < 0;
        default:
          return cmp <= 0;
      }
    };
  }
  const needle = expr.toLowerCase();
  return (row) => cellText(column, row).toLowerCase().includes(needle);
}

/** Apply per-column filters and the quick filter (every whitespace token must appear in some visible cell). */
export function filterRows<T>(
  rows: ReadonlyArray<T>,
  columns: ReadonlyArray<DataGridColumn<T>>,
  visibleColumns: ReadonlyArray<DataGridColumn<T>>,
  filters: Readonly<Record<string, DataGridFilter>>,
  quickFilter: string
): T[] {
  const predicates: Array<(row: T) => boolean> = [];
  for (const [key, filter] of Object.entries(filters)) {
    const column = columns.find((candidate) => candidate.key === key);
    if (!column) continue;
    const predicate = compileFilter(column, filter);
    if (predicate) predicates.push(predicate);
  }
  const tokens = quickFilter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (predicates.length === 0 && tokens.length === 0) return rows.slice();
  return rows.filter((row) => {
    for (const predicate of predicates) if (!predicate(row)) return false;
    if (tokens.length === 0) return true;
    const haystack = visibleColumns.map((column) => cellText(column, row).toLowerCase()).join("\u0001");
    return tokens.every((token) => haystack.includes(token));
  });
}

export function isFilterActive(filter: DataGridFilter | undefined): boolean {
  if (!filter) return false;
  return filter.kind === "set" ? true : filter.text.trim() !== "";
}
