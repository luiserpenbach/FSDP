/**
 * The stored index and DRC of a sheet, computed from plain data.
 *
 * `computeSheetPayload` is the one entry point for everything that writes a
 * sheet's derived data: the browser's save and background re-index, and the
 * server, which runs this same module under Node (`cli.ts`, bundled by
 * `npm run build:engine`). It only adapts API-shaped inputs (custom symbol
 * rows, the raw tag scheme, part and requirement rows, the drawing's frame
 * template) and delegates to `deriveSheetData`, so the two cannot drift.
 *
 * Nothing here touches the DOM. Custom symbols need a DOM parser only to
 * sanitize their SVG markup for painting (`sanitizeSvgInner` returns "" without
 * one); the index and the DRC read their ports, category, tag prefix, and size,
 * which come from the stored rows.
 */
import type { PidSymbolDef } from "../types";
import type { Connectivity } from "./connectivity";
import type { SheetDoc } from "./connectors";
import { deriveSheetData, type SheetDerived } from "./derived";
import type { DrcWaiver, RequirementConstraint, RequirementRef } from "./drc";
import { withFrameTemplate } from "./frames";
import { SymbolRegistry } from "./library";
import type { PartLike } from "./parts";
import { normalizeScheme } from "./tags";
import type { SchematicDocument } from "./types";

/** A requirement row as the API serves it (only the fields the DRC reads). */
export type RequirementLike = { id: string; key: string; title: string; constraint?: RequirementConstraint | null };

export type SheetPayloadInput = {
  /** The sheet's document, as stored or as edited. */
  doc: SchematicDocument;
  /** The sheet being indexed; an entry for it in `otherSheets` is ignored. */
  sheetId?: string;
  sheetNo: number;
  /**
   * The drawing's frame template. The drawing owns it, so a stored document is
   * indexed with it applied (zones depend on the frame); omit it for a document
   * the editor already holds with its frame.
   */
  frameTemplate?: string | null;
  /** Stored documents of the drawing's sheets (connector pairs, reserved tags). */
  otherSheets: SheetDoc[];
  /** Custom symbol rows from `/symbols`; ignored when `registry` is given. */
  customSymbols?: PidSymbolDef[];
  /** A registry already built from the same rows (the browser memoises one). */
  registry?: SymbolRegistry;
  /** The project's tag scheme as stored (`null` or partial: defaults apply). */
  tagScheme: unknown;
  /** Catalog parts; only those the document assigns are read. */
  parts?: PartLike[] | Map<string, PartLike>;
  requirements?: RequirementLike[];
  waivers?: DrcWaiver[];
  /** The editor's connectivity for `doc`, when it is already computed. */
  connectivity?: Connectivity;
};

export type SheetPayload = SheetDerived & {
  /** The document that was indexed (`doc` with the frame template applied). */
  doc: SchematicDocument;
};

export function computeSheetPayload(input: SheetPayloadInput): SheetPayload {
  const doc = input.frameTemplate != null ? withFrameTemplate(input.doc, input.frameTemplate) : input.doc;
  const parts = input.parts instanceof Map ? input.parts : new Map((input.parts ?? []).map((part) => [part.id, part]));
  const requirements: RequirementRef[] = (input.requirements ?? []).map((requirement) => ({
    id: requirement.id,
    key: requirement.key,
    title: requirement.title,
    constraint: requirement.constraint ?? null
  }));
  const derived = deriveSheetData({
    doc,
    sheetId: input.sheetId,
    sheetNo: input.sheetNo,
    otherSheets: input.otherSheets,
    registry: input.registry ?? SymbolRegistry.withBuiltins(input.customSymbols ?? []),
    connectivity: input.connectivity,
    tagScheme: normalizeScheme(input.tagScheme),
    parts,
    requirements,
    waivers: input.waivers
  });
  return { ...derived, doc };
}
