import { describe, expect, it } from "vitest";
import { lineThrough, smallPanelDocument, symbolAt } from "./fixtures";
import { buildSheetIndex, lineLengthM } from "./index";
import { SymbolRegistry } from "./library";
import { LIST_DEFINITIONS, compareTagKeys, listRows, rowsToCsv, tagSortKey } from "./lists";
import { renderDocumentSvg, renderItem } from "./render";
import type { EquipmentItem, LineItem, SymbolItem } from "./types";

const registry = SymbolRegistry.withBuiltins();

function fixture() {
  const doc = smallPanelDocument();
  const hv = doc.items.find((item) => item.id === "hv") as SymbolItem;
  hv.partId = "part-1";
  hv.dnp = true;
  const pt = doc.items.find((item) => item.id === "pt") as SymbolItem;
  pt.spare = 2;
  pt.fields.mounting = "Field";
  const l1 = doc.items.find((item) => item.id === "l1") as LineItem;
  l1.lineNumber = "3101";
  l1.size = '1/4"';
  l1.service = "GHe";
  l1.lineClass = "HE-1";
  l1.designPressure = "2500 psig";
  const l3 = doc.items.find((item) => item.id === "l3") as LineItem;
  l3.physicalLength = 4.5;
  const chamber: EquipmentItem = {
    id: "vc",
    kind: "equipment",
    layer: "equipment",
    position: { x: 250, y: 150 },
    size: { width: 60, height: 40 },
    tag: "VC-1",
    name: "VACUUM CHAMBER",
    boundary: "dashed",
    nozzles: [{ id: "n1", x: 0, y: 20, side: "left", size: '1/2"' }],
    fields: {}
  };
  doc.items.push(chamber);
  doc.items.push(symbolAt("vent", "off_page_connector", { x: 300, y: 60 }, { label: "TO VENT", fields: { ref: "A" } }));
  return doc;
}

describe("sheet index", () => {
  it("indexes symbols, equipment, and lines with zones, connections, and flags", () => {
    const doc = fixture();
    const index = buildSheetIndex(doc, registry, { connectorTargets: { vent: "SHT 2 / D-4" } });
    const byId = new Map(index.items.map((item) => [item.item_id, item]));
    const hv = byId.get("hv")!;
    expect(hv).toMatchObject({ kind: "symbol", category: "valve", symbol_key: "hand_valve", tag: "HV-3201", part_id: "part-1", dnp: true, spare: 0 });
    expect(hv.zone).toMatch(/^[A-Z]-\d$/);
    expect(hv.fields).toMatchObject({ size: '1/4"', service: "GHe", line_number: "3101" });
    const pt = byId.get("pt")!;
    expect(pt).toMatchObject({ category: "instrument", spare: 2, dnp: false, part_id: null });
    expect(pt.fields.mounting).toBe("Field");
    expect(byId.get("vc")).toMatchObject({ kind: "equipment", tag: "VC-1", label: "VACUUM CHAMBER" });
    expect(byId.get("vc")!.fields.nozzle_count).toBe(1);
    expect(byId.get("vent")!.fields).toMatchObject({ ref: "A", target: "SHT 2 / D-4" });

    const lines = new Map(index.lines.map((line) => [line.line_id, line]));
    const l1 = lines.get("l1")!;
    expect(l1).toMatchObject({ line_number: "3101", size: '1/4"', service: "GHe", line_class: "HE-1", design_pressure: "2500 psig", line_type: "process" });
    expect(l1.from_tag).toBe("K-3201");
    expect(l1.to_tag).toBe("HV-3201");
    expect(l1.from_item).toBe("bottle");
    expect(l1.connection_count).toBe(2);
    expect(l1.tee_count).toBe(0);
    expect(l1.length_mm).toBeGreaterThan(0);
    expect(l1.length_m).toBeCloseTo(l1.length_mm / 1000, 2);
    const l4 = lines.get("l4")!; // tees off l3 into the PSV
    expect(l4.from_tag).toBe("tee");
    expect(l4.tee_count).toBe(1);
    expect(l4.connection_count).toBe(1);
    expect(lines.get("l3")!.length_m).toBe(4.5);
  });

  it("estimates physical length from the drawn length and factor", () => {
    const line = lineThrough("x", [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }]);
    expect(lineLengthM(line)).toBe(0.15);
    expect(lineLengthM({ ...line, lengthFactor: 0.01 })).toBe(1.5);
    expect(lineLengthM({ ...line, physicalLength: 2 })).toBe(2);
  });
});

