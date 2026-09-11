/**
 * Engineering lists over sheet indexes: instrument index, line list, valve
 * list, equipment list, tie-in list. Column sets mirror the server's list
 * generators (`services/lists.py`) so the drawer and the CSV/XLSX exports
 * show the same rows.
 */
import type { SheetIndex, SheetIndexItem, SheetIndexLine } from "./index";

export type ListKind = "instrument" | "line" | "valve" | "equipment" | "tie_in";

export type ListColumn = { key: string; label: string };

export type ListDefinition = { kind: ListKind; title: string; source: "items" | "lines"; columns: ListColumn[] };

export type ListRow = Record<string, string | number | boolean | null> & { item_id: string; sheet_no: number; zone: string | null };

const LOCATION: ListColumn[] = [
  { key: "sheet_no", label: "Sheet" },
  { key: "zone", label: "Zone" }
];

export const LIST_DEFINITIONS: Record<ListKind, ListDefinition> = {
  instrument: {
    kind: "instrument",
    title: "Instrument index",
    source: "items",
    columns: [
      { key: "tag", label: "Tag" },
      { key: "symbol_name", label: "Type" },
      { key: "service", label: "Service" },
      { key: "line_number", label: "Line" },
      { key: "size", label: "Size" },
      { key: "mounting", label: "Mounting" },
      { key: "part_number", label: "Part" },
      { key: "dnp", label: "DNP" },
      { key: "notes", label: "Notes" },
      ...LOCATION
    ]
  },
  line: {
    kind: "line",
    title: "Line list",
    source: "lines",
    columns: [
      { key: "line_number", label: "Line" },
      { key: "service", label: "Service" },
      { key: "line_type", label: "Type" },
      { key: "size", label: "Size" },
      { key: "spec", label: "Spec" },
      { key: "line_class", label: "Class" },
      { key: "from_tag", label: "From" },
      { key: "to_tag", label: "To" },
      { key: "design_pressure", label: "Design P" },
      { key: "design_temperature", label: "Design T" },
      { key: "operating_pressure", label: "Oper. P" },
      { key: "operating_temperature", label: "Oper. T" },
      { key: "insulation", label: "Insulation" },
      { key: "tracing", label: "Tracing" },
      { key: "length_m", label: "Length (m)" },
      ...LOCATION
    ]
  },
  valve: {
    kind: "valve",
    title: "Valve list",
    source: "items",
    columns: [
      { key: "tag", label: "Tag" },
      { key: "symbol_name", label: "Type" },
      { key: "actuator", label: "Actuator" },
      { key: "size", label: "Size" },
      { key: "service", label: "Service" },
      { key: "line_number", label: "Line" },
      { key: "part_number", label: "Part" },
      { key: "dnp", label: "DNP" },
      { key: "notes", label: "Notes" },
      ...LOCATION
    ]
  },
  equipment: {
    kind: "equipment",
    title: "Equipment list",
    source: "items",
    columns: [
      { key: "tag", label: "Tag" },
      { key: "name", label: "Name" },
      { key: "symbol_name", label: "Type" },
      { key: "nozzle_count", label: "Nozzles" },
      { key: "part_number", label: "Part" },
      { key: "notes", label: "Notes" },
      ...LOCATION
    ]
  },
  tie_in: {
    kind: "tie_in",
    title: "Tie-in list",
    source: "items",
    columns: [
      { key: "tag", label: "Tag" },
      { key: "symbol_name", label: "Type" },
      { key: "ref", label: "Reference" },
      { key: "target", label: "Continues on" },
      { key: "service", label: "Service" },
      { key: "line_number", label: "Line" },
      { key: "size", label: "Size" },
      { key: "notes", label: "Notes" },
      ...LOCATION
    ]
  }
};

export const LIST_KINDS: ListKind[] = ["instrument", "line", "valve", "equipment", "tie_in"];

const VALVE_CATEGORIES = new Set(["valve", "regulator"]);

export function itemInList(kind: ListKind, item: SheetIndexItem): boolean {
  const category = item.category ?? "";
  switch (kind) {
    case "instrument":
      return category === "instrument";
    case "valve":
      return VALVE_CATEGORIES.has(category);
    case "equipment":
      return item.kind === "equipment" || category === "equipment";
    case "tie_in":
      return category === "connector";
    default:
      return false;
  }
}

