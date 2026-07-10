import { describe, expect, it } from "vitest";
import { gridSizeInPixels, normalizeEdge, orthogonalPath, routeOrthogonal } from "./pidEditor";

describe("P&ID editor geometry", () => {
  it("converts millimetres to CSS pixels", () => {
    expect(gridSizeInPixels({ gridVisible: true, snapToGrid: true, unit: "mm", gridSize: 25.4 })).toBeCloseTo(96);
    expect(gridSizeInPixels({ gridVisible: true, snapToGrid: true, unit: "px", gridSize: 12 })).toBe(12);
  });

  it("creates an orthogonal route around an obstacle", () => {
    const obstacle = { x: 80, y: -30, width: 40, height: 60 };
    const points = routeOrthogonal({ x: 0, y: 0 }, { x: 200, y: 0 }, [obstacle], 10, 5);

    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points.at(-1)).toEqual({ x: 200, y: 0 });
    expect(points.some((point) => point.y !== 0)).toBe(true);
    for (let index = 0; index < points.length - 1; index += 1) {
      expect(points[index].x === points[index + 1].x || points[index].y === points[index + 1].y).toBe(true);
    }
  });

  it("keeps legacy bend data while adopting the new edge type", () => {
    const edge = normalizeEdge({
      id: "legacy",
      source: "a",
      target: "b",
      type: "orthogonal",
      data: { startX: 30, bendY: 50, endX: 90 }
    });

    expect(edge.type).toBe("pidLine");
    expect(edge.data?.routing).toBe("manual");
    expect(edge.data?.startX).toBe(30);
  });

  it("serializes a polyline as an SVG path", () => {
    expect(orthogonalPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }])).toBe(
      "M 0 0 L 10 0 L 10 20"
    );
  });
});
