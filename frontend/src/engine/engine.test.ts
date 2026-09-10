import { describe, expect, it } from "vitest";
import { applyCommand, invertCommand, type Command } from "./commands";
import { computeConnectivity } from "./connectivity";
import { moveItemsCommand, retargetLineEnd, rotateItemsCommand } from "./edit";
import { benchmarkDocument, lineThrough, smallPanelDocument, symbolAt } from "./fixtures";
import { orthogonalize, simplifyPolyline, snapPoint } from "./geometry";
import { BUILTIN_SYMBOLS, SymbolRegistry, customSymbolDef, symbolPorts } from "./library";
import { renderDocumentSvg, splitTag } from "./render";
import { routeBetween } from "./routing";
import { makeSheet, zoneAt } from "./sheet";
import { snapCursor } from "./snap";
import { SpatialIndex, hitTest } from "./spatial";
import { DocumentStore } from "./store";
import type { Item, SchematicDocument } from "./types";

const registry = SymbolRegistry.withBuiltins();

describe("geometry", () => {
  it("orthogonalizes diagonal runs and simplifies collinear vertices", () => {
    expect(orthogonalize([{ x: 0, y: 0 }, { x: 10, y: 5 }])).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 }
    ]);
    expect(simplifyPolyline([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }])).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 }
    ]);
  });

  it("snaps to the 2.5 mm grid", () => {
    expect(snapPoint({ x: 3.7, y: -1.1 }, 2.5)).toEqual({ x: 2.5, y: 0 });
  });
});

describe("library", () => {
  it("authors every built-in port on the 2.5 mm grid", () => {
    for (const definition of BUILTIN_SYMBOLS) {
      for (const port of definition.ports) {
        expect(Math.abs(port.x % 2.5), `${definition.key}.${port.id}.x`).toBe(0);
        expect(Math.abs(port.y % 2.5), `${definition.key}.${port.id}.y`).toBe(0);
      }
    }
  });

  it("rotates and mirrors ports with the symbol", () => {
    const item = symbolAt("v", "valve", { x: 100, y: 50 }, { rotation: 90 });
    const ports = symbolPorts(item, registry.builtin("valve"));
    expect(ports.find((port) => port.id === "in")).toMatchObject({ position: { x: 100, y: 40 }, side: "top" });
    expect(ports.find((port) => port.id === "out")).toMatchObject({ position: { x: 100, y: 60 }, side: "bottom" });
    const mirrored = symbolPorts({ ...item, rotation: 0, mirror: true }, registry.builtin("valve"));
    expect(mirrored.find((port) => port.id === "in")).toMatchObject({ position: { x: 110, y: 50 }, side: "right" });
  });

  it("wraps custom SVG symbols to 20 mm wide and scales their ports", () => {
    const definition = customSymbolDef({
      id: "abc",
      name: "Custom",
      view_box: "0 0 64 40",
      svg: '<path d="M0,20 H64"/>',
      ports: [{ id: "in", x: 0, y: 20, side: "left" }]
    });
    expect(definition.width).toBe(20);
    expect(definition.height).toBeCloseTo(12.5);
    expect(definition.ports[0]).toMatchObject({ x: -10, y: 0, side: "left" });
    const custom = SymbolRegistry.withBuiltins([
      { id: "abc", name: "Custom", view_box: "0 0 64 40", svg: "<path d='M0,0'/>", ports: [] }
    ]);
    expect(custom.resolve({ library: "custom", key: "abc", version: 1 }).name).toBe("Custom");
    expect(custom.resolve({ library: "custom", key: "nope", version: 1 }).key).toBe("__missing__");
  });
});

