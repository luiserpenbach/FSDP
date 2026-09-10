/**
 * Convert a legacy React Flow diagram graph (pixels, edges between handles)
 * into a schematic document (mm, lines connected by geometry).
 *
 * Item ids are preserved so component bindings keyed by node external id keep
 * lining up with the converted symbols.
 */
import type { Edge, Node } from "reactflow";
import { customSymbolId } from "../components/PidSymbols";
import { normalizeRotation, orthogonalize, rectUnion, simplifyPolyline, snapPoint, snapValue } from "./geometry";
import { BUILTIN_LIBRARY, CUSTOM_LIBRARY, type SymbolRegistry } from "./library";
import { routeBetween } from "./routing";
import { SHEET_SIZES, frameRect, makeSheet } from "./sheet";
import { itemBounds } from "./spatial";
import {
  DEFAULT_GRID_MM,
  type EquipmentItem,
  type Item,
  type LabelItem,
  type LineItem,
  type LineType,
  type NoteItem,
  type Point,
  type Rect,
  type SchematicDocument,
  type SheetSizeId,
  type Side,
  type SymbolItem,
  type SymbolRef,
  createEmptyDocument
} from "./types";

/** Legacy default symbol box was 56 px wide; built-in symbols are 20 mm long. */
export const PX_TO_MM = 20 / 56;

const LEGACY_SYMBOL_KEYS: Record<string, string> = {
  valve: "valve",
  check_valve: "check_valve",
  regulator: "regulator",
  relief_valve: "relief_valve",
  sensor: "instrument",
  filter: "filter",
  source: "tank",
  tank: "tank",
  sink: "terminator",
  pump: "pump",
  component: "component"
};

const LEGACY_DEFAULT_SIZE = { width: 56, height: 50 };

type LegacyGraph = { nodes?: Node[]; edges?: Edge[] };

function symbolRefFor(symbolType: string): SymbolRef {
  const custom = customSymbolId(symbolType);
  if (custom) return { library: CUSTOM_LIBRARY, key: custom, version: 1 };
  return { library: BUILTIN_LIBRARY, key: LEGACY_SYMBOL_KEYS[symbolType] ?? "component", version: 1 };
}

function nodeSize(node: Node): { width: number; height: number } {
  const width = Number(node.width ?? node.style?.width ?? LEGACY_DEFAULT_SIZE.width);
  const height = Number(node.height ?? node.style?.height ?? LEGACY_DEFAULT_SIZE.height);
  return { width: Number.isFinite(width) ? width : LEGACY_DEFAULT_SIZE.width, height: Number.isFinite(height) ? height : LEGACY_DEFAULT_SIZE.height };
}

/** Absolute top-left in px, resolving section parents. */
function absolutePosition(node: Node, byId: Map<string, Node>): Point {
  let x = node.position?.x ?? 0;
  let y = node.position?.y ?? 0;
  let parentId = node.parentNode;
  let guard = 0;
  while (parentId && guard < 10) {
    const parent = byId.get(parentId);
    if (!parent) break;
    x += parent.position?.x ?? 0;
    y += parent.position?.y ?? 0;
    parentId = parent.parentNode;
    guard += 1;
  }
  return { x, y };
}

function legacyKind(node: Node): "symbol" | "section" | "text" | "comment" | "junction" {
  switch (node.type) {
    case "pidSection":
      return "section";
    case "pidText":
      return "text";
    case "pidComment":
      return "comment";
    case "pidJunction":
      return "junction";
    default:
      return "symbol";
  }
}

function pickSheet(content: Rect | null): SheetSizeId {
  if (!content) return "A3";
  const order: SheetSizeId[] = ["A4", "A3", "A2", "A1", "A0"];
  for (const size of order) {
    const paper = SHEET_SIZES[size];
    if (content.width + 40 <= paper.width && content.height + 40 <= paper.height) return size;
  }
  return "A0";
}

function lineTypeFor(edge: Edge): LineType {
  const style = edge.data?.strokeStyle as string | undefined;
  if (style === "dashed") return "signal_electric";
  if (style === "dotted") return "signal_software";
  return "process";
}

