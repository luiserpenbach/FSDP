import { describe, expect, it } from "vitest";
import { computeConnectivity } from "./connectivity";
import { Editor } from "./editor";
import { lineThrough, smallPanelDocument, symbolAt } from "./fixtures";
import { SymbolRegistry } from "./library";
import { computeCrossings, fractionAlong, lineEndpoints, lineLegendEntries, pointAlong } from "./lines";
import { pathWithHops, renderDocumentSvg, renderLine } from "./render";
import { DocumentStore } from "./store";
import type { EquipmentItem, LineItem, SymbolItem } from "./types";

const registry = SymbolRegistry.withBuiltins();

describe("line helpers", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 }
  ];

  it("finds points along a polyline and fractions back from points", () => {
    expect(pointAlong(points, 0.25)).toMatchObject({ point: { x: 5, y: 0 }, direction: { x: 1, y: 0 }, segmentIndex: 0 });
    expect(pointAlong(points, 0.75)).toMatchObject({ point: { x: 10, y: 5 }, direction: { x: 0, y: 1 }, segmentIndex: 1 });
    expect(fractionAlong(points, { x: 10, y: 5.4 })).toBeCloseTo(0.77, 2);
    expect(fractionAlong(points, { x: 3, y: 1 })).toBeCloseTo(0.15, 2);
  });

  it("detects crossings between unconnected lines but not tees", () => {
    const horizontal = lineThrough("h", [{ x: 0, y: 50 }, { x: 100, y: 50 }]);
    const vertical = lineThrough("v", [{ x: 40, y: 0 }, { x: 40, y: 100 }]);
    const tee = lineThrough("t", [{ x: 70, y: 50 }, { x: 70, y: 90 }]);
    const crossings = computeCrossings([horizontal, vertical, tee]);
    expect(crossings.get("h")).toEqual([{ x: 40, y: 50 }]);
    expect(crossings.get("v")).toBeUndefined();
    expect(crossings.get("t")).toBeUndefined();
    const path = pathWithHops(horizontal.points, crossings.get("h")!);
    expect(path).toContain("A1.2,1.2");
    expect(path.startsWith("M0,50 L38.8,50")).toBe(true);
  });

  it("describes line endpoints from ports and tees", () => {
    const doc = smallPanelDocument();
    const connectivity = computeConnectivity(doc, registry);
    const l3 = doc.items.find((item) => item.id === "l3") as LineItem;
    expect(lineEndpoints(doc, connectivity, l3)).toEqual({ from: "PCV-3202", to: "PT-3204 (process)" });
    const l4 = doc.items.find((item) => item.id === "l4") as LineItem;
    expect(lineEndpoints(doc, connectivity, l4)).toEqual({ from: "tee", to: "PSV-3203" });
  });

  it("lists line legend entries by type and service", () => {
    const doc = smallPanelDocument();
    (doc.items.find((item) => item.id === "l1") as LineItem).service = "GHe";
    (doc.items.find((item) => item.id === "l2") as LineItem).service = "GHe";
    doc.items.push(lineThrough("s", [{ x: 0, y: 0 }, { x: 5, y: 0 }], { lineType: "signal_electric" }));
    const entries = lineLegendEntries(doc);
    expect(entries[0]).toEqual({ lineType: "process", service: "GHe", count: 2 });
    expect(entries.map((entry) => entry.lineType)).toContain("signal_electric");
  });

  it("renders spec labels and annotations that follow the line", () => {
    const line = lineThrough("x", [{ x: 0, y: 0 }, { x: 100, y: 0 }], {
      size: '1/4"',
      spec: 'ST x .035" WALL',
      lineNumber: "3101",
      annotations: [
        { id: "a", kind: "flow_arrow", at: 0.3 },
        { id: "b", kind: "size_change", at: 0.6, text: '1/4"x1/2"' },
        { id: "c", kind: "spec_break", at: 0.8 },
        { id: "d", kind: "note", at: 0.9, text: "2500/85 PSIG" }
      ]
    });
    const svg = renderLine(line);
    expect(svg).toContain(">1/4&quot; ST x .035&quot; WALL<");
    expect(svg).toContain(">3101<");
    expect(svg).toContain("translate(30 0)");
    expect(svg).toContain("SPEC BREAK");
    expect(svg).toContain("2500/85 PSIG");
    expect(renderLine({ ...line, showSpecLabel: false })).not.toContain("WALL");
  });
});

describe("equipment nozzles and connector references", () => {
  it("exposes nozzles as ports that lines connect to and move with", () => {
    const doc = smallPanelDocument();
    const chamber: EquipmentItem = {
      id: "vc",
      kind: "equipment",
      layer: "equipment",
      position: { x: 250, y: 150 },
      size: { width: 60, height: 40 },
      name: "VACUUM CHAMBER",
      boundary: "dashed",
      nozzles: [{ id: "n1", x: 0, y: 20, side: "left", size: '1/2"' }],
      fields: {}
    };
    doc.items.push(chamber);
    doc.items.push(lineThrough("feed", [{ x: 230, y: 170 }, { x: 250, y: 170 }]));
    const connectivity = computeConnectivity(doc, registry);
    expect(connectivity.danglingEnds.map((end) => end.lineId)).toEqual(["feed"]); // only the free start
    expect(connectivity.portNet.get("vc:n1")).toBeDefined();
    const store = new DocumentStore(doc);
    const editor = new Editor(store, registry);
    editor.select(["vc"]);
    editor.nudgeSelection({ x: 0, y: 10 });
    const feed = store.doc.items.find((item) => item.id === "feed") as LineItem;
    expect(feed.points[feed.points.length - 1]).toEqual({ x: 250, y: 180 });
    expect(renderDocumentSvg(store.doc, registry)).toContain(">1/2&quot;<");
  });

  it("prints resolved sheet references on connectors", () => {
    const doc = smallPanelDocument();
    doc.items.push(symbolAt("c1", "off_page_connector", { x: 300, y: 200 }, { label: "TO VENT", fields: { ref: "A" } }));
    const svg = renderDocumentSvg(doc, registry, { context: { number: "X", title: "", sheetNo: 1, sheetCount: 2, revisions: [], notes: [], connectorTargets: { c1: "SHT 2 / D-4" } } });
    expect(svg).toContain(">SHT 2 / D-4<");
    expect(svg).toContain(">TO VENT<");
  });
});

