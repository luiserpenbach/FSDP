import { describe, expect, it } from "vitest";
import {
  BUILT_IN_SYMBOLS,
  canRedo,
  canUndo,
  commit,
  createHistory,
  createStarterDocument,
  documentToApiPayload,
  documentToGraph,
  graphToDocument,
  gridSizeInPixels,
  interactiveWalk,
  normalizeEdge,
  orthogonalPath,
  reattachOrthogonal,
  resolveWaypoints,
  routeOrthogonal,
  runDrc,
  shoveEdges,
  moveSegmentPoints,
  teeOntoEdge,
  undo,
  redo,
  alignNodes,
  distributeNodes,
  cleanupJunctions,
  documentToSvg,
  ensureUniqueTag,
  nextLineTag,
  polylineMidpoint
} from "../index";

describe("pid-cad geometry", () => {
  it("converts millimetres to CSS pixels", () => {
    expect(gridSizeInPixels({ gridVisible: true, gridVariant: "dots", snapToGrid: true, unit: "mm", gridSize: 25.4, autoLineTags: true, routeMode: "orthogonal", hiddenLineClasses: [] })).toBeCloseTo(96);
  });

  it("creates an orthogonal route around an obstacle", () => {
    const points = routeOrthogonal({ x: 0, y: 0 }, { x: 200, y: 0 }, [{ x: 80, y: -30, width: 40, height: 60 }], 10, 5);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points.at(-1)).toEqual({ x: 200, y: 0 });
    expect(points.some((point) => point.y !== 0)).toBe(true);
  });

  it("builds interactive orthogonal walk previews", () => {
    const walk = interactiveWalk([{ x: 0, y: 0 }], { x: 40, y: 20 }, "orthogonal");
    expect(walk[0]).toEqual({ x: 0, y: 0 });
    expect(walk.at(-1)).toEqual({ x: 40, y: 20 });
    for (let i = 0; i < walk.length - 1; i += 1) {
      expect(walk[i].x === walk[i + 1].x || walk[i].y === walk[i + 1].y).toBe(true);
    }
  });

  it("serializes orthogonal paths", () => {
    expect(orthogonalPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }])).toBe("M 0 0 L 10 0 L 10 20");
  });

  it("reattaches routes with only horizontal/vertical segments when an endpoint moves", () => {
    const waypoints = [
      { x: 50, y: 0 },
      { x: 50, y: 40 },
      { x: 100, y: 40 }
    ];
    const moved = reattachOrthogonal({ x: 10, y: 25 }, { x: 100, y: 40 }, waypoints, {
      source: { x: 0, y: 0 },
      target: { x: 100, y: 40 }
    });
    expect(moved[0]).toEqual({ x: 10, y: 25 });
    expect(moved.at(-1)).toEqual({ x: 100, y: 40 });
    for (let i = 0; i < moved.length - 1; i += 1) {
      expect(moved[i].x === moved[i + 1].x || moved[i].y === moved[i + 1].y).toBe(true);
    }
  });

  it("translates the whole route when both ends move by the same delta", () => {
    const waypoints = [
      { x: 50, y: 0 },
      { x: 50, y: 40 }
    ];
    const moved = reattachOrthogonal({ x: 10, y: 10 }, { x: 110, y: 50 }, waypoints, {
      source: { x: 0, y: 0 },
      target: { x: 100, y: 40 }
    });
    expect(moved).toEqual([
      { x: 10, y: 10 },
      { x: 60, y: 10 },
      { x: 60, y: 50 },
      { x: 110, y: 50 }
    ]);
  });

  it("never returns diagonal segments from resolveWaypoints", () => {
    const points = resolveWaypoints({ x: 0, y: 20 }, { x: 100, y: 40 }, [
      { x: 50, y: 0 },
      { x: 50, y: 40 }
    ]);
    for (let i = 0; i < points.length - 1; i += 1) {
      expect(points[i].x === points[i + 1].x || points[i].y === points[i + 1].y).toBe(true);
    }
  });

  it("aligns and distributes selected nodes", () => {
    const nodes = [
      { id: "a", position: { x: 0, y: 10 }, data: { label: "A", symbolType: "valve", rotation: 0 }, style: { width: 100, height: 100 } },
      { id: "b", position: { x: 40, y: 50 }, data: { label: "B", symbolType: "valve", rotation: 0 }, style: { width: 100, height: 100 } },
      { id: "c", position: { x: 90, y: 80 }, data: { label: "C", symbolType: "valve", rotation: 0 }, style: { width: 100, height: 100 } }
    ] as never;
    const aligned = alignNodes(nodes, ["a", "b", "c"], "left");
    expect(aligned.every((node) => node.position.x === 0)).toBe(true);
    const distributed = distributeNodes(nodes, ["a", "b", "c"], "horizontal");
    expect(distributed[1].position.x).toBeGreaterThan(distributed[0].position.x);
    expect(distributed[2].position.x).toBeGreaterThan(distributed[1].position.x);
  });

  it("cleans up under-connected junctions", () => {
    const doc = createStarterDocument();
    const junctionId = "junc-test";
    doc.junctions = [{ id: junctionId, position: { x: 100, y: 100 }, kind: "tee", netId: "n1" }];
    doc.nodes.push({
      id: junctionId,
      type: "pidSymbol",
      position: { x: 94, y: 94 },
      style: { width: 12, height: 12 },
      data: { label: "", symbolType: "junction", rotation: 0, kind: "junction", junctionKind: "tee", netId: "n1" }
    });
    doc.edges = [
      {
        id: "only",
        source: "source-1",
        target: junctionId,
        type: "pidLine",
        data: { routing: "manual", waypoints: [], netId: "n1", lineClass: "process" }
      }
    ];
    const cleaned = cleanupJunctions(doc);
    expect(cleaned.junctions.some((item) => item.id === junctionId)).toBe(false);
    expect(cleaned.nodes.some((node) => node.id === junctionId)).toBe(false);
  });

  it("exports a document to SVG markup", () => {
    const svg = documentToSvg(createStarterDocument(), "Test");
    expect(svg).toContain("<svg");
    expect(svg).toContain("Test");
    expect(svg).toContain("<polyline");
  });
  it("assigns unique starter line tags", () => {
    const doc = createStarterDocument();
    const tags = doc.edges.map((edge) => edge.data?.tag);
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags).toContain("P-101");
    expect(tags).toContain("P-102");
    expect(doc.nets.map((net) => net.tag).sort()).toEqual(["P-101", "P-102"]);
  });

  it("never reuses an existing line tag", () => {
    const doc = createStarterDocument();
    expect(nextLineTag(doc, "process")).toBe("P-103");
    expect(ensureUniqueTag(doc, "P-101", "process")).toBe("P-103");
    expect(ensureUniqueTag(doc, "P-101", "process", ["net-feed-a"])).toBe("P-101");
  });
  it("places line tags at the polyline path midpoint", () => {
    const mid = polylineMidpoint([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 }
    ]);
    expect(mid.x).toBeCloseTo(100);
    expect(mid.y).toBeCloseTo(0);
  });

  it("rebuilds a single stub when dragging the first segment again", () => {
    const once = moveSegmentPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, [{ x: 50, y: 0 }], 0, { x: 20, y: 40 });
    for (let i = 0; i < once.length - 1; i += 1) {
      expect(once[i].x === once[i + 1].x || once[i].y === once[i + 1].y).toBe(true);
    }
    const twice = moveSegmentPoints(
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      once.slice(1, -1),
      0,
      { x: 30, y: 20 }
    );
    expect(twice.length).toBeLessThanOrEqual(once.length + 1);
    for (let i = 0; i < twice.length - 1; i += 1) {
      expect(twice[i].x === twice[i + 1].x || twice[i].y === twice[i + 1].y).toBe(true);
    }
  });
});

