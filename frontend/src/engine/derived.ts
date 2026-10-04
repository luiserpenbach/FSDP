/**
 * Derived sheet data stored next to the document: the index rows (lists, BoM,
 * where-used) and the design rule check (findings, waivers, requirement checks).
 *
 * Saving a sheet and re-indexing a stale one in the background both go through
 * `deriveSheetData`, so the stored index and DRC never depend on which path
 * wrote them.
 */
import { computeConnectivity, type Connectivity } from "./connectivity";
import { resolveConnectorTargets, type SheetDoc } from "./connectors";
import { runDrc, type DrcFinding, type DrcResult, type DrcWaiver, type RequirementCheck, type RequirementRef } from "./drc";
import { buildSheetIndex, type SheetIndex } from "./index";
import type { SymbolRegistry } from "./library";
import type { PartLike } from "./parts";
import { tagsOf, type TagScheme } from "./tags";
import type { SchematicDocument } from "./types";

export type SheetDerivedInput = {
  doc: SchematicDocument;
  /** The sheet being indexed; an entry for it in `otherSheets` is ignored. */
  sheetId?: string;
  sheetNo: number;
  /** Stored documents of the drawing's other sheets (connector pairs, reserved tags). */
  otherSheets: SheetDoc[];
  registry: SymbolRegistry;
  /** Reuse the editor's connectivity when it is already computed for `doc`. */
  connectivity?: Connectivity;
  tagScheme: TagScheme;
  parts?: Map<string, PartLike>;
  requirements?: RequirementRef[];
  waivers?: DrcWaiver[];
};

/** A DRC finding as PUT /sheets/{id} stores it (open and waived alike). */
export type StoredFinding = Pick<DrcFinding, "key" | "rule" | "severity" | "message" | "itemId" | "subject" | "zone" | "requirementId">;

export type SheetDerivedPayload = {
  index: SheetIndex;
  drc: { findings: StoredFinding[]; checks: RequirementCheck[] };
};

export type SheetDerived = {
  index: SheetIndex;
  drc: DrcResult;
  /** The `index` and `drc` fields of PUT /sheets/{id}. */
  payload: SheetDerivedPayload;
};

export function deriveSheetData(input: SheetDerivedInput): SheetDerived {
  const { doc, registry, tagScheme } = input;
  const others = input.otherSheets.filter((sheet) => !input.sheetId || sheet.sheetId !== input.sheetId);
  const connectivity = input.connectivity ?? computeConnectivity(doc, registry);
  const connectorTargets = resolveConnectorTargets({ sheetNo: input.sheetNo, doc, sheetId: input.sheetId }, others).targets;
  const index = buildSheetIndex(doc, registry, { connectivity, connectorTargets });
  const drc = runDrc({
    doc,
    registry,
    connectivity,
    tagScheme,
    parts: input.parts,
    requirements: input.requirements,
    waivers: input.waivers,
    // Tags on the drawing's other sheets: a repeat here is a duplicate.
    reservedTags: tagsOf(others.map((sheet) => sheet.doc))
  });
  const findings: StoredFinding[] = [...drc.findings, ...drc.waived].map(({ key, rule, severity, message, itemId, subject, zone, requirementId }) => ({
    key,
    rule,
    severity,
    message,
    itemId,
    subject,
    zone,
    requirementId
  }));
  return { index, drc, payload: { index, drc: { findings, checks: drc.requirementChecks } } };
}
