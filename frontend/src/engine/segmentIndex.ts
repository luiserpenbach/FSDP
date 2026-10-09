/**
 * Uniform grid over line segments, for "which lines pass near this point?"
 * queries. Item-level `SpatialIndex` buckets a line by its whole bounding box,
 * which on a busy sheet makes every long line a candidate everywhere; this
 * buckets each segment separately so a point query only sees nearby runs.
 */
import { EPSILON } from "./geometry";
import type { LineItem } from "./types";

/** Cell coordinates are packed into one number: |cell| must stay below 2^20. */
const CELL_OFFSET = 1 << 20;
const CELL_STRIDE = 1 << 21;
/** Upper bound on cells per axis, so huge coordinates cannot blow up the grid. */
const MAX_CELLS_PER_AXIS = 256;
const MIN_CELL_SIZE = 10;

function cellKey(cx: number, cy: number): number {
  return (cx + CELL_OFFSET) * CELL_STRIDE + (cy + CELL_OFFSET);
}

export class SegmentIndex {
  private readonly cells = new Map<number, number[]>();
  readonly cellSize: number;
  private static readonly EMPTY: readonly number[] = [];

  /**
   * @param lines lines to index; queries return indices into this array.
   * @param pad   how far (mm) around each segment a query point still counts
   *              as "near". Must be at least the tolerance later used for hit
   *              tests; it covers both the distance-to-segment test and the
   *              per-axis end-point comparison.
   */
  constructor(readonly lines: readonly LineItem[], readonly pad = EPSILON * 2) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const line of lines) {
      for (const point of line.points) {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.y > maxY) maxY = point.y;
      }
    }
    const extent = Number.isFinite(minX) ? Math.max(maxX - minX, maxY - minY) : 0;
    this.cellSize = Math.max(MIN_CELL_SIZE, extent / MAX_CELLS_PER_AXIS);

    lines.forEach((line, lineIndex) => {
      const points = line.points;
      // A single-point line still answers end-point queries.
      const segments = Math.max(1, points.length - 1);
      for (let segment = 0; segment < segments && points.length > 0; segment += 1) {
        const a = points[segment];
        const b = points[Math.min(segment + 1, points.length - 1)];
        const x0 = this.cell(Math.min(a.x, b.x) - pad);
        const x1 = this.cell(Math.max(a.x, b.x) + pad);
        const y0 = this.cell(Math.min(a.y, b.y) - pad);
        const y1 = this.cell(Math.max(a.y, b.y) + pad);
        for (let cx = x0; cx <= x1; cx += 1) {
          for (let cy = y0; cy <= y1; cy += 1) {
            const key = cellKey(cx, cy);
            const bucket = this.cells.get(key);
            if (!bucket) this.cells.set(key, [lineIndex]);
            // Lines are inserted in order, so a repeat is always the last entry.
            else if (bucket[bucket.length - 1] !== lineIndex) bucket.push(lineIndex);
          }
        }
      }
    });
  }

  private cell(value: number): number {
    return Math.floor(value / this.cellSize);
  }

  /**
   * Indices (ascending) of lines with a segment whose padded bounding box
   * contains `point`: a superset of the lines within `pad` of it.
   */
  near(point: { x: number; y: number }): readonly number[] {
    return this.cells.get(cellKey(this.cell(point.x), this.cell(point.y))) ?? SegmentIndex.EMPTY;
  }
}
