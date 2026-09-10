/**
 * Sheet index: one normalized row per symbol, equipment boundary, and line.
 *
 * Built from the document plus connectivity at save time and sent with the
 * document so the server can serve engineering lists, roll the BoM up, and
 * answer where-used queries without the engine. The same rows drive the
 * lists drawer in the editor, so what is listed is what will be exported.
 */
import { computeConnectivity, type Connectivity, type LineEnd } from "./connectivity";
import { polylineLength } from "./geometry";
import type { SymbolRegistry } from "./library";
import { pointAlong } from "./lines";
import { zoneAt } from "./sheet";
import type { EquipmentItem, FieldValue, LineItem, SchematicDocument, SymbolItem } from "./types";

export type SheetIndexItem = {
  item_id: string;
  kind: "symbol" | "equipment";
  category: string | null;
  symbol_key: string | null;
  symbol_name: string | null;
  tag: string | null;
  label: string | null;
  zone: string | null;
  x: number;
  y: number;
  part_id: string | null;
  dnp: boolean;
  spare: number;
  fields: Record<string, FieldValue>;
};

export type SheetIndexLine = {
  line_id: string;
  line_number: string | null;
  line_type: string;
  service: string | null;
  size: string | null;
  spec: string | null;
  line_class: string | null;
  from_item: string | null;
  from_tag: string | null;
  to_item: string | null;
  to_tag: string | null;
  zone: string | null;
  length_mm: number;
  length_m: number | null;
  connection_count: number;
  tee_count: number;
  design_pressure: string | null;
  design_temperature: string | null;
  operating_pressure: string | null;
  operating_temperature: string | null;
  insulation: string | null;
  tracing: string | null;
  fields: Record<string, FieldValue>;
};

export type SheetIndex = { items: SheetIndexItem[]; lines: SheetIndexLine[] };

export type IndexOptions = {
  connectivity?: Connectivity;
  /** Resolved "SHT n / zone" per connector item id. */
  connectorTargets?: Record<string, string>;
};

/** Default metres per drawn millimetre when a line has no physical length. */
export const DEFAULT_LENGTH_FACTOR = 0.001;