describe("pid-cad history", () => {
  it("undoes and redoes document commits", () => {
    const start = createStarterDocument();
    let history = createHistory(start);
    const next = { ...start, settings: { ...start.settings, gridVisible: false } };
    history = commit(history, next);
    expect(history.present.settings.gridVisible).toBe(false);
    expect(canUndo(history)).toBe(true);
    history = undo(history);
    expect(history.present.settings.gridVisible).toBe(true);
    expect(canRedo(history)).toBe(true);
    history = redo(history);
    expect(history.present.settings.gridVisible).toBe(false);
  });
});

describe("pid-cad shove", () => {
  it("shoves nearby auto-routed waypoints when a segment moves", () => {
    const oldPoints = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 40 },
      { x: 100, y: 40 }
    ];
    const newPoints = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 60 },
      { x: 100, y: 60 }
    ];
    const edges = [
      {
        id: "moved",
        source: "a",
        target: "b",
        type: "pidLine",
        data: {
          routing: "manual" as const,
          waypoints: oldPoints.slice(1, -1),
          netId: "n1",
          fluid: "TBD",
          pressure_bar: null,
          temperature_c: null,
          diameter_mm: null,
          material: "",
          flow_direction: "forward" as const
        }
      },
      {
        id: "other",
        source: "c",
        target: "d",
        type: "pidLine",
        data: {
          routing: "auto" as const,
          waypoints: [
            { x: 40, y: 40 },
            { x: 80, y: 40 }
          ],
          netId: "n2",
          fluid: "TBD",
          pressure_bar: null,
          temperature_c: null,
          diameter_mm: null,
          material: "",
          flow_direction: "forward" as const
        }
      }
    ];
    const result = shoveEdges(edges, "moved", oldPoints, newPoints, 2);
    const other = result.find((edge) => edge.id === "other");
    expect(other?.data?.waypoints?.[0].y).toBe(60);
  });

  it("creates an S-bend when dragging the first segment", () => {
    const moved = moveSegmentPoints(
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      [{ x: 50, y: 0 }],
      0,
      { x: 20, y: 40 }
    );
    expect(moved[0]).toEqual({ x: 0, y: 0 });
    expect(moved.at(-1)).toEqual({ x: 100, y: 0 });
    expect(moved.some((point) => point.y === 40)).toBe(true);
    for (let i = 0; i < moved.length - 1; i += 1) {
      expect(moved[i].x === moved[i + 1].x || moved[i].y === moved[i + 1].y).toBe(true);
    }
  });
});

