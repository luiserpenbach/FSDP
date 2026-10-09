import { describe, expect, it } from "vitest";
import { computeConnectivity } from "./connectivity";
import { deriveSheetData } from "./derived";
import { smallPanelDocument, symbolAt } from "./fixtures";
import { SymbolRegistry } from "./library";
import { DEFAULT_TAG_SCHEME } from "./tags";

const registry = SymbolRegistry.withBuiltins();

describe("deriveSheetData", () => {
  it("indexes the sheet and runs the DRC against the drawing's other sheets", () => {
    const doc = smallPanelDocument();
    doc.items.push(symbolAt("conn", "off_page_connector", { x: 300, y: 60 }, { fields: { ref: "A" } }));
    const other = smallPanelDocument();
    other.items = [symbolAt("back", "off_page_connector", { x: 40, y: 250 }, { fields: { ref: "A" } }), symbolAt("dup", "hand_valve", { x: 80, y: 80 }, { tag: "HV-3201" })];
    const derived = deriveSheetData({
      doc,
      sheetId: "sh1",
      sheetNo: 1,
      // The sheet's own stored copy is ignored: its tags are not duplicates of themselves.
      otherSheets: [
        { sheetId: "sh1", sheetNo: 1, doc },
        { sheetId: "sh2", sheetNo: 2, doc: other }
      ],
      registry,
      tagScheme: DEFAULT_TAG_SCHEME,
      waivers: [{ key: "duplicate_tag:hv", reason: "spare" }]
    });
    const connector = derived.index.items.find((item) => item.item_id === "conn") as unknown as { fields: { target: string | null } } | undefined;
    expect(JSON.stringify(connector)).toContain("SHT 2 /");
    const duplicates = [...derived.drc.findings, ...derived.drc.waived].filter((finding) => finding.rule === "duplicate_tag");
    expect(duplicates.map((finding) => finding.subject)).toEqual(["HV-3201"]);
    // Open and waived findings are both stored, in the server's shape.
    const waivedKey = duplicates[0].key;
    expect(derived.drc.findings.map((finding) => finding.key)).not.toContain(waivedKey);
    expect(derived.payload.drc.findings.map((finding) => finding.key)).toContain(waivedKey);
    expect(Object.keys(derived.payload.drc.findings[0]).sort()).toEqual(["itemId", "key", "message", "requirementId", "rule", "severity", "subject", "zone"]);
    expect(derived.payload.index).toBe(derived.index);
  });

  it("gives the same result with or without a precomputed connectivity", () => {
    const doc = smallPanelDocument();
    const input = { doc, sheetNo: 1, otherSheets: [], registry, tagScheme: DEFAULT_TAG_SCHEME };
    expect(deriveSheetData({ ...input, connectivity: computeConnectivity(doc, registry) }).payload).toEqual(deriveSheetData(input).payload);
  });
});
