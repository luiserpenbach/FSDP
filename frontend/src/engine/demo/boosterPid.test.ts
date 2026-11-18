import { describe, expect, it } from "vitest";
import { resolveConnectorTargets, type SheetDoc } from "../connectors";
import { SymbolRegistry } from "../library";
import { renderDocumentSvg } from "../render";
import { computeSheetPayload } from "../sheetPayload";
import { DEFAULT_GRID_MM } from "../types";
import { buildBoosterDemo, ENGINE_COUNT, INNER_ENGINES } from "./boosterPid";

describe("booster scale demo drawing", () => {
  const demo = buildBoosterDemo();
  const registry = SymbolRegistry.withBuiltins();
  const sheets: SheetDoc[] = demo.sheets.map((sheet, index) => ({ sheetNo: index + 1, doc: sheet.document }));
  const others = (current: SheetDoc) => sheets.filter((sheet) => sheet !== current);
  const payloads = sheets.map((current) => computeSheetPayload({ doc: current.doc, sheetNo: current.sheetNo, otherSheets: others(current), tagScheme: null, registry }));
  const items = demo.sheets.flatMap((sheet) => sheet.document.items);

  it("is a seven-sheet A0 drawing of several thousand items drawn only with built-in symbols", () => {
    expect(demo.sheets).toHaveLength(7);
    expect(items.length).toBeGreaterThan(4500);
    for (const item of items) if (item.kind === "symbol") expect(registry.has(item.symbol), item.id).toBe(true);
    // Ids are unique across the whole drawing, which pairing off-page connectors relies on.
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  it("draws every engine out, with the relighting engines fed from the on-board spin-start bottles", () => {
    const engines = items.filter((item) => item.kind === "equipment" && /^E-\d\d$/.test(item.tag ?? ""));
    expect(engines).toHaveLength(ENGINE_COUNT);
    const refs = items.flatMap((item) => (item.kind === "symbol" && typeof item.fields.ref === "string" ? [item.fields.ref] : []));
    expect(refs.filter((ref) => ref.startsWith("SPIN-E"))).toHaveLength(2 * INNER_ENGINES);
    expect(refs.filter((ref) => ref.startsWith("LOX-E"))).toHaveLength(2 * ENGINE_COUNT);
  });

  it("keeps every symbol and line vertex on the drafting grid", () => {
    const onGrid = (value: number) => Math.abs(value / DEFAULT_GRID_MM - Math.round(value / DEFAULT_GRID_MM)) < 1e-9;
    for (const item of items) {
      if (item.kind === "symbol") expect(onGrid(item.position.x) && onGrid(item.position.y), item.id).toBe(true);
      if (item.kind === "line") for (const point of item.points) expect(onGrid(point.x) && onGrid(point.y), item.id).toBe(true);
    }
  });

  it("pairs every off-page connector with one on another sheet", () => {
    let connectors = 0;
    for (const current of sheets) {
      const { targets, unmatched } = resolveConnectorTargets(current, others(current));
      expect(unmatched, `sheet ${current.sheetNo}`).toEqual([]);
      connectors += Object.keys(targets).length;
      for (const target of Object.values(targets)) expect(target.startsWith(`SHT ${current.sheetNo} /`), target).toBe(false);
    }
    expect(connectors).toBe(2 * (5 * ENGINE_COUNT + INNER_ENGINES + 8));
  });

  it("has no design rule errors, dangling lines, open ports, or tag problems on any sheet", () => {
    for (const [index, payload] of payloads.entries()) {
      const findings = payload.drc.findings;
      expect(findings.filter((finding) => finding.severity === "error"), `sheet ${index + 1}`).toEqual([]);
      // What remains is for a reviewer to judge: sections without their own relief device.
      for (const finding of findings) expect(["relief_coverage", "trapped_volume"], finding.message).toContain(finding.rule);
    }
  });

  it("uses each tag once across the drawing", () => {
    const tags = payloads.flatMap((payload) => payload.index.items.map((item) => item.tag).filter(Boolean));
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags).toEqual(expect.arrayContaining(["TK-4101", "TK-4201", "MAN-5201", "XV-5333", "CV-6233", "XV-0101", "MCC-3326", "QD-3330"]));
  });

  it("renders every sheet at paper size", () => {
    for (const [index, payload] of payloads.entries()) {
      const svg = renderDocumentSvg(payload.doc, registry, { context: { number: demo.number, title: demo.title, sheetNo: index + 1, sheetCount: sheets.length, notes: demo.notes, revisions: [] } });
      expect(svg).toContain('viewBox="0 0 1189 841"');
    }
  });
});