export function convertLegacyGraph(graph: LegacyGraph, registry: SymbolRegistry, options: { title?: string } = {}): SchematicDocument {
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const grid = DEFAULT_GRID_MM;

  // Pass 1: raw mm positions (no offset yet).
  const symbols: SymbolItem[] = [];
  const equipment: EquipmentItem[] = [];
  const labels: LabelItem[] = [];
  const notes: NoteItem[] = [];
  const junctionCentres = new Map<string, Point>();

  for (const node of nodes) {
    const data = (node.data ?? {}) as Record<string, unknown>;
    const topLeft = absolutePosition(node, byId);
    const size = nodeSize(node);
    const centre = { x: (topLeft.x + size.width / 2) * PX_TO_MM, y: (topLeft.y + size.height / 2) * PX_TO_MM };
    switch (legacyKind(node)) {
      case "section":
        equipment.push({
          id: node.id,
          kind: "equipment",
          layer: "equipment",
          position: { x: topLeft.x * PX_TO_MM, y: topLeft.y * PX_TO_MM },
          size: { width: size.width * PX_TO_MM, height: size.height * PX_TO_MM },
          name: String(data.label ?? "Section"),
          boundary: "dashed",
          color: typeof data.color === "string" ? data.color : undefined,
          fields: {}
        });
        break;
      case "text":
        labels.push({
          id: node.id,
          kind: "label",
          layer: "annotation",
          position: { x: topLeft.x * PX_TO_MM, y: topLeft.y * PX_TO_MM + 3 },
          text: String(data.text ?? ""),
          fontSize: Math.max(2.5, Number(data.fontSize ?? 14) * 0.22),
          rotation: 0,
          anchor: "start",
          color: typeof data.color === "string" ? data.color : undefined
        });
        break;
      case "comment":
        notes.push({
          id: node.id,
          kind: "note",
          layer: "notes",
          position: { x: topLeft.x * PX_TO_MM, y: topLeft.y * PX_TO_MM + 6 },
          text: String(data.text ?? ""),
          author: typeof data.author === "string" ? data.author : undefined,
          createdAt: typeof data.created_at === "string" ? data.created_at : undefined
        });
        break;
      case "junction":
        junctionCentres.set(node.id, centre);
        break;
      default: {
        const symbolType = String(data.symbolType ?? node.type ?? "component");
        const scaleFromWidth = (size.width * PX_TO_MM) / 20;
        symbols.push({
          id: node.id,
          kind: "symbol",
          layer: "symbols",
          symbol: symbolRefFor(symbolType),
          position: centre,
          rotation: normalizeRotation(Number(data.rotation ?? 0)),
          scale: Math.abs(scaleFromWidth - 1) < 0.15 ? undefined : Number(scaleFromWidth.toFixed(2)),
          tag: typeof data.tag === "string" && data.tag ? data.tag : undefined,
          label: typeof data.label === "string" && data.label && data.label !== node.id ? data.label : undefined,
          color: typeof data.color === "string" ? data.color : undefined,
          fields: { legacySymbolType: symbolType }
        });
      }
    }
  }

  // Offset everything so the content starts inside the frame, then snap symbols.
  const draft = createEmptyDocument();
  const preliminary: Item[] = [...equipment, ...symbols, ...labels, ...notes];
  const contentBounds = rectUnion(preliminary.map((item) => itemBounds(item, registry)));
  const sheetId = pickSheet(contentBounds);
  draft.sheet = makeSheet(sheetId);
  const frame = frameRect(draft.sheet);
  const offset = contentBounds
    ? { x: snapValue(frame.x + 15 - contentBounds.x, grid), y: snapValue(frame.y + 15 - contentBounds.y, grid) }
    : { x: 0, y: 0 };
  const shift = (point: Point): Point => ({ x: point.x + offset.x, y: point.y + offset.y });

  const items: Item[] = [];
  for (const item of equipment) items.push({ ...item, position: shift(item.position) });
  const symbolById = new Map<string, SymbolItem>();
  for (const item of symbols) {
    const placed = { ...item, position: snapPoint(shift(item.position), grid) };
    symbolById.set(item.id, placed);
    items.push(placed);
  }
  for (const item of labels) items.push({ ...item, position: shift(item.position) });
  for (const item of notes) items.push({ ...item, position: shift(item.position) });
  for (const [id, centre] of junctionCentres) junctionCentres.set(id, snapPoint(shift(centre), grid));

  // Edges → lines.
  const endpoint = (nodeId: string, handle: string | null | undefined, toward: Point | null): { point: Point; side: Side | null } | null => {
    const junction = junctionCentres.get(nodeId);
    if (junction) return { point: junction, side: null };
    const symbol = symbolById.get(nodeId);
    if (!symbol) return null;
    const ports = registry.portsOf(symbol);
    if (!ports.length) return { point: symbol.position, side: null };
    let port = ports.find((entry) => entry.id === handle);
    if (!port && toward) {
      port = [...ports].sort((a, b) => Math.hypot(a.position.x - toward.x, a.position.y - toward.y) - Math.hypot(b.position.x - toward.x, b.position.y - toward.y))[0];
    }
    port = port ?? ports[0];
    return { point: port.position, side: port.side };
  };

  for (const edge of edges) {
    const targetHint = symbolById.get(edge.target)?.position ?? junctionCentres.get(edge.target) ?? null;
    const sourceHint = symbolById.get(edge.source)?.position ?? junctionCentres.get(edge.source) ?? null;
    const start = endpoint(edge.source, edge.sourceHandle, targetHint);
    const end = endpoint(edge.target, edge.targetHandle, sourceHint);
    if (!start || !end) continue;
    const waypoints = Array.isArray(edge.data?.waypoints)
      ? (edge.data.waypoints as Point[]).map((point) => snapPoint(shift({ x: point.x * PX_TO_MM, y: point.y * PX_TO_MM }), grid))
      : null;
    const points = waypoints && waypoints.length
      ? simplifyPolyline(orthogonalize([start.point, ...waypoints, end.point]))
      : routeBetween(start.point, start.side, end.point, end.side, { grid });
    const data = (edge.data ?? {}) as Record<string, unknown>;
    const line: LineItem = {
      id: edge.id,
      kind: "line",
      layer: lineTypeFor(edge) === "process" ? "process" : "signal",
      points,
      lineType: lineTypeFor(edge),
      service: typeof data.fluid === "string" && data.fluid ? data.fluid : undefined,
      lineNumber: typeof edge.label === "string" && edge.label ? edge.label : undefined,
      color: typeof data.color === "string" ? data.color : undefined,
      showArrow: data.showArrow !== false,
      fields: {
        pressure_bar: typeof data.pressure_bar === "number" ? data.pressure_bar : null,
        temperature_c: typeof data.temperature_c === "number" ? data.temperature_c : null,
        diameter_mm: typeof data.diameter_mm === "number" ? data.diameter_mm : null,
        material: typeof data.material === "string" ? data.material : null
      }
    };
    items.push(line);
  }

  draft.items = items;
  draft.meta = { grid, convertedFrom: "reactflow", title: options.title };
  return draft;
}
