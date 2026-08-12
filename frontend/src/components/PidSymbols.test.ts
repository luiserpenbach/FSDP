import { describe, expect, it } from "vitest";
import { Position } from "reactflow";
import { rotatedPortFraction } from "./pid/nodes";
import {
  ROUTE_STUB,
  buildOrthogonalRoute,
  cleanupWaypoints,
  dominantDirection,
  roundedOrthogonalPath,
  translateEdgeGeometry
} from "./pid/OrthogonalEdge";
import { importSvgMarkup, linePath, normalizedRect } from "./pid/SymbolEditorModal";
import { sanitizeSvgInner } from "./pid/svgSanitize";
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
      // Junctions are bare connection dots (pidJunction nodes) with their own
      // single handle; they never consult SYMBOL_PORTS.
      if (symbol === "junction") continue;
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

describe("buildOrthogonalRoute", () => {
  it("keeps the classic thirds route for a plain right-to-left run", () => {
    const route = buildOrthogonalRoute({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 300,
      targetY: 0,
      targetPosition: Position.Left
    });
    // Backbone verticals at the thirds: x = 100 and x = 200.
    expect(route.corners[0]).toEqual({ x: 100, y: 0 });
    expect(route.corners[2]).toEqual({ x: 200, y: 0 });
    // Same-height ports collapse to a straight line.
    expect(route.points.every((point) => point.y === 0)).toBe(true);
  });

  it("leaves a top port vertically and runs the bend at stub level", () => {
    const route = buildOrthogonalRoute({
      sourceX: 0,
      sourceY: 100,
      sourcePosition: Position.Top,
      targetX: 300,
      targetY: 200,
      targetPosition: Position.Left
    });
    expect(route.points[1]).toEqual({ x: 0, y: 100 - ROUTE_STUB });
    expect(route.corners[0]).toEqual({ x: 100, y: 100 - ROUTE_STUB });
  });

  it("routes out through a left port even when the target is to the right", () => {
    const route = buildOrthogonalRoute({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Left,
      targetX: 300,
      targetY: 100,
      targetPosition: Position.Left
    });
    expect(route.corners[0]).toEqual({ x: -ROUTE_STUB, y: 0 });
    // Target's left port keeps its natural approach from the left.
    expect(route.corners[2].x).toBe(200);
  });

  it("enforces a minimum straight run when nodes are close", () => {
    const route = buildOrthogonalRoute({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 20,
      targetY: 80,
      targetPosition: Position.Left
    });
    expect(route.corners[0].x).toBe(ROUTE_STUB);
    expect(route.corners[2].x).toBe(20 - ROUTE_STUB);
  });

  it("respects stored bend parameters over defaults", () => {
    const route = buildOrthogonalRoute({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 300,
      targetY: 100,
      targetPosition: Position.Left,
      data: { startX: 42, bendY: 77 }
    });
    expect(route.corners[1]).toEqual({ x: 42, y: 77 });
    expect(route.corners[2]).toEqual({ x: 200, y: 77 });
  });

  it("enters the target perpendicular to a bottom port", () => {
    const route = buildOrthogonalRoute({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 200,
      targetY: 150,
      targetPosition: Position.Bottom
    });
    const [entry, target] = route.points.slice(-2);
    expect(entry).toEqual({ x: 200, y: 150 + ROUTE_STUB });
    expect(target).toEqual({ x: 200, y: 150 });
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

describe("dominantDirection", () => {
  it("faces the axis with the larger delta", () => {
    expect(dominantDirection(0, 0, 100, 10)).toBe(Position.Right);
    expect(dominantDirection(0, 0, -100, 10)).toBe(Position.Left);
    expect(dominantDirection(0, 0, 10, 100)).toBe(Position.Bottom);
    expect(dominantDirection(0, 0, 10, -100)).toBe(Position.Top);
  });
});

describe("cleanupWaypoints", () => {
  it("drops duplicate and collinear corners", () => {
    const corners = cleanupWaypoints(
      [{ x: 50, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 80 }],
      { x: 0, y: 0 },
      { x: 50, y: 100 }
    );
    expect(corners).toEqual([{ x: 50, y: 0 }]);
  });
});

describe("translateEdgeGeometry", () => {
  it("shifts hand-placed waypoints and legacy bend parameters", () => {
    const moved = translateEdgeGeometry({ waypoints: [{ x: 10, y: 20 }], startX: 5, bendY: 7 }, 3, 4);
    expect(moved?.waypoints).toEqual([{ x: 13, y: 24 }]);
    expect(moved?.startX).toBe(8);
    expect(moved?.bendY).toBe(11);
  });

  it("returns the same object when there is no stored geometry", () => {
    const plain = { showArrow: true };
    expect(translateEdgeGeometry(plain, 3, 4)).toBe(plain);
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

  it("strips nested-SVG and SMIL vectors that bypassed script/onload checks", () => {
    const result = importSvgMarkup(
      [
        '<svg viewBox="0 0 64 40">',
        '<path d="M2 20 H62" />',
        '<use href="data:image/svg+xml;base64,PHN2Zz4=" />',
        '<set attributeName="onload" to="alert(1)"/>',
        '<style>@import "https://evil.example/x.css"</style>',
        "</svg>"
      ].join("")
    );
    expect(result.inner).toContain("path");
    expect(result.inner.toLowerCase()).not.toContain("<use");
    expect(result.inner.toLowerCase()).not.toContain("<set");
    expect(result.inner.toLowerCase()).not.toContain("<style");
    expect(result.inner.toLowerCase()).not.toContain("data:");
  });

  it("sanitizeSvgInner clears active content for render-time defense", () => {
    const cleaned = sanitizeSvgInner(
      '<path d="M0 0 H10" /><image href="data:image/svg+xml,%3Csvg%20onload%3Dalert(1)%3E" />'
    );
    expect(cleaned).toContain("path");
    expect(cleaned.toLowerCase()).not.toContain("<image");
    expect(cleaned.toLowerCase()).not.toContain("data:");
  });

  it("rejects markup with no drawable content", () => {
    expect(() => importSvgMarkup('<svg viewBox="0 0 64 40"><script>x</script></svg>')).toThrow();
  });
});

describe("linePath", () => {
  it("builds an absolute move/line path from clicked vertices", () => {
    expect(linePath([{ x: 2, y: 4 }, { x: 10, y: 4 }, { x: 10, y: 20 }])).toBe("M 2 4 L 10 4 L 10 20");
  });

  it("drops the duplicate vertex left behind by a finishing double-click", () => {
    expect(linePath([{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 0 }])).toBe("M 0 0 L 8 0");
  });

  it("returns null when fewer than two distinct points remain", () => {
    expect(linePath([])).toBeNull();
    expect(linePath([{ x: 4, y: 4 }])).toBeNull();
    expect(linePath([{ x: 4, y: 4 }, { x: 4, y: 4 }])).toBeNull();
  });
});

describe("normalizedRect", () => {
  it("normalizes a negative drag into a positive rect", () => {
    expect(normalizedRect({ x: 20, y: 30 }, { x: 4, y: 10 })).toEqual({ x: 4, y: 10, width: 16, height: 20 });
  });

  it("rejects rects under two units on either side", () => {
    expect(normalizedRect({ x: 0, y: 0 }, { x: 1, y: 40 })).toBeNull();
    expect(normalizedRect({ x: 0, y: 0 }, { x: 0, y: 0 })).toBeNull();
  });
});
