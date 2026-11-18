import { describe, expect, it } from "vitest";
import { SymbolRegistry } from "../library";
import { renderDocumentSvg } from "../render";
import { computeSheetPayload } from "../sheetPayload";
import { DEFAULT_GRID_MM } from "../types";
import { buildTestStandDemo } from "./testStandPid";

describe("test stand demo drawing", () => {
  const demo = buildTestStandDemo();
  const registry = SymbolRegistry.withBuiltins();
  const payload = computeSheetPayload({ doc: demo.document, sheetNo: 1, otherSheets: [], tagScheme: null, registry });

  it("is a dense single-sheet P&ID drawn only with built-in symbols", () => {
    const symbols = demo.document.items.filter((item) => item.kind === "symbol");
    expect(symbols.length).toBeGreaterThan(80);
    expect(demo.document.items.filter((item) => item.kind === "line").length).toBeGreaterThan(90);
    for (const item of symbols) expect(registry.has(item.symbol), item.id).toBe(true);
    expect(new Set(demo.document.items.map((item) => item.id)).size).toBe(demo.document.items.length);
  });

  it("keeps every symbol and line vertex on the drafting grid", () => {
    const onGrid = (value: number) => Math.abs(value / DEFAULT_GRID_MM - Math.round(value / DEFAULT_GRID_MM)) < 1e-9;
    for (const item of demo.document.items) {
      if (item.kind === "symbol") expect(onGrid(item.position.x) && onGrid(item.position.y), item.id).toBe(true);
      if (item.kind === "line") for (const point of item.points) expect(onGrid(point.x) && onGrid(point.y), item.id).toBe(true);
    }
  });

  it("is fully connected: no design rule errors, dangling lines, open ports, or tag problems", () => {
    const findings = payload.drc.findings;
    expect(findings.filter((finding) => finding.severity === "error")).toEqual([]);
    const rules = new Set(findings.map((finding) => finding.rule));
    // What remains is for a reviewer to judge: gas and vent sections without their own relief device.
    expect([...rules].sort()).toEqual(["relief_coverage", "trapped_volume"]);
  });

  it("indexes every tagged item and numbered line", () => {
    const tags = payload.index.items.map((item) => item.tag).filter(Boolean);
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags).toEqual(expect.arrayContaining(["TK-101", "TK-201", "PCV-001", "PSV-131", "XV-141", "FE-241", "I-001"]));
    const numbers = new Set(payload.index.lines.map((line) => line.line_number).filter(Boolean));
    expect([...numbers]).toEqual(expect.arrayContaining(["GHE-101", "GHE-102", "LOX-141", "CH4-241", "GN2-152"]));
    for (const itemId of Object.keys(demo.parts)) expect(demo.document.items.some((item) => item.id === itemId), itemId).toBe(true);
  });

  it("renders at paper size with each line number printed once per run", () => {
    const svg = renderDocumentSvg(payload.doc, registry, { context: { number: demo.number, title: demo.title, sheetNo: 1, sheetCount: 1, notes: demo.notes, revisions: [] } });
    expect(svg).toContain('viewBox="0 0 841 594"');
    expect(svg.match(/>LOX-141</g)).toHaveLength(1);
    expect(svg.match(/>GHE-102</g)).toHaveLength(1);
  });
});
