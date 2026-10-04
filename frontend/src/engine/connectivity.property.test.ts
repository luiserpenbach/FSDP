/**
 * Property tests: the spatially indexed connectivity and crossings must match
 * the brute-force reference exactly (same nets, ends, junctions, hop order)
 * on seeded random documents that stress ends on ports, tees on segment
 * interiors, end-to-end joins, near-tolerance offsets, diagonals, zero-length
 * segments, duplicate geometry and duplicate ids.
 */
import { describe, expect, it } from "vitest";
import { referenceConnectivity, referenceCrossings } from "../test/referenceConnectivity";
import { computeConnectivity, equipmentPorts, type Connectivity } from "./connectivity";
import { benchmarkDocument, lineThrough, symbolAt } from "./fixtures";
import { BUILTIN_LIBRARY, SymbolRegistry } from "./library";
import { computeCrossings } from "./lines";
import { makeSheet } from "./sheet";
import { createEmptyDocument, type EquipmentItem, type LineItem, type Point, type Rotation, type SchematicDocument, type SymbolItem } from "./types";

const registry = SymbolRegistry.withBuiltins();

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYMBOL_KEYS = ["valve", "hand_valve", "regulator", "relief_valve", "instrument", "gas_bottle", "tie_in"];
const ROTATIONS: Rotation[] = [0, 90, 180, 270];
/** Offsets around the 0.01 mm coincidence tolerance (and well past it). */
const JITTER = [0, 0, 0, 0.004, -0.009, 0.0099, 0.0101, -0.011, 0.015, 0.02, 0.3];

function randomDocument(seed: number): SchematicDocument {
  const random = rng(seed);
  const int = (n: number) => Math.floor(random() * n);
  const pick = <T,>(values: T[]): T => values[int(values.length)];
  const grid = () => int(80) * 2.5;
  const doc = createEmptyDocument();
  doc.sheet = makeSheet("A3");
  const anchors: Point[] = [];

  const symbolCount = int(14);
  for (let index = 0; index < symbolCount; index += 1) {
    const symbol: SymbolItem = symbolAt(`s${index}`, pick(SYMBOL_KEYS), { x: grid(), y: grid() }, { rotation: pick(ROTATIONS), mirror: random() < 0.2 });
    doc.items.push(symbol);
    for (const port of registry.portsOf(symbol)) anchors.push(port.position);
  }
  const equipmentCount = int(3);
  for (let index = 0; index < equipmentCount; index += 1) {
    const equipment: EquipmentItem = {
      id: `e${index}`,
      kind: "equipment",
      layer: "symbols",
      position: { x: grid(), y: grid() },
      size: { width: 20 + int(10) * 2.5, height: 15 + int(10) * 2.5 },
      name: `EQ${index}`,
      boundary: "solid",
      nozzles: [
        { id: "n1", x: 0, y: 5, side: "left" },
        { id: "n2", x: 10, y: 0, side: "top" }
      ],
      fields: {}
    };
    doc.items.push(equipment);
    for (const port of equipmentPorts(equipment)) anchors.push(port.position);
  }

  const lineCount = int(45);
  const lines: LineItem[] = [];
  const jitter = (point: Point): Point => ({ x: point.x + pick(JITTER), y: point.y + pick(JITTER) });
  const somewhereOnExistingLine = (): Point | null => {
    if (!lines.length) return null;
    const line = pick(lines);
    if (line.points.length < 2) return line.points[0] ?? null;
    const segment = int(line.points.length - 1);
    const a = line.points[segment];
    const b = line.points[segment + 1];
    const t = pick([0, 0.5, 1, random()]);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  const startPoint = (): Point => {
    const roll = random();
    if (roll < 0.35 && anchors.length) return jitter(pick(anchors));
    if (roll < 0.7) return jitter(somewhereOnExistingLine() ?? { x: grid(), y: grid() });
    return { x: grid(), y: grid() };
  };

  for (let index = 0; index < lineCount; index += 1) {
    const roll = random();
    if (roll < 0.05 && lines.length) {
      // Same geometry again under a new id.
      const copy = lineThrough(`l${index}`, pick(lines).points.map((point) => ({ ...point })));
      lines.push(copy);
      continue;
    }
    const points: Point[] = [startPoint()];
    const vertices = 1 + int(4);
    for (let vertex = 0; vertex < vertices; vertex += 1) {
      const last = points[points.length - 1];
      const step = (int(30) - 15) * 2.5;
      const kind = random();
      if (kind < 0.08) points.push({ ...last }); // zero-length segment
      else if (kind < 0.16) points.push({ x: last.x + step, y: last.y + (int(20) - 10) * 2.5 }); // diagonal
      else if (kind < 0.58) points.push({ x: last.x + step, y: last.y });
      else points.push({ x: last.x, y: last.y + step });
    }
    if (random() < 0.5) {
      // Land the far end on something.
      const target = random() < 0.5 && anchors.length ? jitter(pick(anchors)) : somewhereOnExistingLine();
      if (target) {
        const last = points[points.length - 1];
        points.push({ x: target.x, y: last.y }, target);
      }
    }
    const shape = random();
    const finalPoints = shape < 0.03 ? points.slice(0, 1) : shape < 0.04 ? [] : points;
    lines.push(lineThrough(random() < 0.04 && lines.length ? pick(lines).id : `l${index}`, finalPoints));
  }
  doc.items.push(...lines);
  // Shuffle so document order mixes symbols and lines.
  for (let index = doc.items.length - 1; index > 0; index -= 1) {
    const other = int(index + 1);
    [doc.items[index], doc.items[other]] = [doc.items[other], doc.items[index]];
  }
  void BUILTIN_LIBRARY;
  return doc;
}

/** Plain, order-preserving form of a connectivity result for deep comparison. */
function plain(connectivity: Connectivity) {
  return {
    nets: connectivity.nets,
    junctions: connectivity.junctions,
    lineNet: [...connectivity.lineNet.entries()],
    portNet: [...connectivity.portNet.entries()],
    lineEnds: connectivity.lineEnds,
    danglingEnds: connectivity.danglingEnds,
    openPorts: connectivity.openPorts,
    crossings: [...connectivity.crossings.entries()]
  };
}

describe("spatially indexed connectivity matches the brute-force reference", () => {
  it("on 400 seeded random documents", () => {
    let attachments = 0;
    let crossings = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const doc = randomDocument(seed);
      const fast = plain(computeConnectivity(doc, registry));
      const reference = plain(referenceConnectivity(doc, registry));
      expect(fast, `seed ${seed}`).toEqual(reference);
      attachments += fast.lineEnds.reduce((sum, end) => sum + end.attachments.length, 0);

      const lines = doc.items.filter((item): item is LineItem => item.kind === "line");
      const fastCrossings = [...computeCrossings(lines).entries()];
      expect(fastCrossings, `seed ${seed} crossings`).toEqual([...referenceCrossings(lines).entries()]);
      crossings += fastCrossings.reduce((sum, [, hops]) => sum + hops.length, 0);
    }
    // The generator must actually exercise attachments and hops.
    expect(attachments).toBeGreaterThan(1000);
    expect(crossings).toBeGreaterThan(100);
  });

  it("on the benchmark sheet", () => {
    const doc = benchmarkDocument(120, 180);
    expect(plain(computeConnectivity(doc, registry))).toEqual(plain(referenceConnectivity(doc, registry)));
  });
});