/** Natural tag order: letters, then number, then the rest. */
export function tagSortKey(value: string | null | undefined): [number, string, number, string] {
  const text = (value ?? "").toUpperCase();
  const match = /^([A-Z]*)[\s\-_]*(\d*)(.*)$/.exec(text);
  if (!match) return [1, text, 0, ""];
  const [, letters, digits, rest] = match;
  return [letters || digits ? 0 : 1, letters, digits ? Number(digits) : 0, rest];
}

export function compareTagKeys(a: ReturnType<typeof tagSortKey>, b: ReturnType<typeof tagSortKey>): number {
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === right) continue;
    return left < right ? -1 : 1;
  }
  return 0;
}

export type IndexedSheet = { sheetNo: number; sheetId?: string; index: SheetIndex };

export type PartLookup = (partId: string) => string | null | undefined;

function stringField(item: SheetIndexItem, key: string): string | null {
  const value = item.fields[key];
  return value === undefined || value === null || value === "" ? null : String(value);
}

function itemRow(item: SheetIndexItem, sheet: IndexedSheet, partNumber: PartLookup): ListRow {
  return {
    item_id: item.item_id,
    sheet_no: sheet.sheetNo,
    sheet_id: sheet.sheetId ?? null,
    zone: item.zone,
    kind: item.kind,
    category: item.category,
    tag: item.tag ?? item.label,
    name: item.label ?? item.symbol_name,
    symbol_name: item.symbol_name,
    part_id: item.part_id,
    part_number: item.part_id ? (partNumber(item.part_id) ?? null) : null,
    dnp: item.dnp ? "DNP" : "",
    spare: item.spare,
    service: stringField(item, "service"),
    line_number: stringField(item, "line_number"),
    size: stringField(item, "size"),
    actuator: stringField(item, "actuator"),
    mounting: stringField(item, "mounting"),
    nozzle_count: typeof item.fields.nozzle_count === "number" ? item.fields.nozzle_count : null,
    ref: stringField(item, "ref"),
    target: stringField(item, "target"),
    notes: stringField(item, "notes")
  };
}

function lineRow(line: SheetIndexLine, sheet: IndexedSheet): ListRow {
  return {
    item_id: line.line_id,
    sheet_no: sheet.sheetNo,
    sheet_id: sheet.sheetId ?? null,
    zone: line.zone,
    kind: "line",
    line_number: line.line_number,
    service: line.service,
    line_type: line.line_type,
    size: line.size,
    spec: line.spec,
    line_class: line.line_class,
    from_item: line.from_item,
    from_tag: line.from_tag,
    to_item: line.to_item,
    to_tag: line.to_tag,
    length_mm: line.length_mm,
    length_m: line.length_m,
    connection_count: line.connection_count,
    tee_count: line.tee_count,
    design_pressure: line.design_pressure,
    design_temperature: line.design_temperature,
    operating_pressure: line.operating_pressure,
    operating_temperature: line.operating_temperature,
    insulation: line.insulation,
    tracing: line.tracing
  };
}

/** Rows of a list across the given sheets, in natural tag / line number order. */
export function listRows(kind: ListKind, sheets: IndexedSheet[], partNumber: PartLookup = () => null): ListRow[] {
  const definition = LIST_DEFINITIONS[kind];
  const rows: ListRow[] = [];
  for (const sheet of sheets) {
    if (definition.source === "lines") {
      for (const line of sheet.index.lines) rows.push(lineRow(line, sheet));
    } else {
      for (const item of sheet.index.items) if (itemInList(kind, item)) rows.push(itemRow(item, sheet, partNumber));
    }
  }
  const sortKey = definition.source === "lines" ? "line_number" : "tag";
  return rows.sort((a, b) => compareTagKeys(tagSortKey(a[sortKey] as string | null), tagSortKey(b[sortKey] as string | null)) || a.sheet_no - b.sheet_no);
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "number" ? String(Math.round(value * 1000) / 1000) : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV with header rows (drawing number, title, ...) before the column row. */
export function rowsToCsv(header: Record<string, string | number>, columns: ListColumn[], rows: ListRow[]): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(header)) lines.push(`${csvCell(key.replace(/_/g, " "))},${csvCell(value)}`);
  lines.push("");
  lines.push(columns.map((column) => csvCell(column.label)).join(","));
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column.key])).join(","));
  return `${lines.join("\n")}\n`;
}
