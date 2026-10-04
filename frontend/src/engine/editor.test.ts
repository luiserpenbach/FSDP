import { describe, expect, it } from "vitest";
import { computeConnectivity } from "./connectivity";
import { dragSegment } from "./edit";
import { Editor } from "./editor";
import { smallPanelDocument } from "./fixtures";
import { BUILTIN_LIBRARY, SymbolRegistry } from "./library";
import { DocumentStore } from "./store";
import { REFERENCE_TAG_SCHEME } from "./tags";
import type { LineItem, SymbolItem } from "./types";

const registry = SymbolRegistry.withBuiltins();

function makeEditor() {
  let counter = 0;
  const store = new DocumentStore(smallPanelDocument());
  const editor = new Editor(store, registry, { makeId: () => `new${++counter}` });
  return { store, editor };
}

describe("editor session", () => {
  it("places a symbol on the grid with a suggested tag and keeps placing", () => {
    const { editor, store } = makeEditor();
    editor.startPlacing({ library: BUILTIN_LIBRARY, key: "hand_valve", version: 1 });
    editor.rotateSelection();
    editor.pointerMove({ x: 251.3, y: 199.2 });
    expect(editor.ghostSymbol()).toMatchObject({ position: { x: 252.5, y: 200 }, rotation: 90 });
    editor.pointerDown({ x: 251.3, y: 199.2 });
    const placed = store.doc.items.find((item) => item.id === "new1") as SymbolItem;
    expect(placed).toMatchObject({ kind: "symbol", position: { x: 252.5, y: 200 }, rotation: 90, tag: "HV-3202" });
    expect(editor.state.tool).toBe("place");
    editor.key("Escape");
    expect(editor.state.tool).toBe("select");
  });

  it("draws a wire from a port to a line as a tee and derives the junction", () => {
    const { editor, store } = makeEditor();
    editor.setTool("wire");
    // Start on the relief valve vent port (170, 80).
    editor.pointerMove({ x: 170.4, y: 79.6 });
    expect(editor.state.snap?.kind).toBe("port");
    editor.pointerDown({ x: 170.4, y: 79.6 });
    expect(editor.state.wire?.points).toEqual([{ x: 170, y: 80 }]);
    // Head up and left, then land on line l1's vertical run at x = 40 (y between 120 and 137.5).
    editor.pointerMove({ x: 170, y: 60 });
    editor.pointerDown({ x: 170, y: 60 });
    editor.pointerMove({ x: 40.3, y: 60 });
    expect(editor.wirePreview()).toEqual([
      { x: 170, y: 80 },
      { x: 170, y: 60 },
      { x: 40, y: 60 }
    ]);
    editor.key(" ");
    editor.pointerDown({ x: 40, y: 60 });
    editor.pointerMove({ x: 40.6, y: 129 });
    expect(editor.state.snap).toMatchObject({ kind: "segment", lineId: "l1" });
    editor.pointerDown({ x: 40.6, y: 129 });
    const line = store.doc.items.find((item) => item.id === "new1") as LineItem;
    expect(line.kind).toBe("line");
    expect(line.points[0]).toEqual({ x: 170, y: 80 });
    expect(line.points[line.points.length - 1]).toEqual({ x: 40, y: 130 });
    expect(editor.state.wire).toBeNull();
    const connectivity = computeConnectivity(store.doc, registry);
    expect(connectivity.danglingEnds).toHaveLength(0);
    expect(connectivity.junctions).toContainEqual({ x: 40, y: 130 });
    expect(connectivity.nets.find((net) => net.lineIds.includes("new1"))?.lineIds.sort()).toEqual(["l1", "new1"]);
  });

  it("picks signal line type when the wire starts on a signal port", () => {
    const { editor, store } = makeEditor();
    editor.setTool("wire");
    editor.pointerMove({ x: 205, y: 100 }); // pt.signal_right
    editor.pointerDown({ x: 205, y: 100 });
    editor.pointerMove({ x: 240, y: 100 });
    editor.pointerDown({ x: 240, y: 100 });
    editor.key("Enter");
    const line = store.doc.items.find((item) => item.id === "new1") as LineItem;
    expect(line.lineType).toBe("signal_electric");
    expect(line.layer).toBe("signal");
  });

  it("selects, drags with rubber-band lines, and undoes as one step", () => {
    const { editor, store } = makeEditor();
    editor.pointerDown({ x: 130, y: 120 }); // regulator body
    expect(editor.state.selection).toEqual(["pcv"]);
    editor.pointerMove({ x: 131, y: 121 });
    editor.pointerMove({ x: 130, y: 131 });
    editor.pointerUp({ x: 130, y: 131 });
    const pcv = store.doc.items.find((item) => item.id === "pcv") as SymbolItem;
    expect(pcv.position).toEqual({ x: 130, y: 130 });
    expect(computeConnectivity(store.doc, registry).danglingEnds).toHaveLength(0);
    expect(store.undo()).toBe(true);
    expect((store.doc.items.find((item) => item.id === "pcv") as SymbolItem).position).toEqual({ x: 130, y: 120 });
    expect(store.canUndo).toBe(false);
  });

  it("window-selects contained items left-to-right and crossing items right-to-left", () => {
    const { editor } = makeEditor();
    editor.pointerDown({ x: 60, y: 100 });
    editor.pointerMove({ x: 100, y: 140 });
    editor.pointerUp({ x: 100, y: 140 });
    expect(editor.state.selection).toEqual(["hv"]);
    editor.pointerDown({ x: 100, y: 100 });
    editor.pointerMove({ x: 60, y: 140 });
    editor.pointerUp({ x: 60, y: 140 });
    expect(editor.state.selection.sort()).toEqual(["hv", "l1", "l2"]);
  });

  it("slides a selected line segment perpendicular to itself", () => {
    const { editor, store } = makeEditor();
    editor.select(["l3"]);
    editor.pointerDown({ x: 170, y: 120 }); // middle segment of l3 (140,120)->(200,120)
    expect(editor.state.drag?.kind).toBe("segment");
    editor.pointerMove({ x: 170, y: 134.6 });
    editor.pointerUp({ x: 170, y: 134.6 });
    const l3 = store.doc.items.find((item) => item.id === "l3") as LineItem;
    expect(l3.points).toEqual([
      { x: 140, y: 120 },
      { x: 140, y: 135 },
      { x: 200, y: 135 },
      { x: 200, y: 105 }
    ]);
  });

  it("handles keyboard commands", () => {
    const { editor, store } = makeEditor();
    editor.select(["pt"]);
    editor.key("ArrowRight");
    expect((store.doc.items.find((item) => item.id === "pt") as SymbolItem).position.x).toBe(202.5);
    editor.key("d", { ctrl: true });
    expect(store.doc.items.some((item) => item.id === "new1")).toBe(true);
    editor.key("Delete");
    expect(store.doc.items.some((item) => item.id === "new1")).toBe(false);
    editor.key("w");
    expect(editor.state.tool).toBe("wire");
    editor.key("Escape");
    expect(editor.state.tool).toBe("select");
  });
});

