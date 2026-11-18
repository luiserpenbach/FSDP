import { describe, expect, it } from "vitest";
import { deriveSheetData } from "./derived";
import { runEngineRequest, type EngineSheetResult } from "./engineRequest";
import { smallPanelDocument } from "./fixtures";
import { withFrameTemplate } from "./frames";
import { SymbolRegistry } from "./library";
import { PARITY_IDS, parityRequest } from "./parityFixture";
import { computeSheetPayload } from "./sheetPayload";
import { DEFAULT_TAG_SCHEME, normalizeScheme } from "./tags";

function ok(result: EngineSheetResult | undefined): Extract<EngineSheetResult, { ok: true }> {
  if (!result || !result.ok) throw new Error(`expected a computed sheet, got ${JSON.stringify(result)}`);
  return result;
}

describe("computeSheetPayload", () => {
  it("is deriveSheetData behind API-shaped inputs", () => {
    const request = parityRequest();
    const context = request.context!;
    const [first, second] = request.drawings[0].sheets;
    const others = [
      { sheetId: first.sheetId, sheetNo: 1, doc: first.document },
      { sheetId: second.sheetId, sheetNo: 2, doc: second.document }
    ];
    const registry = SymbolRegistry.withBuiltins(context.customSymbols);
    const parts = new Map(context.parts!.map((part) => [part.id, part]));
    const requirements = context.requirements!.map((requirement) => ({ ...requirement, constraint: requirement.constraint ?? null }));
    const expected = deriveSheetData({
      doc: withFrameTemplate(first.document, "fsdp-standard"),
      sheetId: first.sheetId,
      sheetNo: 1,
      otherSheets: others,
      registry,
      tagScheme: normalizeScheme(context.tagScheme),
      parts,
      requirements,
      waivers: first.waivers
    });
    const fromRows = computeSheetPayload({ doc: first.document, sheetId: first.sheetId, sheetNo: 1, frameTemplate: "fsdp-standard", otherSheets: others, customSymbols: context.customSymbols, tagScheme: context.tagScheme, parts: context.parts, requirements: context.requirements, waivers: first.waivers });
    expect(fromRows.payload).toEqual(expected.payload);
    expect(fromRows.doc.sheet.frame.template).toBe("fsdp-standard");
    // The browser passes what it already holds: its registry, part map, and normalised scheme.
    const fromBrowserState = computeSheetPayload({ doc: fromRows.doc, sheetId: first.sheetId, sheetNo: 1, otherSheets: others, registry, tagScheme: normalizeScheme(context.tagScheme), parts, requirements, waivers: first.waivers });
    expect(fromBrowserState.payload).toEqual(expected.payload);
    expect(fromBrowserState.doc).toBe(fromRows.doc);

    // The fixture is worth comparing: custom symbol, part, requirement, connector, and waiver all show up.
    const rows = fromRows.payload.index.items;
    expect(rows.find((row) => row.item_id === "flt")).toMatchObject({ category: "inline", symbol_name: "Inline filter", tag: "F-3205" });
    expect(rows.find((row) => row.item_id === "hv")?.part_id).toBe(PARITY_IDS.partBrass);
    expect(JSON.stringify(rows.find((row) => row.item_id === "conn"))).toContain("SHT 2 /");
    expect(fromRows.payload.index.lines.find((line) => line.line_id === "l5")?.to_tag).toBe("F-3205");
    expect(fromRows.payload.drc.checks.some((check) => check.requirementId === PARITY_IDS.reqMaterial && check.status === "fail")).toBe(true);
    expect(fromRows.drc.waived.map((finding) => finding.key)).toEqual(["duplicate_tag:hv"]);
  });

  it("uses the default tag scheme when the project has none", () => {
    const doc = smallPanelDocument();
    const input = { doc, sheetNo: 1, otherSheets: [] };
    expect(computeSheetPayload({ ...input, tagScheme: null }).payload).toEqual(computeSheetPayload({ ...input, tagScheme: DEFAULT_TAG_SCHEME }).payload);
  });
});

describe("runEngineRequest", () => {
  it("computes each sheet against its drawing's other sheets", () => {
    const request = parityRequest();
    const response = runEngineRequest(request);
    expect(response.results.map((result) => result.sheetId)).toEqual([PARITY_IDS.sheet1, PARITY_IDS.sheet2]);
    const [first, second] = request.drawings[0].sheets;
    const others = [first, second].map((sheet) => ({ sheetId: sheet.sheetId, sheetNo: sheet.sheetNo, doc: sheet.document }));
    const expected = computeSheetPayload({ doc: second.document, sheetId: second.sheetId, sheetNo: 2, frameTemplate: "fsdp-standard", otherSheets: others, ...request.context, tagScheme: request.context?.tagScheme });
    const result = ok(response.results[1]);
    expect({ index: result.index, drc: result.drc }).toEqual(expected.payload);
    expect(result.counts).toEqual(expected.drc.counts);
    expect(result.drc.findings.some((finding) => finding.rule === "duplicate_tag")).toBe(true);
  });

  it("skips context-only sheets and reports a broken sheet without failing the rest", () => {
    const request = parityRequest();
    const [first, second] = request.drawings[0].sheets;
    first.compute = false;
    request.drawings.push({ frameTemplate: "basic", sheets: [{ sheetId: "broken", sheetNo: 1, document: { items: "nope" } as never }] });
    const response = runEngineRequest(request);
    expect(response.results.map((result) => [result.sheetId, result.ok])).toEqual([
      [second.sheetId, true],
      ["broken", false]
    ]);
    expect(response.results[1]).toMatchObject({ error: expect.stringContaining("document") });
  });

  it("rejects a request without drawings", () => {
    expect(() => runEngineRequest({} as never)).toThrow(/drawings/);
  });
});
