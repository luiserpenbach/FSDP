import { describe, expect, it } from "vitest";
import { smallPanelDocument } from "./fixtures";
import { titleBlockRect, wrapText, type DrawingContext } from "./frames";
import { SymbolRegistry } from "./library";
import { renderDocumentSvg, renderFrame } from "./render";
import { makeSheet } from "./sheet";

const registry = SymbolRegistry.withBuiltins();

function context(overrides: Partial<DrawingContext> = {}): DrawingContext {
  return {
    number: "AMB2-9003",
    title: "BROAD AREA COOLING\nP&ID PHASE 2\nFILL TEST",
    projectName: "AMB2",
    systemName: "Helium fill",
    company: "Sierra Lobo, Inc.",
    units: "in",
    status: "working",
    sheetNo: 1,
    sheetCount: 2,
    revisions: [
      { label: "-", description: "Initial issue", date: "2026-09-10", by: "J. Doe" },
      { label: "A", description: "Added vent line", date: "2026-09-12", approvedBy: "R. Eng" }
    ],
    notes: ["FOR COMPONENT IDENTIFICATION SEE AMB2-08-200-S002.", "ALL LINES TO BE INSULATED."],
    exportDate: "2026-09-10",
    ...overrides
  };
}

describe("frame templates", () => {
  it("places the title block at the bottom-right inside the border", () => {
    const sheet = { ...makeSheet("ANSI_E"), frame: { ...makeSheet("ANSI_E").frame, template: "fsdp-standard" as const } };
    const block = titleBlockRect(sheet);
    expect(block).toEqual({ x: 1117.6 - 10 - 180, y: 863.6 - 10 - 45, width: 180, height: 45 });
    expect(titleBlockRect(makeSheet("A3"))).toBeNull();
  });

  it("renders bound title block values, the revision table, notes, and the proprietary notice", () => {
    const doc = smallPanelDocument();
    doc.sheet.frame.template = "fsdp-standard";
    const svg = renderFrame(doc, context());
    for (const expected of [
      ">AMB2-9003<",
      ">BROAD AREA COOLING<",
      ">FILL TEST<",
      ">Sierra Lobo, Inc.<",
      ">WORKING<",
      ">1 OF 2<",
      ">A3<",
      ">IN<",
      ">NO SCALE<",
      ">FSDP<",
      ">REVISIONS<",
      ">Added vent line<",
      ">R. Eng<",
      ">GENERAL NOTES:<",
      ">1.<",
      ">2.<",
      "ALL LINES TO BE INSULATED.",
      "PROPRIETARY. THIS DOCUMENT CONTAINS"
    ]) {
      expect(svg, expected).toContain(expected);
    }
    // Current revision letter appears in the REV cell.
    expect(svg).toContain(">A<");
    // Proprietary notice names the company.
    expect(svg).toContain("Sierra Lobo, Inc.");
  });

  it("draws only border and zones for the basic template, and nothing for none", () => {
    const doc = smallPanelDocument();
    const basic = renderFrame(doc, context());
    expect(basic).not.toContain("REVISIONS");
    expect(basic).not.toContain("DRAWING NO.");
    expect(basic).toContain('stroke-width="0.7"');
    doc.sheet.frame.template = "none";
    expect(renderFrame(doc, context())).toBe("");
  });

  it("threads the context through the full-sheet export", () => {
    const doc = smallPanelDocument();
    doc.sheet.frame.template = "fsdp-standard";
    const svg = renderDocumentSvg(doc, registry, { context: context({ number: "DWG-0007" }) });
    expect(svg).toContain(">DWG-0007<");
    expect(svg).toContain('data-id="hv"');
    // Without a context the block still renders with empty cells.
    const bare = renderDocumentSvg(doc, registry);
    expect(bare).toContain(">DRAWING NO.<");
    expect(bare).not.toContain("PROPRIETARY");
  });

  it("wraps long note text by width", () => {
    const lines = wrapText("THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG AGAIN AND AGAIN", 40, 2.5);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe("THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG AGAIN AND AGAIN");
    expect(wrapText("one\ntwo", 100, 2.5)).toEqual(["one", "two"]);
  });
});
