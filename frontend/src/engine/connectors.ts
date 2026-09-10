/**
 * Off-page connectors: symbols in the "connector" category that carry a
 * `fields.ref` pair id. A connector's caption resolves to the sheet and zone
 * of the matching connector on another sheet (or elsewhere on this sheet).
 */
import { zoneAt } from "./sheet";
import type { SchematicDocument, SymbolItem } from "./types";

export type SheetDoc = { sheetNo: number; doc: SchematicDocument };

export function connectorRef(item: SymbolItem): string | null {
  const ref = item.fields?.ref;
  return typeof ref === "string" && ref.trim() ? ref.trim().toUpperCase() : null;
}

function connectorsOf(doc: SchematicDocument): Array<{ item: SymbolItem; ref: string }> {
  const result: Array<{ item: SymbolItem; ref: string }> = [];
  for (const item of doc.items) {
    if (item.kind !== "symbol") continue;
    const ref = connectorRef(item);
    if (ref) result.push({ item, ref });
  }
  return result;
}

/**
 * Resolve every connector on the current sheet to "SHT n / zone" of its pair.
 * Returns the captions by item id and the ids that have no pair.
 */
export function resolveConnectorTargets(current: SheetDoc, others: SheetDoc[]): { targets: Record<string, string>; unmatched: string[] } {
  const targets: Record<string, string> = {};
  const unmatched: string[] = [];
  const candidates = [
    ...connectorsOf(current.doc).map((entry) => ({ ...entry, sheet: current })),
    ...others.flatMap((sheet) => connectorsOf(sheet.doc).map((entry) => ({ ...entry, sheet })))
  ];
  for (const { item, ref } of connectorsOf(current.doc)) {
    const pair = candidates.find((candidate) => candidate.ref === ref && candidate.item.id !== item.id);
    if (!pair) {
      unmatched.push(item.id);
      continue;
    }
    const zone = zoneAt(pair.sheet.doc.sheet, pair.item.position) ?? "—";
    targets[item.id] = `SHT ${pair.sheet.sheetNo} / ${zone}`;
  }
  return { targets, unmatched };
}
