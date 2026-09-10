/** Test and benchmark fixtures for the schematic engine. */
import { BUILTIN_LIBRARY } from "./library";
import { makeSheet } from "./sheet";
import { createEmptyDocument, type LineItem, type Point, type SchematicDocument, type SymbolItem } from "./types";

export function symbolAt(id: string, key: string, position: Point, extra: Partial<SymbolItem> = {}): SymbolItem {
  return {
    id,
    kind: "symbol",
    layer: "symbols",
    symbol: { library: BUILTIN_LIBRARY, key, version: 1 },
    position,
    rotation: 0,
    fields: {},
    ...extra
  };
}

export function lineThrough(id: string, points: Point[], extra: Partial<LineItem> = {}): LineItem {
  return { id, kind: "line", layer: "process", points, lineType: "process", fields: {}, ...extra };
}

/**
 * A small helium panel: bottle → hand valve → regulator → relief tee → instrument.
 * Ports: inline symbols have ports at x ± 10 from their centre.
 */
export function smallPanelDocument(): SchematicDocument {
  const doc = createEmptyDocument();
  doc.sheet = makeSheet("A3");
  doc.items = [
    symbolAt("bottle", "gas_bottle", { x: 40, y: 150 }, { tag: "K-3201" }),
    symbolAt("hv", "hand_valve", { x: 80, y: 120 }, { tag: "HV-3201" }),
    symbolAt("pcv", "regulator", { x: 130, y: 120 }, { tag: "PCV-3202" }),
    symbolAt("psv", "relief_valve", { x: 170, y: 90 }, { tag: "PSV-3203" }),
    symbolAt("pt", "instrument", { x: 200, y: 100 }, { tag: "PT-3204" }),
    // bottle top port (40,137.5) → hv "in" (70,120)
    lineThrough("l1", [
      { x: 40, y: 137.5 },
      { x: 40, y: 120 },
      { x: 70, y: 120 }
    ]),
    // hv out (90,120) → pcv in (120,120)
    lineThrough("l2", [
      { x: 90, y: 120 },
      { x: 120, y: 120 }
    ]),
    // pcv out (140,120) → pt process (200,105)
    lineThrough("l3", [
      { x: 140, y: 120 },
      { x: 200, y: 120 },
      { x: 200, y: 105 }
    ]),
    // tee at (160,120) up to psv in (160,90)
    lineThrough("l4", [
      { x: 160, y: 120 },
      { x: 160, y: 90 }
    ])
  ];
  return doc;
}

/** Benchmark fixture: a grid of symbols joined by lines (≈ symbols + lines items). */
export function benchmarkDocument(symbolCount = 500, lineCount = 800): SchematicDocument {
  const doc = createEmptyDocument();
  doc.sheet = makeSheet("A0");
  const columns = 25;
  const pitch = 40;
  const positions: Point[] = [];
  for (let index = 0; index < symbolCount; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const position = { x: 30 + column * pitch, y: 30 + row * 30 };
    positions.push(position);
    doc.items.push(symbolAt(`s${index}`, index % 3 === 0 ? "instrument" : "valve", position, { tag: `V-${index}` }));
  }
  for (let index = 0; index < lineCount; index += 1) {
    const from = positions[index % symbolCount];
    const to = positions[(index * 7 + 1) % symbolCount];
    doc.items.push(
      lineThrough(`l${index}`, [
        { x: from.x + 10, y: from.y },
        { x: (from.x + to.x) / 2, y: from.y },
        { x: (from.x + to.x) / 2, y: to.y },
        { x: to.x - 10, y: to.y }
      ])
    );
  }
  return doc;
}
