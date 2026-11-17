import { describe, expect, it } from "vitest";
import { BUILTIN_SYMBOLS, SymbolRegistry } from "./library";
import { CAPTION_GAP_MM, LINE_STYLES, TEXT_MM, captionSideFor, renderSymbol } from "./render";
import { markProcessStubs, pathPoints, svgInkBounds } from "./svgBounds";
import type { SymbolItem } from "./types";

const registry = SymbolRegistry.withBuiltins();

function symbol(key: string, patch: Partial<SymbolItem> = {}): SymbolItem {
  return { id: key, kind: "symbol", layer: "symbols", symbol: { library: "fsdp", key, version: 1 }, position: { x: 100, y: 100 }, rotation: 0, fields: {}, ...patch };
}

/** x, y, and anchor of the caption text of a rendered symbol. */
function caption(svg: string, value: string) {
  const match = new RegExp(`<text x="(-?[\\d.]+)" y="(-?[\\d.]+)"[^>]*text-anchor="(\\w+)"[^>]*>${value}<`).exec(svg);
  if (!match) throw new Error(`no caption ${value}`);
  return { x: Number(match[1]), y: Number(match[2]), anchor: match[3] };
}

describe("svgInkBounds", () => {
  it("measures paths, circles, and rects", () => {
    expect(svgInkBounds('<path d="M-6,-3.5 L0,0 L-6,3.5 Z M6,-3.5 L0,0 L6,3.5 Z"/>')).toEqual({ x: -6, y: -3.5, width: 12, height: 7 });
    expect(svgInkBounds('<circle cx="0" cy="-7" r="3"/><rect x="-5" y="-2" width="4" height="6"/>')).toEqual({ x: -5, y: -10, width: 8, height: 14 });
    expect(svgInkBounds("<text>S</text>")).toBeNull();
  });

  it("follows arcs and curves beyond their end points", () => {
    // A dome: the arc rises 3 above the chord it ends on.
    expect(svgInkBounds('<path d="M-5,-6 A5,3 0 0 1 5,-6 Z"/>')).toEqual({ x: -5, y: -9, width: 10, height: 3 });
    const curve = svgInkBounds('<path d="M-3,-5 Q4,0 -3,5"/>')!;
    expect(curve.x).toBe(-3);
    expect(curve.width).toBeCloseTo(3.5, 1);
  });

  it("reads relative commands and implicit line-tos", () => {
    expect(pathPoints("M2,-1.5 l3,-1.5 M0,0 5,5 h-2 v1")).toEqual([
      { x: 2, y: -1.5 },
      { x: 5, y: -3 },
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 3, y: 5 },
      { x: 3, y: 6 }
    ]);
  });

  it("gives every built-in symbol an outline that contains its ports' stubs and stays near its footprint", () => {
    for (const definition of BUILTIN_SYMBOLS) {
      const ink = definition.ink;
      expect(ink, definition.key).toBeTruthy();
      // Nothing is drawn far outside the nominal footprint (which is what the editor selects by).
      expect(ink!.x, definition.key).toBeGreaterThanOrEqual(-definition.width / 2 - 2.6);
      expect(ink!.x + ink!.width, definition.key).toBeLessThanOrEqual(definition.width / 2 + 2.6);
    }
  });
});

describe("markProcessStubs", () => {
  const ports = [
    { x: -10, y: 0, kind: "process" },
    { x: 10, y: 0, kind: "process" },
    { x: 0, y: -10, kind: "signal" }
  ];

  it("separates the runs that end on a process port, and only those", () => {
    const marked = markProcessStubs('<path d="M-6,-3.5 L0,0 Z M-10,0 H-6 M6,0 H10 M0,0 V-10"/><circle cx="0" cy="0" r="1"/>', ports);
    expect(marked).toBe('<path d="M-6,-3.5 L0,0 Z M0,0 V-10"/><path data-stub d="M-10,0 H-6 M6,0 H10"/><circle cx="0" cy="0" r="1"/>');
  });

  it("leaves markup without such runs, and styled paths, alone", () => {
    const body = '<path d="M-6,-3.5 L0,0 Z"/><path d="M-10,0 H10" stroke-dasharray="1 1"/>';
    expect(markProcessStubs(body, ports)).toBe(body);
    expect(markProcessStubs('<path d="M-10,0 H-6"/>', [])).toBe('<path d="M-10,0 H-6"/>');
  });

  it("marks the stubs of every inline built-in valve", () => {
    for (const key of ["valve", "ball_valve", "check_valve", "three_way_valve", "relief_valve", "regulator"]) {
      expect(registry.builtin(key).svg, key).toContain("data-stub");
    }
  });
});

