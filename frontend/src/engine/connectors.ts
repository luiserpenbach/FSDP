/**
 * Off-page connectors: symbols in the "connector" category that carry a
 * `fields.ref` pair id. A connector's caption resolves to the sheet and zone
 * of the matching connector on another sheet (or elsewhere on this sheet).
 */
import { zoneAt } from "./sheet";
import type { SchematicDocument, SymbolItem } from "./types";

export type SheetDoc = { sheetNo: number; doc: SchematicDocument; sheetId?: string };

/**
 * True when `otherSheets` is exactly the set of sibling sheet ids (no missing
 * sheets, no duplicates, no sheets from another drawing). Used before Save /
 * lists write-back so a mid-flight sheet or drawing switch cannot feed stale
 * reserved tags or connector targets into the stored index and DRC.
 */
export function otherSheetsMatchSiblings(otherSheets: readonly SheetDoc[], siblingIds: readonly string[]): boolean {
  if (otherSheets.length !== siblingIds.length) return false;
  const expected = new Set(siblingIds);
  const seen = new Set<string>();
  for (const sheet of otherSheets) {
    if (!sheet.sheetId || !expected.has(sheet.sheetId) || seen.has(sheet.sheetId)) return false;
    seen.add(sheet.sheetId);
  }
  return seen.size === expected.size;
}

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