function blank(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function itemCaption(item: SymbolItem | EquipmentItem): string {
  if (item.kind === "symbol") return item.tag ?? item.label ?? "";
  return item.tag ?? item.name;
}

/** Estimated physical length in metres. */
export function lineLengthM(line: LineItem, drawnMm = polylineLength(line.points)): number {
  if (typeof line.physicalLength === "number" && Number.isFinite(line.physicalLength)) return round3(line.physicalLength);
  return round3(drawnMm * (line.lengthFactor ?? DEFAULT_LENGTH_FACTOR));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

type EndDescription = { itemId: string | null; caption: string | null };

function describeEnd(doc: SchematicDocument, byId: Map<string, SymbolItem | EquipmentItem | LineItem>, end: LineEnd | undefined): EndDescription {
  if (!end) return { itemId: null, caption: null };
  for (const attachment of end.attachments) {
    if (attachment.kind === "port") {
      const item = byId.get(attachment.itemId);
      if (item && item.kind !== "line") {
        const caption = itemCaption(item);
        const suffix = attachment.portId !== "in" && attachment.portId !== "out" ? ` (${attachment.portId})` : "";
        return { itemId: item.id, caption: caption ? `${caption}${suffix}` : null };
      }
    }
  }
  for (const attachment of end.attachments) {
    if (attachment.kind === "line" || attachment.kind === "line-end") {
      const other = byId.get(attachment.lineId);
      if (other && other.kind === "line") return { itemId: other.id, caption: other.lineNumber ? `line ${other.lineNumber}` : "tee" };
    }
  }
  void doc;
  return { itemId: null, caption: null };
}

/** Build the index rows for a document. */
export function buildSheetIndex(doc: SchematicDocument, registry: SymbolRegistry, options: IndexOptions = {}): SheetIndex {
  const connectivity = options.connectivity ?? computeConnectivity(doc, registry);
  const byId = new Map<string, SymbolItem | EquipmentItem | LineItem>();
  for (const item of doc.items) if (item.kind === "symbol" || item.kind === "equipment" || item.kind === "line") byId.set(item.id, item);

  // Lines touching each item's ports, for the size/service/line columns of item rows.
  const linesByItem = new Map<string, LineItem[]>();
  for (const end of connectivity.lineEnds) {
    const line = byId.get(end.lineId);
    if (!line || line.kind !== "line") continue;
    for (const attachment of end.attachments) {
      if (attachment.kind !== "port") continue;
      const list = linesByItem.get(attachment.itemId) ?? [];
      if (!list.includes(line)) list.push(line);
      linesByItem.set(attachment.itemId, list);
    }
  }
  const pick = (itemId: string, key: "size" | "service" | "lineNumber"): string | null => {
    for (const line of linesByItem.get(itemId) ?? []) {
      const value = blank(line[key]);
      if (value) return value;
    }
    return null;
  };

  const items: SheetIndexItem[] = [];
  for (const item of doc.items) {
    if (item.kind === "symbol") {
      const definition = registry.has(item.symbol) ? registry.resolve(item.symbol) : null;
      const actuator = registry.actuatorOf(item);
      const portSize = definition?.ports.find((port) => port.size)?.size ?? null;
      items.push({
        item_id: item.id,
        kind: "symbol",
        category: definition?.category ?? null,
        symbol_key: item.symbol.key,
        symbol_name: definition?.name ?? item.symbol.key,
        tag: blank(item.tag),
        label: blank(item.label),
        zone: zoneAt(doc.sheet, item.position),
        x: item.position.x,
        y: item.position.y,
        part_id: item.partId ?? null,
        dnp: Boolean(item.dnp),
        spare: Math.max(0, Math.floor(item.spare ?? 0)),
        fields: {
          ...item.fields,
          size: pick(item.id, "size") ?? portSize,
          service: pick(item.id, "service"),
          line_number: pick(item.id, "lineNumber"),
          actuator: actuator?.name ?? null,
          mounting: blank(item.fields.mounting),
          ref: blank(item.fields.ref),
          target: options.connectorTargets?.[item.id] ?? null,
          notes: blank(item.fields.notes)
        }
      });
    } else if (item.kind === "equipment") {
      const centre = { x: item.position.x + item.size.width / 2, y: item.position.y + item.size.height / 2 };
      items.push({
        item_id: item.id,
        kind: "equipment",
        category: "equipment",
        symbol_key: null,
        symbol_name: "Equipment boundary",
        tag: blank(item.tag),
        label: blank(item.name),
        zone: zoneAt(doc.sheet, centre),
        x: centre.x,
        y: centre.y,
        part_id: item.partId ?? null,
        dnp: Boolean(item.dnp),
        spare: Math.max(0, Math.floor(item.spare ?? 0)),
        fields: {
          ...item.fields,
          nozzle_count: item.nozzles?.length ?? 0,
          service: pick(item.id, "service"),
          size: pick(item.id, "size"),
          line_number: pick(item.id, "lineNumber"),
          notes: blank(item.fields.notes)
        }
      });
    }
  }

  const lines: SheetIndexLine[] = [];
  for (const item of doc.items) {
    if (item.kind !== "line") continue;
    const ends = connectivity.lineEnds.filter((end) => end.lineId === item.id);
    const from = describeEnd(doc, byId, ends.find((end) => end.end === 0));
    const to = describeEnd(doc, byId, ends.find((end) => end.end === 1));
    const connectionCount = ends.filter((end) => end.attachments.some((attachment) => attachment.kind === "port")).length;
    const teeCount = ends.filter((end) => !end.attachments.some((attachment) => attachment.kind === "port") && end.attachments.some((attachment) => attachment.kind === "line")).length;
    const drawn = polylineLength(item.points);
    const middle = pointAlong(item.points, 0.5)?.point ?? item.points[0];
    lines.push({
      line_id: item.id,
      line_number: blank(item.lineNumber),
      line_type: item.lineType,
      service: blank(item.service),
      size: blank(item.size),
      spec: blank(item.spec),
      line_class: blank(item.lineClass),
      from_item: from.itemId,
      from_tag: from.caption,
      to_item: to.itemId,
      to_tag: to.caption,
      zone: zoneAt(doc.sheet, middle),
      length_mm: Math.round(drawn * 100) / 100,
      length_m: lineLengthM(item, drawn),
      connection_count: connectionCount,
      tee_count: teeCount,
      design_pressure: blank(item.designPressure),
      design_temperature: blank(item.designTemperature),
      operating_pressure: blank(item.operatingPressure),
      operating_temperature: blank(item.operatingTemperature),
      insulation: blank(item.insulation),
      tracing: blank(item.tracing),
      fields: { ...item.fields }
    });
  }
  return { items, lines };
}
