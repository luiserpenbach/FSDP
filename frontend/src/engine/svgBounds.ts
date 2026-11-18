/**
 * Ink bounds of the simple SVG the built-in symbols are drawn with: paths
 * (M L H V A Q C Z, absolute or relative), circles, and rects. Curves are
 * sampled, which is exact enough for placing captions. Text is ignored: it
 * always sits inside the outline it labels.
 */
import type { Point, Rect } from "./types";

const ARC_STEPS = 24;
const CURVE_STEPS = 12;

function attr(tag: string, name: string): number {
  const match = new RegExp(`\\s${name}="(-?[\\d.]+)"`).exec(tag);
  return match ? Number(match[1]) : 0;
}

/** Points along an SVG elliptical arc (endpoint parameterization, SVG 1.1 F.6.5). */
function arcPoints(from: Point, rx: number, ry: number, rotationDeg: number, largeArc: boolean, sweep: boolean, to: Point): Point[] {
  if (!rx || !ry || (from.x === to.x && from.y === to.y)) return [to];
  const phi = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  let a = Math.abs(rx);
  let b = Math.abs(ry);
  const lambda = (x1 * x1) / (a * a) + (y1 * y1) / (b * b);
  if (lambda > 1) {
    a *= Math.sqrt(lambda);
    b *= Math.sqrt(lambda);
  }
  const numerator = a * a * b * b - a * a * y1 * y1 - b * b * x1 * x1;
  const factor = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator) / (a * a * y1 * y1 + b * b * x1 * x1));
  const cx1 = (factor * a * y1) / b;
  const cy1 = (-factor * b * x1) / a;
  const cx = cos * cx1 - sin * cy1 + (from.x + to.x) / 2;
  const cy = sin * cx1 + cos * cy1 + (from.y + to.y) / 2;
  const angle = (ux: number, uy: number) => Math.atan2(uy, ux);
  const start = angle((x1 - cx1) / a, (y1 - cy1) / b);
  let delta = angle((-x1 - cx1) / a, (-y1 - cy1) / b) - start;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  const points: Point[] = [];
  for (let step = 1; step <= ARC_STEPS; step += 1) {
    const theta = start + (delta * step) / ARC_STEPS;
    const ex = a * Math.cos(theta);
    const ey = b * Math.sin(theta);
    points.push({ x: cos * ex - sin * ey + cx, y: sin * ex + cos * ey + cy });
  }
  return points;
}

function bezier(points: Point[]): Point[] {
  const out: Point[] = [];
  for (let step = 1; step <= CURVE_STEPS; step += 1) {
    const t = step / CURVE_STEPS;
    let level = points;
    while (level.length > 1) {
      level = level.slice(1).map((point, index) => ({ x: level[index].x + (point.x - level[index].x) * t, y: level[index].y + (point.y - level[index].y) * t }));
    }
    out.push(level[0]);
  }
  return out;
}

/** Vertices (with curves sampled) of a path's `d` attribute. */
export function pathPoints(d: string): Point[] {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  const points: Point[] = [];
  let index = 0;
  let command = "";
  let current: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  const number = () => Number(tokens[index++]);
  const isNumber = () => index < tokens.length && !/^[a-zA-Z]$/.test(tokens[index]);
  while (index < tokens.length) {
    if (!isNumber()) command = tokens[index++];
    const relative = command === command.toLowerCase();
    const base = relative ? current : { x: 0, y: 0 };
    const point = (): Point => ({ x: base.x + number(), y: base.y + number() });
    switch (command.toUpperCase()) {
      case "M": {
        current = point();
        start = current;
        points.push(current);
        // Further pairs after a moveto are implicit linetos.
        command = relative ? "l" : "L";
        break;
      }
      case "L":
        current = point();
        points.push(current);
        break;
      case "H":
        current = { x: base.x + number(), y: current.y };
        points.push(current);
        break;
      case "V":
        current = { x: current.x, y: base.y + number() };
        points.push(current);
        break;
      case "Q": {
        const control = point();
        const end = point();
        points.push(...bezier([current, control, end]));
        current = end;
        break;
      }
      case "C": {
        const first = point();
        const second = point();
        const end = point();
        points.push(...bezier([current, first, second, end]));
        current = end;
        break;
      }
      case "A": {
        const rx = number();
        const ry = number();
        const rotation = number();
        const largeArc = number() === 1;
        const sweep = number() === 1;
        const end = point();
        points.push(...arcPoints(current, rx, ry, rotation, largeArc, sweep, end));
        current = end;
        break;
      }
      case "Z":
        current = start;
        break;
      default:
        // Unknown command: stop rather than misread the rest.
        return points;
    }
  }
  return points;
}

/** Bounding box of the drawn geometry, or null when the markup has none this reader knows. */
export function svgInkBounds(svg: string): Rect | null {
  const points: Point[] = [];
  for (const match of svg.matchAll(/<path\b[^>]*\sd="([^"]*)"/g)) points.push(...pathPoints(match[1]));
  for (const match of svg.matchAll(/<circle\b[^>]*>/g)) {
    const cx = attr(match[0], "cx");
    const cy = attr(match[0], "cy");
    const r = attr(match[0], "r");
    points.push({ x: cx - r, y: cy - r }, { x: cx + r, y: cy + r });
  }
  for (const match of svg.matchAll(/<rect\b[^>]*>/g)) {
    const x = attr(match[0], "x");
    const y = attr(match[0], "y");
    points.push({ x, y }, { x: x + attr(match[0], "width"), y: y + attr(match[0], "height") });
  }
  if (!points.length) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const round = (value: number) => Math.round(value * 100) / 100;
  return { x: round(minX), y: round(minY), width: round(Math.max(...xs) - minX), height: round(Math.max(...ys) - minY) };
}

/**
 * Split the straight runs that end on a process port out of attribute-less
 * paths, marked `data-stub`. They are part of the pipe, so the renderer draws
 * them at pipe weight instead of the thinner symbol outline.
 */
export function markProcessStubs(svg: string, ports: Array<{ x: number; y: number; kind?: string }>): string {
  const pipePorts = ports.filter((port) => port.kind !== "signal");
  if (!pipePorts.length) return svg;
  const onPort = (x: number, y: number) => pipePorts.some((port) => port.x === x && port.y === y);
  return svg.replace(/<path d="([^"]*)"\/>/g, (whole, d: string) => {
    const stubs: string[] = [];
    const rest: string[] = [];
    for (const subpath of d.split(/(?=M)/).map((part) => part.trim()).filter(Boolean)) {
      const match = /^M(-?[\d.]+),(-?[\d.]+)\s*([HV])(-?[\d.]+)$/.exec(subpath);
      if (match) {
        const x = Number(match[1]);
        const y = Number(match[2]);
        const end = Number(match[4]);
        const [endX, endY] = match[3] === "H" ? [end, y] : [x, end];
        if (onPort(x, y) || onPort(endX, endY)) {
          stubs.push(subpath);
          continue;
        }
      }
      rest.push(subpath);
    }
    if (!stubs.length) return whole;
    return `${rest.length ? `<path d="${rest.join(" ")}"/>` : ""}<path data-stub d="${stubs.join(" ")}"/>`;
  });
}
