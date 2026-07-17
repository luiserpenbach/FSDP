import type { Edge, Node } from "reactflow";
import { allSymbols, nodeSize, portWorldPosition } from "../model/document";
import type { PidDocument, PidEdgeData, PidNodeData, Point } from "../model/types";
import { resolveWaypoints } from "../routing/orthogonal";

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function polyline(points: Point[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

/** Serialize the diagram to a standalone SVG string (print / download). */
export function documentToSvg(doc: PidDocument, title = "P&ID"): string {
  const symbols = allSymbols(doc);
  const visible = new Set(doc.settings.hiddenLineClasses ?? []);
  const edges = doc.edges.filter((edge) => !visible.has(edge.data?.lineClass as never));
  const nodes = doc.nodes.filter((node) => node.data.kind !== "junction" || doc.edges.some((e) => e.source === node.id || e.target === node.id));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  function expand(x: number, y: number) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  for (const node of nodes) {
    const size = nodeSize(node);
    expand(node.position.x, node.position.y);
    expand(node.position.x + size.width, node.position.y + size.height);
  }
  for (const edge of edges) {
    for (const point of edgePoints(edge, doc.nodes, symbols)) expand(point.x, point.y);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 800;
    maxY = 600;
  }

  const pad = 40;
  const width = Math.max(100, maxX - minX + pad * 2);
  const height = Math.max(100, maxY - minY + pad * 2);
  const ox = -minX + pad;
  const oy = -minY + pad;

  const edgeSvg = edges
    .map((edge) => {
      const points = edgePoints(edge, doc.nodes, symbols).map((point) => ({
        x: point.x + ox,
        y: point.y + oy
      }));
      if (points.length < 2) return "";
      const color = edge.data?.color ?? "#243248";
      const thickness = edge.data?.thickness ?? 2;
      const tag = edge.data?.tag ?? "";
      const mid = points[Math.floor(points.length / 2)];
      return [
        `<polyline fill="none" stroke="${esc(color)}" stroke-width="${thickness}" points="${polyline(points)}" />`,
        tag
          ? `<text x="${mid.x}" y="${mid.y - 6}" fill="#334155" font-family="Segoe UI, sans-serif" font-size="11">${esc(String(tag))}</text>`
          : ""
      ].join("\n");
    })
    .join("\n");

  const nodeSvg = nodes
    .map((node) => {
      const size = nodeSize(node);
      const x = node.position.x + ox;
      const y = node.position.y + oy;
      const def = symbols.find((symbol) => symbol.id === node.data.symbolType);
      const rotation = node.data.rotation ?? 0;
      const cx = x + size.width / 2;
      const cy = y + size.height / 2;
      const primitives = (def?.primitives ?? [])
        .map((primitive) => {
          const sw = primitive.strokeWidth ?? 2;
          if (primitive.kind === "line") {
            return `<line x1="${(primitive.x1 / 100) * size.width}" y1="${(primitive.y1 / 100) * size.height}" x2="${(primitive.x2 / 100) * size.width}" y2="${(primitive.y2 / 100) * size.height}" stroke="#111" stroke-width="${sw}" />`;
          }
          if (primitive.kind === "rect") {
            return `<rect x="${(primitive.x / 100) * size.width}" y="${(primitive.y / 100) * size.height}" width="${(primitive.width / 100) * size.width}" height="${(primitive.height / 100) * size.height}" fill="none" stroke="#111" stroke-width="${sw}" />`;
          }
          if (primitive.kind === "circle") {
            return `<circle cx="${(primitive.cx / 100) * size.width}" cy="${(primitive.cy / 100) * size.height}" r="${(primitive.r / 100) * size.width}" fill="none" stroke="#111" stroke-width="${sw}" />`;
          }
          if (primitive.kind === "polyline") {
            const pts = primitive.points
              .map((point) => `${(point.x / 100) * size.width},${(point.y / 100) * size.height}`)
              .join(" ");
            return `<polyline fill="none" stroke="#111" stroke-width="${sw}" points="${pts}" />`;
          }
          return "";
        })
        .join("");
      const label = node.data.label || def?.name || "";
      const offPage = node.data.offPageRef ? ` [${esc(node.data.offPageRef)}]` : "";
      return `<g transform="translate(${x} ${y}) rotate(${rotation} ${size.width / 2} ${size.height / 2})">
  <g>${primitives}</g>
  <text x="${size.width / 2}" y="${size.height + 14}" text-anchor="middle" fill="#1e293b" font-family="Segoe UI, sans-serif" font-size="11">${esc(label)}${offPage}</text>
</g>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <title>${esc(title)}</title>
  <rect width="100%" height="100%" fill="#ffffff"/>
  <g id="edges">${edgeSvg}</g>
  <g id="symbols">${nodeSvg}</g>
</svg>`;
}

function edgePoints(
  edge: Edge<PidEdgeData>,
  nodes: Node<PidNodeData>[],
  symbols: ReturnType<typeof allSymbols>
): Point[] {
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  if (!source || !target) return [];
  const start = portWorldPosition(source, edge.sourceHandle, symbols, 100);
  const end = portWorldPosition(target, edge.targetHandle, symbols, 0);
  return resolveWaypoints(start, end, edge.data?.waypoints);
}

export function downloadSvg(svg: string, filename: string) {
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.endsWith(".svg") ? filename : `${filename}.svg`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Open a print dialog with the SVG (browser → Save as PDF). */
export function printSvg(svg: string, title = "P&ID") {
  const popup = window.open("", "_blank", "noopener,noreferrer,width=1024,height=768");
  if (!popup) return;
  popup.document.write(`<!doctype html><html><head><title>${esc(title)}</title>
<style>
  @page { margin: 12mm; }
  html, body { margin: 0; background: #fff; }
  svg { width: 100%; height: auto; }
</style></head><body>${svg}</body></html>`);
  popup.document.close();
  popup.focus();
  popup.print();
}
