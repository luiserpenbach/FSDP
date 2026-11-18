/**
 * The JSON protocol of the engine CLI (`cli.ts`): one request with a shared
 * project context and the sheets of one or more drawings, one result per sheet.
 * The server (`backend/app/services/server_index.py`) builds the request from
 * the database and stores the results exactly as a browser save would.
 *
 * Pure: no process, DOM, or network access, so the tests call it directly.
 */
import type { PidSymbolDef } from "../types";
import type { SheetDoc } from "./connectors";
import type { SheetDerivedPayload } from "./derived";
import type { DrcSeverity } from "./drc";
import type { PartLike } from "./parts";
import { computeSheetPayload, type RequirementLike } from "./sheetPayload";
import type { SchematicDocument } from "./types";

/** Bumped when the request or result shape changes incompatibly. */
export const ENGINE_PROTOCOL = 1;

export type EngineSheet = {
  sheetId: string;
  sheetNo: number;
  document: SchematicDocument;
  /** Stored waivers of the sheet (matched by finding key). */
  waivers?: Array<{ key: string; reason: string }>;
  /** False for a sheet that is only context for its siblings (connector pairs, reserved tags). */
  compute?: boolean;
};

export type EngineDrawing = {
  /** The drawing's frame template, applied to each computed sheet. */
  frameTemplate?: string | null;
  sheets: EngineSheet[];
};

export type EngineContext = {
  customSymbols?: PidSymbolDef[];
  tagScheme?: unknown;
  parts?: PartLike[];
  requirements?: RequirementLike[];
};

export type EngineRequest = {
  context?: EngineContext;
  drawings: EngineDrawing[];
};

export type EngineSheetResult =
  | ({ sheetId: string; ok: true; counts: Record<DrcSeverity, number> & { waived: number } } & SheetDerivedPayload)
  | { sheetId: string; ok: false; error: string };

export type EngineResponse = { protocol: number; results: EngineSheetResult[] };

function isDocument(value: unknown): value is SchematicDocument {
  const doc = value as Partial<SchematicDocument> | null;
  return Boolean(doc && typeof doc === "object" && Array.isArray(doc.items) && doc.sheet && typeof doc.sheet === "object" && doc.sheet.frame);
}

/** Compute every requested sheet; a sheet that fails reports its error and the rest go on. */
export function runEngineRequest(request: EngineRequest): EngineResponse {
  if (!request || typeof request !== "object" || !Array.isArray(request.drawings)) {
    throw new Error("Request must be an object with a 'drawings' list.");
  }
  const context = request.context ?? {};
  const results: EngineSheetResult[] = [];
  for (const drawing of request.drawings) {
    const sheets = Array.isArray(drawing?.sheets) ? drawing.sheets : [];
    // Siblings with an unusable document cannot be context; their own turn reports the error.
    const siblings: SheetDoc[] = sheets.filter((sheet) => isDocument(sheet?.document)).map((sheet) => ({ sheetId: sheet.sheetId, sheetNo: sheet.sheetNo, doc: sheet.document }));
    for (const sheet of sheets) {
      if (!sheet || sheet.compute === false) continue;
      const sheetId = String(sheet.sheetId);
      try {
        if (!isDocument(sheet.document)) throw new Error("Sheet document has no items or sheet frame.");
        const derived = computeSheetPayload({
          doc: sheet.document,
          sheetId: sheet.sheetId,
          sheetNo: sheet.sheetNo,
          frameTemplate: drawing.frameTemplate,
          otherSheets: siblings,
          customSymbols: context.customSymbols,
          tagScheme: context.tagScheme,
          parts: context.parts,
          requirements: context.requirements,
          waivers: sheet.waivers
        });
        results.push({ sheetId, ok: true, counts: derived.drc.counts, ...derived.payload });
      } catch (error) {
        results.push({ sheetId, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { protocol: ENGINE_PROTOCOL, results };
}