describe("symbol rendering", () => {
  const ctx = { registry };

  it("draws connection stubs at pipe weight, whatever the symbol scale", () => {
    expect(renderSymbol(symbol("valve"), ctx)).toContain(`<path stroke-width="${LINE_STYLES.process.width}" d="M-10,0 H-6 M6,0 H10"/>`);
    expect(renderSymbol(symbol("valve", { scale: 2 }), ctx)).toContain(`<path stroke-width="${LINE_STYLES.process.width / 2}" d=`);
    expect(renderSymbol(symbol("valve"), ctx)).not.toContain("data-stub");
  });

  it("puts the caption below by default, a fixed gap under the drawn outline", () => {
    // A gate valve body is 7 mm tall; a hand valve has a stem above, which must not push the tag down.
    for (const key of ["valve", "hand_valve"]) {
      const at = caption(renderSymbol(symbol(key, { tag: "HV-1" }), ctx), "HV-1");
      expect(at).toMatchObject({ x: 100, anchor: "middle" });
      expect(at.y, key).toBeCloseTo(100 + 3.5 + CAPTION_GAP_MM + TEXT_MM * 0.75, 1);
    }
  });

  it("moves the caption off any side a line leaves from", () => {
    expect(captionSideFor(["left", "right"])).toBe("bottom");
    expect(captionSideFor(["left", "right", "bottom"])).toBe("top");
    expect(captionSideFor(["top", "bottom"])).toBe("right");
    expect(captionSideFor(["top", "bottom", "right"])).toBe("left");
    expect(captionSideFor(["top", "bottom", "left", "right"])).toBe("corner");

    // A three-way valve has a branch below: tag above.
    expect(caption(renderSymbol(symbol("three_way_valve", { tag: "HV-3" }), ctx), "HV-3").y).toBeLessThan(100 - 3.5);
    // The same valve on a vertical line: tag beside it, clear of both pipe ends.
    const beside = caption(renderSymbol(symbol("valve", { tag: "HV-2", rotation: 90 }), ctx), "HV-2");
    expect(beside.anchor).toBe("start");
    expect(beside.x).toBeCloseTo(100 + 3.5 + CAPTION_GAP_MM);
  });

  it("captions vents and drains beside the symbol, and letters a large vessel inside", () => {
    const vent = caption(renderSymbol(symbol("vent_atmosphere", { tag: "VENT-1" }), ctx), "VENT-1");
    expect(vent.y).toBeGreaterThan(100);
    const small = caption(renderSymbol(symbol("tank", { tag: "TK-1" }), ctx), "TK-1");
    expect(small.anchor).toBe("start");
    const large = caption(renderSymbol(symbol("tank", { tag: "TK-1", scale: 4 }), ctx), "TK-1");
    expect(large).toMatchObject({ x: 100, anchor: "middle" });
    expect(large.y).toBeGreaterThan(100 - 40);
    expect(large.y).toBeLessThan(100);
    // Terminators still carry their text inside the flag.
    expect(caption(renderSymbol(symbol("terminator", { label: "TO VENT" }), ctx), "TO VENT")).toMatchObject({ y: 100.9 });
  });

  it("keeps lettering inside a symbol upright when it is rotated or mirrored", () => {
    expect(renderSymbol(symbol("solenoid_valve"), ctx)).not.toContain("rotate(-");
    expect(renderSymbol(symbol("solenoid_valve", { rotation: 90 }), ctx)).toMatch(/<text x="0" y="-5.4" font-size="3.2" transform="translate\(0 -6.52\) rotate\(-90\) translate\(0 6.52\)"/);
    expect(renderSymbol(symbol("solenoid_valve", { rotation: 270, mirror: true }), ctx)).toContain("scale(-1 1) rotate(-270)");
  });

  it("sets long instrument letters smaller so they stay inside the bubble", () => {
    const size = (tag: string, part: string) => new RegExp(`font-size="([\\d.]+)"[^>]*>${part}<`).exec(renderSymbol(symbol("instrument", { tag }), ctx))?.[1];
    expect(size("PT-101", "PT")).toBe("2.2");
    expect(size("PDIT-101", "PDIT")).toBe("1.9");
    expect(size("PT-10241", "10241")).toBe("1.9");
  });
});