describe("commands and store", () => {
  it("undoes and redoes every command type exactly", () => {
    const base = smallPanelDocument();
    const commands: Command[] = [
      { type: "add", items: [symbolAt("new", "filter", { x: 300, y: 200 })] },
      { type: "move", ids: ["hv", "l2"], delta: { x: 5, y: -2.5 } },
      { type: "update", id: "pt", patch: { tag: "PT-9999", rotation: 90 } },
      { type: "set-points", id: "l2", points: [{ x: 90, y: 120 }, { x: 90, y: 130 }, { x: 120, y: 130 }] },
      { type: "remove", ids: ["l1", "bottle"] },
      { type: "replace", items: [{ ...(base.items[1] as Item), layer: "annotation" }] },
      { type: "sheet", sheet: makeSheet("A1") },
      { type: "batch", commands: [{ type: "remove", ids: ["psv"] }, { type: "move", ids: ["l4"], delta: { x: 1, y: 1 } }] }
    ];
    const store = new DocumentStore(base);
    const snapshots: SchematicDocument[] = [store.doc];
    for (const command of commands) {
      store.dispatch(command);
      snapshots.push(store.doc);
    }
    for (let index = commands.length; index > 0; index -= 1) {
      expect(store.undo()).toBe(true);
      expect(store.doc).toEqual(snapshots[index - 1]);
    }
    expect(store.canUndo).toBe(false);
    for (let index = 1; index <= commands.length; index += 1) {
      expect(store.redo()).toBe(true);
      expect(store.doc).toEqual(snapshots[index]);
    }
  });

  it("holds for random command sequences (undo is an exact inverse)", () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    let doc = smallPanelDocument();
    for (let round = 0; round < 200; round += 1) {
      const ids = doc.items.map((item) => item.id);
      const pick = ids[Math.floor(random() * ids.length)];
      const choice = Math.floor(random() * 4);
      const command: Command =
        choice === 0
          ? { type: "move", ids: [pick], delta: { x: Math.round(random() * 10), y: Math.round(random() * 10) } }
          : choice === 1
            ? { type: "update", id: pick, patch: { locked: random() > 0.5 } }
            : choice === 2
              ? { type: "add", items: [symbolAt(`r${round}`, "valve", { x: random() * 100, y: random() * 100 })] }
              : { type: "remove", ids: [pick] };
      const inverse = invertCommand(doc, command);
      const after = applyCommand(doc, command);
      expect(applyCommand(after, inverse)).toEqual(doc);
      doc = after;
    }
  });

  it("coalesces drag steps into one undo entry and tracks dirtiness", () => {
    const store = new DocumentStore(smallPanelDocument());
    expect(store.dirty).toBe(false);
    store.dispatch({ type: "move", ids: ["hv"], delta: { x: 1, y: 0 } }, { coalesceKey: "drag" });
    store.dispatch({ type: "move", ids: ["hv"], delta: { x: 1, y: 0 } }, { coalesceKey: "drag" });
    store.endCoalescing();
    expect(store.dirty).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.canUndo).toBe(false);
    const hv = store.doc.items.find((item) => item.id === "hv");
    expect(hv && hv.kind === "symbol" ? hv.position.x : null).toBe(80);
    expect(store.redo()).toBe(true);
    const moved = store.doc.items.find((item) => item.id === "hv");
    expect(moved && moved.kind === "symbol" ? moved.position.x : null).toBe(82);
  });
});

describe("connectivity", () => {
  it("derives nets, junction dots, and open ports from geometry", () => {
    const connectivity = computeConnectivity(smallPanelDocument(), registry);
    // Symbols do not conduct between their own ports: three nets, with l3/l4 joined by the tee.
    expect(connectivity.nets).toHaveLength(3);
    const teeNet = connectivity.nets.find((net) => net.lineIds.includes("l3"));
    expect(teeNet?.lineIds.sort()).toEqual(["l3", "l4"]);
    expect(teeNet?.ports.map((port) => `${port.itemId}.${port.portId}`).sort()).toEqual(["pcv.out", "psv.in", "pt.process"]);
    expect(connectivity.junctions).toEqual([{ x: 160, y: 120 }]);
    expect(connectivity.danglingEnds).toHaveLength(0);
    const openPortIds = connectivity.openPorts.map((port) => `${port.itemId}.${port.id}`);
    expect(openPortIds).toContain("psv.vent");
    expect(openPortIds).not.toContain("hv.in");
  });

  it("reports dangling ends and separate nets", () => {
    const doc = smallPanelDocument();
    doc.items.push(lineThrough("loose", [{ x: 300, y: 50 }, { x: 320, y: 50 }]));
    const connectivity = computeConnectivity(doc, registry);
    expect(connectivity.nets).toHaveLength(4);
    expect(connectivity.danglingEnds.map((end) => end.lineId)).toEqual(["loose", "loose"]);
  });
});