describe("engineering lists", () => {
  it("builds the five lists with shared location columns and natural tag order", () => {
    const doc = fixture();
    const sheets = [{ sheetNo: 1, sheetId: "s1", index: buildSheetIndex(doc, registry) }];
    const parts = (id: string) => (id === "part-1" ? "AMB2-001" : null);
    const valves = listRows("valve", sheets, parts);
    expect(valves.map((row) => row.tag)).toEqual(["HV-3201", "PCV-3202", "PSV-3203"]);
    expect(valves[0]).toMatchObject({ part_number: "AMB2-001", dnp: "DNP", size: '1/4"', line_number: "3101", sheet_no: 1, sheet_id: "s1" });
    expect(listRows("instrument", sheets).map((row) => row.tag)).toEqual(["PT-3204"]);
    expect(listRows("equipment", sheets).map((row) => [row.tag, row.name, row.nozzle_count])).toEqual([["K-3201", "Gas cylinder", null], ["VC-1", "VACUUM CHAMBER", 1]]);
    expect(listRows("tie_in", sheets).map((row) => [row.tag, row.ref])).toEqual([["TO VENT", "A"]]);
    const lines = listRows("line", sheets);
    expect(lines[0].line_number).toBe("3101");
    expect(lines.every((row) => row.zone === null || /^[A-Z]-\d$/.test(String(row.zone)))).toBe(true);
    for (const definition of Object.values(LIST_DEFINITIONS)) {
      expect(definition.columns.slice(-2).map((column) => column.key)).toEqual(["sheet_no", "zone"]);
    }
  });

  it("sorts tags naturally and writes CSV with a header block", () => {
    expect(["PT-10", "HV-2", "HV-10", "K-1", ""].sort((a, b) => compareTagKeys(tagSortKey(a), tagSortKey(b)))).toEqual(["HV-2", "HV-10", "K-1", "PT-10", ""]);
    const csv = rowsToCsv({ drawing_number: "AMB2-9003", title: "P&ID" }, [{ key: "tag", label: "Tag" }, { key: "zone", label: "Zone" }], [
      { item_id: "a", sheet_no: 1, zone: "D-4", tag: "=HV-1" },
      { item_id: "b", sheet_no: 1, zone: null, tag: 'PT "x"' }
    ]);
    expect(csv).toBe('drawing number,AMB2-9003\ntitle,P&ID\n\nTag,Zone\n\'=HV-1,D-4\n"PT ""x""",\n');
  });
});

describe("part badges", () => {
  it("draws badges and DNP markers on canvas but never in exports", () => {
    const doc = fixture();
    const hv = doc.items.find((item) => item.id === "hv") as SymbolItem;
    const withBadge = renderItem(hv, { registry, partBadges: { hv: { text: "AMB2-001", tone: "good" } } });
    expect(withBadge).toContain("part-badge");
    expect(withBadge).toContain(">AMB2-001<");
    expect(withBadge).toContain(">DNP<");
    expect(withBadge).toContain("#15803d");
    const chamber = doc.items.find((item) => item.id === "vc") as EquipmentItem;
    expect(renderItem({ ...chamber, dnp: true }, { registry, partBadges: { vc: { text: "X", tone: "warn" } } })).toContain("part-badge");
    const exported = renderDocumentSvg(doc, registry);
    expect(exported).not.toContain("part-badge");
    expect(exported).toContain(">DNP<");
  });
});
