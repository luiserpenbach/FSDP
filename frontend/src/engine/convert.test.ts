import { describe, expect, it } from "vitest";
import type { Edge, Node } from "reactflow";
import { computeConnectivity } from "./connectivity";
import { convertLegacyGraph } from "./convert";
import { SymbolRegistry } from "./library";
import { frameRect } from "./sheet";

const registry = SymbolRegistry.withBuiltins([
  { id: "sym1", name: "Custom pump", view_box: "0 0 64 40", svg: '<path d="M2,20 H62"/>', ports: [
    { id: "in", x: 2, y: 20, side: "left" },
    { id: "out", x: 62, y: 20, side: "right" }
  ] }
]);

function legacyGraph(): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [
    { id: "sec", type: "pidSection", position: { x: 0, y: 0 }, style: { width: 400, height: 300 }, data: { label: "Vacuum chamber" } },
    { id: "v1", type: "pidSymbol", position: { x: 40, y: 40 }, parentNode: "sec", style: { width: 56, height: 50 }, data: { symbolType: "valve", label: "v1", tag: "HV-1", rotation: 0 } },
    { id: "s1", type: "pidSymbol", position: { x: 200, y: 40 }, parentNode: "sec", style: { width: 56, height: 50 }, data: { symbolType: "sensor", label: "PT", tag: "PT-2" } },
    { id: "c1", type: "pidSymbol", position: { x: 600, y: 60 }, style: { width: 56, height: 50 }, data: { symbolType: "custom:sym1", label: "Pump" } },
    { id: "j1", type: "pidJunction", position: { x: 400, y: 55 }, style: { width: 20, height: 20 }, data: {} },
    { id: "t1", type: "pidText", position: { x: 20, y: 400 }, data: { text: "GENERAL NOTES", fontSize: 16 } },
    { id: "n1", type: "pidComment", position: { x: 500, y: 400 }, data: { text: "check this", author: "jens" } }
  ];
  const edges: Edge[] = [
    { id: "e1", source: "v1", sourceHandle: "out", target: "j1", targetHandle: "l", data: { fluid: "GHe", pressure_bar: 200 }, label: "3101" },
    { id: "e2", source: "j1", sourceHandle: "r", target: "c1", targetHandle: "in", data: { strokeStyle: "dashed" } },
    { id: "e3", source: "j1", sourceHandle: "t", target: "s1", targetHandle: "process", data: {} }
  ];
  return { nodes, edges };
}

describe("legacy graph converter", () => {
  it("preserves ids, maps node kinds, and places content inside the frame", () => {
    const doc = convertLegacyGraph(legacyGraph(), registry, { title: "Demo" });
    const ids = doc.items.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(["sec", "v1", "s1", "c1", "t1", "n1", "e1", "e2", "e3"]));
    expect(ids).not.toContain("j1");
    const kinds = Object.fromEntries(doc.items.map((item) => [item.id, item.kind]));
    expect(kinds).toMatchObject({ sec: "equipment", v1: "symbol", s1: "symbol", t1: "label", n1: "note", e1: "line" });
    const v1 = doc.items.find((item) => item.id === "v1");
    expect(v1 && v1.kind === "symbol" ? v1.tag : null).toBe("HV-1");
    expect(v1 && v1.kind === "symbol" ? v1.symbol : null).toEqual({ library: "fsdp", key: "valve", version: 1 });
    const c1 = doc.items.find((item) => item.id === "c1");
    expect(c1 && c1.kind === "symbol" ? c1.symbol : null).toEqual({ library: "custom", key: "sym1", version: 1 });
    const frame = frameRect(doc.sheet);
    for (const item of doc.items) {
      if (item.kind === "symbol") {
        expect(item.position.x).toBeGreaterThan(frame.x);
        expect(item.position.y).toBeGreaterThan(frame.y);
        expect(item.position.x % 2.5).toBe(0);
        expect(item.position.y % 2.5).toBe(0);
      }
    }
    expect(doc.meta.convertedFrom).toBe("reactflow");
    expect(doc.meta.title).toBe("Demo");
  });

  it("turns edges into orthogonal lines that stay connected to ports and tees", () => {
    const doc = convertLegacyGraph(legacyGraph(), registry);
    const connectivity = computeConnectivity(doc, registry);
    expect(connectivity.danglingEnds).toHaveLength(0);
    // Everything meets at the former junction node, so one net and one junction dot.
    expect(connectivity.nets).toHaveLength(1);
    expect(connectivity.junctions).toHaveLength(1);
    for (const item of doc.items) {
      if (item.kind !== "line") continue;
      for (let index = 1; index < item.points.length; index += 1) {
        const a = item.points[index - 1];
        const b = item.points[index];
        expect(a.x === b.x || a.y === b.y).toBe(true);
      }
    }
    const e1 = doc.items.find((item) => item.id === "e1");
    expect(e1 && e1.kind === "line" ? { service: e1.service, lineNumber: e1.lineNumber, pressure: e1.fields.pressure_bar } : null).toEqual({
      service: "GHe",
      lineNumber: "3101",
      pressure: 200
    });
    const e2 = doc.items.find((item) => item.id === "e2");
    expect(e2 && e2.kind === "line" ? e2.lineType : null).toBe("signal_electric");
  });

  it("handles an empty graph", () => {
    const doc = convertLegacyGraph({}, registry);
    expect(doc.items).toEqual([]);
    expect(doc.sheet.size).toBe("A3");
  });
});