describe("edit helpers keep lines attached", () => {
  it("moving a symbol drags attached line ends and keeps them orthogonal", () => {
    const doc = smallPanelDocument();
    const moved = applyCommand(doc, moveItemsCommand(doc, registry, ["hv"], { x: 0, y: -10 }));
    const l1 = moved.items.find((item) => item.id === "l1");
    const l2 = moved.items.find((item) => item.id === "l2");
    expect(l1 && l1.kind === "line" ? l1.points[l1.points.length - 1] : null).toEqual({ x: 70, y: 110 });
    expect(l2 && l2.kind === "line" ? l2.points : null).toEqual([
      { x: 90, y: 110 },
      { x: 90, y: 120 },
      { x: 120, y: 120 }
    ]);
    expect(applyCommand(moved, moveItemsCommand(moved, registry, ["hv"], { x: 0, y: 10 }))).toEqual(doc);
    expect(computeConnectivity(moved, registry).danglingEnds).toHaveLength(0);
  });

  it("rotating a symbol re-attaches lines to the rotated ports", () => {
    const doc = smallPanelDocument();
    const rotated = applyCommand(doc, rotateItemsCommand(doc, registry, ["pcv"]));
    const connectivity = computeConnectivity(rotated, registry);
    expect(connectivity.danglingEnds).toHaveLength(0);
    // The tee line followed the moved segment of l3 and still joins its net.
    expect(connectivity.nets.find((net) => net.lineIds.includes("l4"))?.lineIds.sort()).toEqual(["l3", "l4"]);
  });

  it("retargets a two-point line by inserting a corner", () => {
    expect(retargetLineEnd([{ x: 0, y: 0 }, { x: 10, y: 0 }], 1, { x: 10, y: 5 })).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 }
    ]);
  });
});