describe("pid-cad junctions", () => {
  it("tees onto an existing edge and creates a junction node", () => {
    const doc = createStarterDocument();
    const edgeId = doc.edges[0].id;
    const next = teeOntoEdge(doc, edgeId, { x: 180, y: 160 }, { nodeId: "sink-1", portId: "left" }, [
      { x: 500, y: 160 },
      { x: 180, y: 160 }
    ]);
    expect(next.junctions.length).toBe(1);
    expect(next.nodes.some((node) => node.data.kind === "junction")).toBe(true);
    expect(next.edges.length).toBe(doc.edges.length + 2);
    expect(next.edges.some((edge) => edge.id === edgeId)).toBe(false);
  });
});

describe("pid-cad adapters", () => {
  it("round-trips a v2 document through graph serialization", () => {
    const doc = createStarterDocument();
    const graph = documentToGraph(doc);
    const restored = graphToDocument(graph);
    expect(restored.version).toBe(2);
    expect(restored.nodes.length).toBe(doc.nodes.length);
    expect(restored.edges.length).toBe(doc.edges.length);
    expect(restored.nets.length).toBe(doc.nets.length);
  });

  it("migrates legacy bend edges", () => {
    const edge = normalizeEdge({
      id: "legacy",
      source: "a",
      target: "b",
      type: "orthogonal",
      data: { startX: 30, bendY: 50, endX: 90 }
    });
    expect(edge.type).toBe("pidLine");
    expect(edge.data?.routing).toBe("manual");
  });

  it("maps engineering fields into the API payload", () => {
    const doc = createStarterDocument();
    doc.edges[0].data = {
      ...doc.edges[0].data!,
      fluid: "LOX",
      pressure_bar: 20,
      temperature_c: -180,
      diameter_mm: 12,
      material: "SS316",
      flow_direction: "forward"
    };
    const payload = documentToApiPayload(doc);
    expect(payload.edges[0].fluid).toBe("LOX");
    expect(payload.edges[0].pressure_bar).toBe(20);
    expect(payload.edges[0].diameter_mm).toBe(12);
  });
});

describe("pid-cad DRC", () => {
  it("flags unconnected required ports", () => {
    const doc = createStarterDocument();
    doc.edges = [];
    const issues = runDrc(doc);
    expect(issues.some((issue) => issue.code === "UNCONNECTED_PORT")).toBe(true);
  });
});

describe("symbol library", () => {
  it("ships an expanded ISA-style pack", () => {
    expect(BUILT_IN_SYMBOLS.length).toBeGreaterThanOrEqual(18);
    expect(BUILT_IN_SYMBOLS.some((symbol) => symbol.id === "gate_valve")).toBe(true);
    expect(BUILT_IN_SYMBOLS.some((symbol) => symbol.id === "psv")).toBe(true);
    expect(BUILT_IN_SYMBOLS.some((symbol) => symbol.id === "heat_exchanger")).toBe(true);
  });
});