describe("editor tags and shortcuts", () => {
  it("suggests tags that skip those reserved on other sheets", () => {
    const { editor, store } = makeEditor();
    editor.setReservedTags(["HV-3202", "HV-3205"]);
    const placed = editor.addSymbolAt({ library: BUILTIN_LIBRARY, key: "hand_valve", version: 1 }, { x: 250, y: 200 });
    expect(placed.tag).toBe("HV-3206");
    const constructed = new Editor(new DocumentStore(store.doc), registry, { reservedTags: ["HV-3210"] });
    expect(constructed.suggestTagFor("HV")).toBe("HV-3211");
  });

  it("pastes a structured tag into its own system and class", () => {
    let counter = 0;
    const doc = smallPanelDocument();
    (doc.items[1] as SymbolItem).tag = "PT 3222"; // helium, test hardware
    (doc.items[2] as SymbolItem).tag = "PT 0101"; // vacuum, facility hardware
    const store = new DocumentStore(doc);
    const editor = new Editor(store, registry, { makeId: () => `new${++counter}`, tagScheme: REFERENCE_TAG_SCHEME });
    editor.setTagContext({ system: "0", cls: "1" });
    editor.setReservedTags(["PT 3223"]);
    editor.select(["hv"]);
    editor.copySelection();
    const [pasted] = editor.paste();
    expect((store.doc.items.find((item) => item.id === pasted) as SymbolItem).tag).toBe("PT 3224");
    const [again] = editor.paste();
    expect((store.doc.items.find((item) => item.id === again) as SymbolItem).tag).toBe("PT 3225");
  });

  it("leaves Ctrl/Cmd letter shortcuts other than clipboard combos to the page", () => {
    const { editor, store } = makeEditor();
    editor.setTool("wire");
    expect(editor.key("s", { ctrl: true })).toBe(false);
    expect(editor.state.tool).toBe("wire");
    editor.select(["hv"]);
    const before = store.doc;
    expect(editor.key("r", { ctrl: true })).toBe(false);
    expect(editor.key("x", { ctrl: true })).toBe(false);
    expect(editor.key("w", { ctrl: true })).toBe(false);
    expect(store.doc).toBe(before);
    expect(editor.key("c", { ctrl: true })).toBe(true);
    expect(editor.key("V", { ctrl: true })).toBe(true);
    expect(store.doc.items.length).toBe(before.items.length + 1);
    expect(editor.key("a", { ctrl: true })).toBe(true);
    expect(editor.state.selection.length).toBe(store.doc.items.length);
    expect(editor.key("s")).toBe(true);
    expect(editor.state.tool).toBe("select");
    expect(editor.key("r")).toBe(true);
    expect(store.doc).not.toBe(before);
  });
});

describe("edit helpers", () => {
  it("drags end segments by growing a corner", () => {
    expect(dragSegment([{ x: 0, y: 0 }, { x: 20, y: 0 }], 0, 5)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 5 },
      { x: 20, y: 5 },
      { x: 20, y: 0 }
    ]);
  });
});