describe("routing", () => {
  it("draws a straight run between facing collinear ports", () => {
    expect(routeBetween({ x: 0, y: 0 }, "right", { x: 30, y: 0 }, "left")).toEqual([{ x: 0, y: 0 }, { x: 30, y: 0 }]);
  });

  it("routes two facing ports on different rows with a vertical backbone", () => {
    const route = routeBetween({ x: 0, y: 0 }, "right", { x: 40, y: 20 }, "left", { grid: 2.5 });
    expect(route[0]).toEqual({ x: 0, y: 0 });
    expect(route[route.length - 1]).toEqual({ x: 40, y: 20 });
    for (let index = 1; index < route.length; index += 1) {
      const a = route[index - 1];
      const b = route[index];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });
});

describe("spatial index and snapping", () => {
  it("hits ports before bodies and lines on their segments", () => {
    const doc = smallPanelDocument();
    const index = new SpatialIndex(doc, registry);
    const portHit = hitTest(index, { x: 70.3, y: 120.2 }, 1);
    expect(portHit?.item.id).toBe("hv");
    expect(portHit?.part.type).toBe("port");
    const lineHit = hitTest(index, { x: 105, y: 120.4 }, 1);
    expect(lineHit?.item.id).toBe("l2");
    expect(lineHit?.part.type).toBe("segment");
    expect(hitTest(index, { x: 300, y: 250 }, 1)).toBeNull();
  });

  it("window-selects only fully contained items", () => {
    const index = new SpatialIndex(smallPanelDocument(), registry);
    const ids = index.queryContained({ x: 60, y: 100, width: 40, height: 40 }).map((item) => item.id);
    expect(ids).toEqual(["hv"]);
  });

  it("snaps to ports, then line segments, then the grid", () => {
    const doc = smallPanelDocument();
    const ports = computeConnectivity(doc, registry).openPorts;
    const options = { grid: 2.5, portRadius: 2, segmentRadius: 1.5 };
    expect(snapCursor(doc, ports, { x: 171, y: 78.8 }, options)).toMatchObject({ kind: "port", point: { x: 170, y: 80 } });
    expect(snapCursor(doc, ports, { x: 101.2, y: 120.8 }, options)).toMatchObject({ kind: "segment", point: { x: 100, y: 120 } });
    expect(snapCursor(doc, ports, { x: 301.2, y: 201 }, options)).toEqual({ kind: "grid", point: { x: 300, y: 200 } });
  });
});

describe("sheet", () => {
  it("labels zones right-to-left and bottom-to-top", () => {
    const sheet = makeSheet("A3"); // 4 x 3 zones, 10 mm margin, 400 x 277 inside
    expect(zoneAt(sheet, { x: 15, y: 15 })).toBe("C-4");
    expect(zoneAt(sheet, { x: 405, y: 280 })).toBe("A-1");
    expect(zoneAt(sheet, { x: -5, y: 15 })).toBeNull();
  });
});

describe("renderer", () => {
  it("renders a complete sheet with frame, symbols, lines, tags, and junction dots", () => {
    const svg = renderDocumentSvg(smallPanelDocument(), registry, { standalone: true });
    expect(svg.startsWith('<?xml version="1.0"')).toBe(true);
    expect(svg).toContain('width="420mm" height="297mm"');
    expect(svg).toContain('data-id="hv"');
    expect(svg).toContain(">PT<");
    expect(svg).toContain(">3204<");
    expect(svg).toContain('class="junctions"');
    expect(svg).toContain('cx="160" cy="120"');
    expect(svg).not.toContain("item-note");
  });

  it("is deterministic for the same document", () => {
    const doc = smallPanelDocument();
    expect(renderDocumentSvg(doc, registry)).toBe(renderDocumentSvg(doc, registry));
  });

  it("splits ISA tags into bubble rows", () => {
    expect(splitTag("PT-3222")).toEqual({ letters: "PT", number: "3222" });
    expect(splitTag("HV 4201")).toEqual({ letters: "HV", number: "4201" });
    expect(splitTag("V-1")).toEqual({ letters: "V", number: "1" });
  });

  it("renders the benchmark sheet (500 symbols, 800 lines) quickly", () => {
    const doc = benchmarkDocument();
    const started = performance.now();
    const svg = renderDocumentSvg(doc, registry);
    const elapsed = performance.now() - started;
    expect(svg.length).toBeGreaterThan(100_000);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("actuator composition and instrument styles", () => {
  it("adds the actuator's signal port at the body mount and grows the bounds", () => {
    const plain = symbolAt("v", "ball_valve", { x: 100, y: 100 });
    const composed = { ...plain, actuator: { library: "fsdp", key: "act_diaphragm", version: 1 } };
    expect(registry.portsOf(plain).map((port) => port.id)).toEqual(["in", "out"]);
    const ports = registry.portsOf(composed);
    expect(ports.map((port) => port.id)).toEqual(["in", "out", "signal"]);
    // Mount (0,-2.5) + actuator port (0,-7.5) = (0,-10): on the 2.5 mm grid.
    expect(ports[2]).toMatchObject({ position: { x: 100, y: 90 }, side: "top", kind: "signal" });
    expect(registry.boundsOf(composed).y).toBeLessThan(registry.boundsOf(plain).y);
    const rotated = { ...composed, rotation: 90 as const };
    expect(registry.portsOf(rotated)[2]).toMatchObject({ position: { x: 110, y: 100 }, side: "right" });
    expect(renderDocumentSvg({ ...smallPanelDocument(), items: [composed] }, registry)).toContain("A5,3 0 0 1 5,-4.5");
  });

  it("ignores actuators on bodies without a mount", () => {
    const disc = symbolAt("d", "rupture_disc", { x: 0, y: 0 }, { actuator: { library: "fsdp", key: "act_hand", version: 1 } });
    expect(registry.portsOf(disc).map((port) => port.id)).toEqual(["in", "out"]);
  });

  it("renders boxed primary elements with letters inside and the number below", () => {
    const element = symbolAt("te", "instrument_element", { x: 50, y: 50 }, { tag: "TE 3213" });
    const svg = renderDocumentSvg({ ...smallPanelDocument(), items: [element] }, registry);
    expect(svg).toContain(">TE<");
    expect(svg).toContain(">3213<");
  });

  it("ships the reference legend's symbol families", () => {
    const keys = new Set(BUILTIN_SYMBOLS.map((definition) => definition.key));
    for (const key of [
      "butterfly_valve", "check_valve", "valve", "relief_valve", "ball_valve", "globe_valve", "three_way_valve", "needle_valve",
      "regulator", "strainer", "filter", "heat_exchanger", "reducer", "flange", "flex_hose", "rupture_disc", "pump", "motor",
      "cross_over_valve", "union", "orifice", "water_separator", "silencer", "manifold", "sight_glass", "float_trap", "quick_disconnect",
      "act_piston", "act_hand", "act_diaphragm", "act_rotary_motor", "act_solenoid",
      "instrument", "instrument_panel", "instrument_laptop", "instrument_hardwired_shutdown", "instrument_data_collector", "instrument_prm", "instrument_interlock", "instrument_element"
    ]) {
      expect(keys.has(key), key).toBe(true);
    }
    expect(BUILTIN_SYMBOLS.filter((definition) => definition.category === "actuator").every((definition) => definition.ports.every((port) => port.y === -7.5 || port.kind !== "signal"))).toBe(true);
  });
});