describe("editor ergonomics", () => {
  function makeEditor() {
    let counter = 0;
    const store = new DocumentStore(smallPanelDocument());
    const editor = new Editor(store, registry, { makeId: () => `n${++counter}` });
    return { store, editor };
  }

  it("aligns and distributes symbols, dragging attached lines along", () => {
    const { editor, store } = makeEditor();
    editor.select(["hv", "pcv", "psv"]); // y = 120, 120, 90
    editor.alignSelection("centerY");
    const ys = ["hv", "pcv", "psv"].map((id) => (store.doc.items.find((item) => item.id === id) as SymbolItem).position.y);
    expect(new Set(ys).size).toBe(1);
    expect(computeConnectivity(store.doc, registry).danglingEnds).toHaveLength(0);
    editor.select(["hv", "pcv", "pt"]); // x = 80, 130, 200
    editor.distributeSelection("x");
    const pcv = store.doc.items.find((item) => item.id === "pcv") as SymbolItem;
    expect(pcv.position.x).toBe(140);
  });

  it("copies and pastes with new ids and re-suggested tags", () => {
    const { editor, store } = makeEditor();
    editor.select(["hv", "l2", "pcv"]);
    expect(editor.copySelection()).toBe(3);
    const pasted = editor.paste();
    expect(pasted).toHaveLength(3);
    const copies = store.doc.items.filter((item) => pasted.includes(item.id));
    const tags = copies.filter((item): item is SymbolItem => item.kind === "symbol").map((item) => item.tag);
    expect(tags).toEqual(["HV-3202", "PCV-3203"]);
    const line = copies.find((item) => item.kind === "line") as LineItem;
    expect(line.points[0]).toEqual({ x: 100, y: 130 });
    editor.paste();
    expect(store.doc.items).toHaveLength(9 + 6);
  });

  it("finds items by tag text and measures distances", () => {
    const { editor } = makeEditor();
    expect(editor.findTag("psv")).toEqual(["psv"]);
    expect(editor.state.selection).toEqual(["psv"]);
    editor.key("m");
    editor.pointerDown({ x: 10.2, y: 10 });
    editor.pointerMove({ x: 40.1, y: 30 });
    expect(editor.state.measure).toEqual({ from: { x: 10, y: 10 }, to: { x: 40, y: 30 }, fixed: false });
    editor.pointerDown({ x: 40, y: 30 });
    editor.pointerMove({ x: 90, y: 90 });
    expect(editor.state.measure).toEqual({ from: { x: 10, y: 10 }, to: { x: 40, y: 30 }, fixed: true });
    editor.key("Escape");
    expect(editor.state.measure).toBeNull();
  });

  it("adds and removes line annotations", () => {
    const { editor, store } = makeEditor();
    editor.addLineAnnotation("l3", { kind: "spec", at: 0.5, text: '1/4" ST' });
    let l3 = store.doc.items.find((item) => item.id === "l3") as LineItem;
    expect(l3.annotations).toHaveLength(1);
    editor.removeLineAnnotation("l3", l3.annotations![0].id);
    l3 = store.doc.items.find((item) => item.id === "l3") as LineItem;
    expect(l3.annotations).toHaveLength(0);
  });
});

describe("off-page connector resolution", () => {
  it("pairs connectors by reference across sheets and reports unmatched ones", async () => {
    const { resolveConnectorTargets } = await import("./connectors");
    const sheet1 = smallPanelDocument();
    sheet1.items.push(symbolAt("out", "off_page_connector", { x: 380, y: 60 }, { label: "TO VENT", fields: { ref: "a" } }));
    sheet1.items.push(symbolAt("lonely", "off_page_connector", { x: 380, y: 100 }, { fields: { ref: "Z" } }));
    const sheet2 = smallPanelDocument();
    sheet2.items = [symbolAt("in", "terminator_in", { x: 30, y: 250 }, { label: "FROM FILL", fields: { ref: "A" } })];
    const resolved = resolveConnectorTargets({ sheetNo: 1, doc: sheet1 }, [{ sheetNo: 2, doc: sheet2 }]);
    expect(resolved.targets).toEqual({ out: "SHT 2 / A-4" });
    expect(resolved.unmatched).toEqual(["lonely"]);
    const back = resolveConnectorTargets({ sheetNo: 2, doc: sheet2 }, [{ sheetNo: 1, doc: sheet1 }]);
    expect(back.targets).toEqual({ in: "SHT 1 / C-1" });
  });
});
