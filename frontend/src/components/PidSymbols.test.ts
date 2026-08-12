import { describe, expect, it } from "vitest";
import { rotatedPortFraction } from "./pid/nodes";
import { roundedOrthogonalPath } from "./pid/OrthogonalEdge";
import { importSvgMarkup } from "./pid/SymbolEditorModal";
import {
  PALETTE_SYMBOLS,
  SYMBOL_PORTS,
  customSymbolId,
  customSymbolType,
  parseViewBox
} from "./PidSymbols";

describe("symbol ports", () => {
  it("declares at least one port for every palette symbol", () => {
    for (const symbol of PALETTE_SYMBOLS) {
      expect(SYMBOL_PORTS[symbol]?.length, symbol).toBeGreaterThan(0);
    }
  });

  it("keeps all port coordinates inside the shared viewBox", () => {
    const viewBox = parseViewBox(undefined);
    for (const [symbol, ports] of Object.entries(SYMBOL_PORTS)) {
      for (const port of ports) {
        expect(port.x, `${symbol}:${port.id} x`).toBeGreaterThanOrEqual(viewBox.x);
        expect(port.x, `${symbol}:${port.id} x`).toBeLessThanOrEqual(viewBox.x + viewBox.width);
        expect(port.y, `${symbol}:${port.id} y`).toBeGreaterThanOrEqual(viewBox.y);
        expect(port.y, `${symbol}:${port.id} y`).toBeLessThanOrEqual(viewBox.y + viewBox.height);
      }
    }
  });

  it("gives ports unique ids per symbol", () => {
    for (const [symbol, ports] of Object.entries(SYMBOL_PORTS)) {
      const ids = ports.map((port) => port.id);
      expect(new Set(ids).size, symbol).toBe(ids.length);
    }
  });
});

describe("rotatedPortFraction", () => {
  const viewBox = { x: 0, y: 0, width: 64, height: 40 };
  const right = { x: 62, y: 20 }; // valve outlet, mid-height right edge

  it("keeps unrotated ports where they are", () => {
    const { fx, fy } = rotatedPortFraction(right.x, right.y, viewBox, 0);
    expect(fx).toBeCloseTo(62 / 64);
    expect(fy).toBeCloseTo(0.5);
  });

  it("moves a right port to the bottom on 90° clockwise rotation", () => {
    const { fx, fy } = rotatedPortFraction(right.x, right.y, viewBox, 90);
    expect(fx).toBeCloseTo(0.5);
    // Overhangs the box: the wide drawing sticks out below when rotated.
    expect(fy).toBeCloseTo(1.25);
  });

  it("mirrors ports on 180° rotation", () => {
    const { fx, fy } = rotatedPortFraction(right.x, right.y, viewBox, 180);
    expect(fx).toBeCloseTo(2 / 64);
    expect(fy).toBeCloseTo(0.5);
  });

  it("moves a right port to the top on 270° rotation", () => {
    const { fx, fy } = rotatedPortFraction(right.x, right.y, viewBox, 270);
    expect(fx).toBeCloseTo(0.5);
    expect(fy).toBeCloseTo(-0.25);
  });

  it("matches the CSS rotation of a top port at 90°", () => {
    // Tank top port (32, 2) should land on the right, mid-height, after 90° CW.
    const { fx, fy } = rotatedPortFraction(32, 2, viewBox, 90);
    expect(fx).toBeCloseTo(0.78125);
    expect(fy).toBeCloseTo(0.5);
  });
});

describe("roundedOrthogonalPath", () => {
  it("rounds corners with quadratic bends", () => {
    const path = roundedOrthogonalPath([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 30 }
    ]);
    expect(path).toBe("M 0,0 L 17,0 Q 20,0 20,3 L 20,30");
  });

  it("skips zero-length segments without producing NaN", () => {
    const path = roundedOrthogonalPath([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 }
    ]);
    expect(path).not.toContain("NaN");
    expect(path.startsWith("M 0,0")).toBe(true);
  });

  it("clamps the radius on very short segments", () => {
    const path = roundedOrthogonalPath([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 40 }
    ]);
    // Radius limited to half the 2-unit inbound segment.
    expect(path).toBe("M 0,0 L 1,0 Q 2,0 2,1 L 2,40");
  });
});

describe("custom symbol types", () => {
  it("round-trips a symbol id through the custom type prefix", () => {
    expect(customSymbolId(customSymbolType("abc-123"))).toBe("abc-123");
    expect(customSymbolId("valve")).toBeNull();
  });
});

describe("importSvgMarkup", () => {
  it("wraps bare path elements in the default viewBox", () => {
    const result = importSvgMarkup('<path d="M2 20 H62" />');
    expect(result.viewBox).toBe("0 0 64 40");
    expect(result.inner).toContain("path");
  });

  it("keeps the source viewBox of a full svg document", () => {
    const result = importSvgMarkup('<svg viewBox="0 0 100 50"><circle cx="50" cy="25" r="10" /></svg>');
    expect(result.viewBox).toBe("0 0 100 50");
    expect(result.inner).toContain("circle");
  });

  it("strips scripts and event handler attributes", () => {
    const result = importSvgMarkup(
      '<svg viewBox="0 0 64 40"><script>alert(1)</script><rect width="4" height="4" onclick="alert(1)" /></svg>'
    );
    expect(result.inner).not.toContain("script");
    expect(result.inner).not.toContain("onclick");
  });

  it("rejects markup with no drawable content", () => {
    expect(() => importSvgMarkup('<svg viewBox="0 0 64 40"><script>x</script></svg>')).toThrow();
  });
});
