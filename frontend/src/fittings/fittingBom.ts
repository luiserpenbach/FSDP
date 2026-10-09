/**
 * Working fitting list (a BoM draft) built on the Fitting Selector page.
 * Kept per project in this browser; lines become catalog parts with
 * "Add to catalog", which is how they join the drawing BoM thread.
 */
import { buildFitting, type Fitting, type FittingConfig } from "./swagelok";

export type FittingBomLine = {
  id: string;
  partNumber: string;
  description: string;
  material: string;
  ends: string;
  qty: number;
  /** Where it goes: a tag, a line number, an assembly. */
  location: string;
  note: string;
  config: FittingConfig;
};

const KEY_PREFIX = "fsdp.fittingBom.";

export function bomStorageKey(projectId: string): string {
  return `${KEY_PREFIX}${projectId || "none"}`;
}

export function loadBom(projectId: string): FittingBomLine[] {
  try {
    const raw = localStorage.getItem(bomStorageKey(projectId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLine);
  } catch {
    return [];
  }
}

export function saveBom(projectId: string, lines: FittingBomLine[]): void {
  try {
    localStorage.setItem(bomStorageKey(projectId), JSON.stringify(lines));
  } catch {
    /* storage unavailable: the list lives for this visit only */
  }
}

function isLine(value: unknown): value is FittingBomLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Partial<FittingBomLine>;
  return typeof line.id === "string" && typeof line.partNumber === "string" && typeof line.qty === "number" && !!line.config;
}

export function lineFromFitting(fitting: Fitting, qty: number, id = newLineId()): FittingBomLine {
  return {
    id,
    partNumber: fitting.partNumber,
    description: fitting.description,
    material: fitting.material.short,
    ends: fitting.ends.map((end) => end.label).join(" × "),
    qty,
    location: "",
    note: "",
    config: fitting.config
  };
}

/** Add a fitting; the same ordering number adds to the existing line's quantity. */
export function addToBom(lines: FittingBomLine[], fitting: Fitting, qty: number): FittingBomLine[] {
  const existing = lines.find((line) => line.partNumber === fitting.partNumber);
  if (existing) return lines.map((line) => (line === existing ? { ...line, qty: line.qty + qty } : line));
  return [...lines, lineFromFitting(fitting, qty)];
}

/** The fitting a line was made from (null if the stored config no longer builds). */
export function lineFitting(line: FittingBomLine): Fitting | null {
  return buildFitting(line.config);
}

let counter = 0;
function newLineId(): string {
  counter += 1;
  return `fl-${Date.now().toString(36)}-${counter}`;
}

/** Line and piece counts for the list header. */
export function bomTotals(lines: FittingBomLine[]): { lines: number; pieces: number } {
  return { lines: lines.length, pieces: lines.reduce((sum, line) => sum + line.qty, 0) };
}
