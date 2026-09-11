/**
 * The one renderer. Produces SVG markup strings for items, junctions, the
 * sheet frame, and whole documents. The React canvas embeds the item markup
 * per item; the export path concatenates the same markup into a complete SVG
 * at paper size, so screen and print never drift.
 */
import { computeConnectivity, type Connectivity } from "./connectivity";
import { proprietaryText, resolveTemplate, titleBlockRect, wrapText, type DrawingContext } from "./frames";
import { SYMBOL_STROKE_MM, type SymbolRegistry } from "./library";
import { SHEET_SIZES, frameRect, sheetSize, zoneLabels } from "./sheet";
import { equipmentPorts } from "./connectivity";
import { pointAlong } from "./lines";
import { NOTE_SIZE_MM } from "./spatial";
import type {
  EquipmentItem,
  Item,
  LabelItem,
  LineItem,
  LineType,
  NoteItem,
  Point,
  Rect,
  SchematicDocument,
  SymbolDef,
  SymbolItem
} from "./types";

export const FONT_FAMILY = "'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif";
/** ISO 3098 standard lettering height for P&ID text. */
export const TEXT_MM = 2.5;
export const DEFAULT_INK = "#1f2937";
export const JUNCTION_RADIUS_MM = 0.8;

export type LineStyle = { width: number; dash?: string };

export const LINE_STYLES: Record<LineType, LineStyle> = {
  process: { width: 0.5 },
  signal_electric: { width: 0.25, dash: "2 1" },
  signal_pneumatic: { width: 0.25, dash: "3 0.8 0.6 0.8" },
  signal_software: { width: 0.25, dash: "0.6 0.8" },
  capillary: { width: 0.25, dash: "1.5 0.6" },
  vacuum: { width: 0.35, dash: "4 1" },
  future: { width: 0.35, dash: "2 2" }
};

export const LINE_TYPE_LABELS: Record<LineType, string> = {
  process: "Process",
  signal_electric: "Electrical signal",
  signal_pneumatic: "Pneumatic signal",
  signal_software: "Software / data link",
  capillary: "Capillary",
  vacuum: "Vacuum",
  future: "Future / existing"
};

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function n(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

export function pathFromPoints(points: Point[]): string {
  if (!points.length) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${n(point.x)},${n(point.y)}`).join(" ");
}

/** Split a tag like "PT-3222" or "PT 3222" into ISA bubble rows. */
export function splitTag(tag: string): { letters: string; number: string } {
  const match = /^([A-Za-z]+)[\s-]*([A-Za-z0-9-]*)$/.exec(tag.trim());
  if (!match) return { letters: tag, number: "" };
  return { letters: match[1], number: match[2] };
}

export type RenderContext = {
  registry: SymbolRegistry;
  /** Include review notes (never in exports). */
  notes?: boolean;
  /** Ids to draw highlighted. */
  selection?: Set<string>;
  /** Hop points per line id (from connectivity crossings). */
  crossings?: Map<string, Point[]>;
  /** Resolved off-page references per connector item id, e.g. "SHT 2 / D-4". */
  connectorTargets?: Record<string, string>;
  /** Canvas-only part badges per item id (part number + qualification tone); never exported. */
  partBadges?: Record<string, PartBadge>;
};

export type PartBadgeTone = "good" | "warn" | "bad" | "none";
export type PartBadge = { text: string; tone: PartBadgeTone };

const BADGE_COLORS: Record<PartBadgeTone, string> = {
  good: "#15803d",
  warn: "#b45309",
  bad: "#b91c1c",
  none: "#64748b"
};

/** Small rounded label under an item: part number tinted by qualification. */
function renderPartBadge(badge: PartBadge, centreX: number, top: number): string {
  const size = 1.8;
  const width = Math.max(6, badge.text.length * size * 0.62 + 2);
  const color = BADGE_COLORS[badge.tone];
  return `<g class="part-badge"><rect x="${n(centreX - width / 2)}" y="${n(top)}" width="${n(width)}" height="${n(size + 1.2)}" rx="0.6" fill="#fff" stroke="${color}" stroke-width="0.25"/>${text(badge.text, centreX, top + size + 0.15, { size, color })}</g>`;
}

const HOP_RADIUS = 1.2;

/** Path for an orthogonal polyline with hops (semicircles) at the given crossing points. */
export function pathWithHops(points: Point[], hops: Point[]): string {
  if (!hops.length) return pathFromPoints(points);
  const parts: string[] = [`M${n(points[0].x)},${n(points[0].y)}`];
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const onSegment = hops
      .filter((hop) => hop.y === a.y && a.y === b.y && hop.x > Math.min(a.x, b.x) && hop.x < Math.max(a.x, b.x))
      .sort((p, q) => (b.x > a.x ? p.x - q.x : q.x - p.x));
    const direction = b.x >= a.x ? 1 : -1;
    for (const hop of onSegment) {
      parts.push(`L${n(hop.x - direction * HOP_RADIUS)},${n(a.y)}`);
      parts.push(`A${HOP_RADIUS},${HOP_RADIUS} 0 0 ${direction > 0 ? 1 : 0} ${n(hop.x + direction * HOP_RADIUS)},${n(a.y)}`);
    }
    parts.push(`L${n(b.x)},${n(b.y)}`);
  }
  return parts.join(" ");
}

function text(value: string, x: number, y: number, options: { size?: number; anchor?: string; rotation?: number; color?: string; weight?: string } = {}): string {
  const size = options.size ?? TEXT_MM;
  const transform = options.rotation ? ` transform="rotate(${options.rotation} ${n(x)} ${n(y)})"` : "";
  return `<text x="${n(x)}" y="${n(y)}" font-family="${FONT_FAMILY}" font-size="${n(size)}" text-anchor="${options.anchor ?? "middle"}" fill="${options.color ?? "currentColor"}" stroke="none"${options.weight ? ` font-weight="${options.weight}"` : ""}${transform}>${escapeXml(value)}</text>`;
}

export function renderSymbol(item: SymbolItem, ctx: RenderContext): string {
  const definition = ctx.registry.resolve(item.symbol);
  const scale = item.scale ?? 1;
  const color = item.color ?? DEFAULT_INK;
  const transform = `translate(${n(item.position.x)} ${n(item.position.y)}) rotate(${item.rotation}) scale(${n(item.mirror ? -scale : scale)} ${n(scale)})`;
  const actuator = ctx.registry.actuatorOf(item);
  const actuatorMarkup =
    actuator && definition.actuatorMount
      ? `<g transform="translate(${n(definition.actuatorMount.x)} ${n(definition.actuatorMount.y)})">${actuator.svg}</g>`
      : "";
  const parts = [
    `<g transform="${transform}" fill="none" stroke="currentColor" stroke-width="${n(SYMBOL_STROKE_MM / scale)}" stroke-linecap="round" stroke-linejoin="round">${definition.svg}${actuatorMarkup}</g>`
  ];
  const caption = item.tag ?? item.label ?? "";
  if (definition.category === "instrument" && definition.height <= 6) {
    // Boxed primary element: letters inside, number below the box.
    const { letters, number } = splitTag(caption);
    if (letters) parts.push(text(letters, item.position.x, item.position.y + 0.9, { size: 2.4 }));
    if (number) parts.push(text(number, item.position.x, item.position.y + (definition.height * scale) / 2 + 2.8, { size: 2.2 }));
  } else if (definition.category === "instrument") {
    const { letters, number } = splitTag(caption);
    if (letters) parts.push(text(letters, item.position.x, item.position.y - 0.5, { size: 2.2 }));
    if (number) parts.push(text(number, item.position.x, item.position.y + 2.4, { size: 2.2 }));
  } else if (definition.category === "connector") {
    const target = ctx.connectorTargets?.[item.id];
    if (target) {
      parts.push(text(target, item.position.x - 2, item.position.y + 0.9, { size: 2 }));
      if (caption) parts.push(text(caption, item.position.x, item.position.y - 5.2, { size: 2.2 }));
    } else {
      parts.push(text(caption, item.position.x - 2, item.position.y + 0.9, { size: 2.2 }));
    }
  } else if (caption) {
    const bounds = ctx.registry.boundsOf(item);
    parts.push(text(caption, item.position.x, bounds.y + bounds.height + 3.2, { size: TEXT_MM }));
  }
  const badge = ctx.partBadges?.[item.id];
  if (item.dnp || badge) {
    const bounds = ctx.registry.boundsOf(item);
    const captionBelow = caption && definition.category !== "instrument" && definition.category !== "connector";
    if (item.dnp) parts.push(text("DNP", item.position.x, bounds.y - 1, { size: 1.8, weight: "600" }));
    if (badge) parts.push(renderPartBadge(badge, item.position.x, bounds.y + bounds.height + (captionBelow ? 4.2 : 1.2)));
  }
  return `<g class="item item-symbol" data-id="${escapeXml(item.id)}" color="${escapeXml(color)}">${parts.join("")}</g>`;
}

function arrowHead(points: Point[], size: number): string {
  if (points.length < 2) return "";
  const tip = points[points.length - 1];
  const previous = points[points.length - 2];
  const dx = tip.x - previous.x;
  const dy = tip.y - previous.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const base = { x: tip.x - ux * size, y: tip.y - uy * size };
  const left = { x: base.x - uy * (size / 2), y: base.y + ux * (size / 2) };
  const right = { x: base.x + uy * (size / 2), y: base.y - ux * (size / 2) };
  return `<path d="M${n(tip.x)},${n(tip.y)} L${n(left.x)},${n(left.y)} L${n(right.x)},${n(right.y)} Z" fill="currentColor" stroke="none"/>`;
}

function longestSegment(points: Point[]): { a: Point; b: Point } {
  let best = 0;
  let bestLength = -1;
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (length > bestLength) {
      bestLength = length;
      best = index;
    }
  }
  return { a: points[best], b: points[best + 1] };
}

function renderAnnotations(item: LineItem): string {
  const parts: string[] = [];
  for (const annotation of item.annotations ?? []) {
    const at = pointAlong(item.points, annotation.at);
    if (!at) continue;
    const { point, direction } = at;
    const vertical = Math.abs(direction.y) > Math.abs(direction.x);
    const side = annotation.side ?? -1;
    // Perpendicular (right-hand of travel = +90° in screen space).
    const normal = { x: -direction.y * side, y: direction.x * side };
    const angle = vertical ? -90 : 0;
    const labelAt = { x: point.x + normal.x * 2.4, y: point.y + normal.y * 2.4 + (vertical ? 0 : side < 0 ? 0 : 1.8) };
    const rotate = (svg: string) => `<g transform="translate(${n(point.x)} ${n(point.y)}) rotate(${n((Math.atan2(direction.y, direction.x) * 180) / Math.PI)})">${svg}</g>`;
    switch (annotation.kind) {
      case "flow_arrow":
        parts.push(rotate('<path d="M-2,-2 L2,0 L-2,2 Z" fill="currentColor" stroke="none"/>'));
        break;
      case "size_change":
        parts.push(rotate('<path d="M-3,-2.5 L3,-1.2 V1.2 L-3,2.5 Z" fill="#fff" stroke="currentColor" stroke-width="0.35"/>'));
        if (annotation.text) parts.push(text(annotation.text, labelAt.x, labelAt.y, { size: 2, rotation: angle }));
        break;
      case "spec_break":
        parts.push(rotate('<path d="M0,-4 V4 M-1.2,-4 H1.2 M-1.2,4 H1.2" stroke="currentColor" stroke-width="0.5"/>'));
        parts.push(text(annotation.text || "SPEC BREAK", labelAt.x, labelAt.y, { size: 2, rotation: angle }));
        break;
      default:
        if (annotation.text) parts.push(text(annotation.text, labelAt.x, labelAt.y, { size: 2.2, rotation: angle }));
    }
  }
  return parts.join("");
}

export function renderLine(item: LineItem, ctx?: RenderContext): string {
  const style = LINE_STYLES[item.lineType] ?? LINE_STYLES.process;
  const width = item.strokeWidth ?? style.width;
  const color = item.color ?? DEFAULT_INK;
  const dash = style.dash ? ` stroke-dasharray="${style.dash}"` : "";
  const hops = ctx?.crossings?.get(item.id) ?? [];
  const parts = [
    `<path d="${pathWithHops(item.points, hops)}" fill="none" stroke="currentColor" stroke-width="${n(width)}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`
  ];
  if (item.showArrow) parts.push(arrowHead(item.points, Math.max(2, width * 4)));
  const specText = [item.size, item.spec].filter((part) => part && part.trim()).join(" ");
  if (specText && item.showSpecLabel !== false && item.points.length >= 2) {
    const { a, b } = longestSegment(item.points);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    parts.push(
      a.x === b.x
        ? text(specText, mid.x + 2.6, mid.y, { size: 2, rotation: -90 })
        : text(specText, mid.x, mid.y + 2.8, { size: 2 })
    );
  }
  parts.push(renderAnnotations(item));
  if (item.lineNumber && item.points.length >= 2) {
    // Label the longest segment, offset to its left-hand side.
    const { a, b } = longestSegment(item.points);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const vertical = a.x === b.x;
    parts.push(
      vertical
        ? text(item.lineNumber, mid.x - 1.2, mid.y, { size: 2.2, rotation: -90 })
        : text(item.lineNumber, mid.x, mid.y - 1.2, { size: 2.2 })
    );
  }
  return `<g class="item item-line" data-id="${escapeXml(item.id)}" color="${escapeXml(color)}">${parts.join("")}</g>`;
}

export function renderEquipment(item: EquipmentItem, ctx?: RenderContext): string {
  const color = item.color ?? DEFAULT_INK;
  const dash = item.boundary === "dashed" ? ' stroke-dasharray="3 1.5"' : "";
  const caption = [item.tag, item.name].filter(Boolean).join("  ");
  const nozzles = equipmentPorts(item)
    .map((port) => {
      const inward = { left: { x: 3, y: 0 }, right: { x: -3, y: 0 }, top: { x: 0, y: 3 }, bottom: { x: 0, y: -3 } }[port.side];
      const stub = `<path d="M${n(port.position.x)},${n(port.position.y)} L${n(port.position.x + inward.x)},${n(port.position.y + inward.y)}" stroke="currentColor" stroke-width="0.5"/>`;
      const label = port.size ? text(port.size, port.position.x + inward.x * 2.2, port.position.y + inward.y * 2.2 + 0.7, { size: 1.8 }) : "";
      return stub + label;
    })
    .join("");
  const badge = ctx?.partBadges?.[item.id];
  const extras =
    (item.dnp ? text("DNP", item.position.x + item.size.width - 1, item.position.y - 1.2, { anchor: "end", size: 1.8, weight: "600" }) : "") +
    (badge ? renderPartBadge(badge, item.position.x + item.size.width / 2, item.position.y + item.size.height + 1.2) : "");
  return `<g class="item item-equipment" data-id="${escapeXml(item.id)}" color="${escapeXml(color)}"><rect x="${n(item.position.x)}" y="${n(item.position.y)}" width="${n(item.size.width)}" height="${n(item.size.height)}" fill="none" stroke="currentColor" stroke-width="0.35"${dash}/>${nozzles}${caption ? text(caption, item.position.x + 1, item.position.y - 1.2, { anchor: "start", size: TEXT_MM, weight: "600" }) : ""}${extras}</g>`;
}

export function renderLabel(item: LabelItem): string {
  const color = item.color ?? DEFAULT_INK;
  const lines = item.text.split(/\r?\n/);
  const lineHeight = item.fontSize * 1.25;
  const body = lines
    .map(
      (line, index) =>
        `<tspan x="${n(item.position.x)}" dy="${index === 0 ? 0 : n(lineHeight)}">${escapeXml(line) || " "}</tspan>`
    )
    .join("");
  const transform = item.rotation ? ` transform="rotate(${item.rotation} ${n(item.position.x)} ${n(item.position.y)})"` : "";
  return `<g class="item item-label" data-id="${escapeXml(item.id)}" color="${escapeXml(color)}"><text x="${n(item.position.x)}" y="${n(item.position.y)}" font-family="${FONT_FAMILY}" font-size="${n(item.fontSize)}" text-anchor="${item.anchor}" fill="currentColor" stroke="none"${transform}>${body}</text></g>`;
}

export function renderNote(item: NoteItem): string {
  const size = NOTE_SIZE_MM;
  return `<g class="item item-note" data-id="${escapeXml(item.id)}" color="#b45309"><path d="M${n(item.position.x)},${n(item.position.y)} v${n(-size)} h${n(size)} v${n(size * 0.7)} h${n(-size * 0.55)} Z" fill="#fde68a" stroke="currentColor" stroke-width="0.3"/>${text("!", item.position.x + size / 2, item.position.y - size * 0.3, { size: 3, weight: "700" })}</g>`;
}

export function renderItem(item: Item, ctx: RenderContext): string {
  switch (item.kind) {
    case "symbol":
      return renderSymbol(item, ctx);
    case "line":
      return renderLine(item, ctx);
    case "equipment":
      return renderEquipment(item, ctx);
    case "label":
      return renderLabel(item);
    case "note":
      return ctx.notes ? renderNote(item) : "";
  }
}

export function renderJunctions(connectivity: Connectivity, color = DEFAULT_INK): string {
  if (!connectivity.junctions.length) return "";
  const dots = connectivity.junctions
    .map((point) => `<circle cx="${n(point.x)}" cy="${n(point.y)}" r="${JUNCTION_RADIUS_MM}"/>`)
    .join("");
  return `<g class="junctions" fill="${color}" stroke="none">${dots}</g>`;
}

/** Border, zone strip, and (per template) title block, revision table, notes, proprietary notice. */
export function renderFrame(doc: SchematicDocument, ctx?: DrawingContext, color = DEFAULT_INK): string {
  const sheet = doc.sheet;
  const template = resolveTemplate(sheet);
  if (template.id === "none" || sheet.frame.kind === "none") return "";
  const paper = sheetSize(sheet);
  const border = frameRect(sheet);
  const strip = Math.min(sheet.frame.margin, 6);
  const labels = zoneLabels(sheet);
  const parts: string[] = [];
  parts.push(`<rect x="0" y="0" width="${n(paper.width)}" height="${n(paper.height)}" fill="none" stroke="currentColor" stroke-width="0.25"/>`);
  parts.push(`<rect x="${n(border.x)}" y="${n(border.y)}" width="${n(border.width)}" height="${n(border.height)}" fill="none" stroke="currentColor" stroke-width="0.7"/>`);
  const columnWidth = border.width / sheet.frame.columns;
  labels.columns.forEach((label, index) => {
    const x0 = border.x + index * columnWidth;
    const centre = x0 + columnWidth / 2;
    if (index > 0) {
      parts.push(`<path d="M${n(x0)},${n(border.y - strip)} V${n(border.y)} M${n(x0)},${n(border.y + border.height)} V${n(border.y + border.height + strip)}" stroke="currentColor" stroke-width="0.25"/>`);
    }
    parts.push(text(label, centre, border.y - strip / 2 + 1, { size: 3 }));
    parts.push(text(label, centre, border.y + border.height + strip / 2 + 1, { size: 3 }));
  });
  const rowHeight = border.height / sheet.frame.rows;
  labels.rows.forEach((label, index) => {
    const y0 = border.y + index * rowHeight;
    const centre = y0 + rowHeight / 2;
    if (index > 0) {
      parts.push(`<path d="M${n(border.x - strip)},${n(y0)} H${n(border.x)} M${n(border.x + border.width)},${n(y0)} H${n(border.x + border.width + strip)}" stroke="currentColor" stroke-width="0.25"/>`);
    }
    parts.push(text(label, border.x - strip / 2, centre + 1, { size: 3 }));
    parts.push(text(label, border.x + border.width + strip / 2, centre + 1, { size: 3 }));
  });

  const context: DrawingContext = ctx ?? {
    number: "",
    title: doc.meta.title ?? "",
    sheetNo: 1,
    sheetCount: 1,
    revisions: [],
    notes: [],
    sizeLabel: SHEET_SIZES[sheet.size]?.label.replace("ISO ", "").replace("ANSI ", "")
  };
  if (!context.sizeLabel) context.sizeLabel = SHEET_SIZES[sheet.size]?.label.replace("ISO ", "").replace("ANSI ", "");

  const block = titleBlockRect(sheet);
  if (template.titleBlock && block) {
    parts.push(`<rect x="${n(block.x)}" y="${n(block.y)}" width="${n(block.width)}" height="${n(block.height)}" fill="#fff" stroke="currentColor" stroke-width="0.7"/>`);
    for (const cell of template.titleBlock.cells) {
      const x = block.x + cell.x;
      const y = block.y + cell.y;
      parts.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(cell.w)}" height="${n(cell.h)}" fill="none" stroke="currentColor" stroke-width="0.35"/>`);
      parts.push(text(cell.label, x + 1, y + 2.2, { size: 1.8, anchor: "start" }));
      const value = cell.value(context);
      if (!value) continue;
      const size = cell.size ?? 2.5;
      const weight = cell.bold ? "700" : undefined;
      if (cell.multiline) {
        const lines = value.split(/\r?\n/).filter((line) => line.trim()).slice(0, 3);
        const lineHeight = size * 1.2;
        const startY = y + cell.h / 2 - ((lines.length - 1) * lineHeight) / 2 + size * 0.35 + 0.8;
        lines.forEach((line, index) => parts.push(text(line, x + cell.w / 2, startY + index * lineHeight, { size, weight })));
      } else if (cell.align === "start") {
        parts.push(text(value, x + 1.5, y + cell.h - 1.6, { size, weight, anchor: "start" }));
      } else {
        parts.push(text(value, x + cell.w / 2, y + cell.h / 2 + size * 0.35 + 0.9, { size, weight }));
      }
    }
  }

  if (template.revisionTable && block) {
    const table = template.revisionTable;
    const rows = context.revisions;
    const total = (rows.length + 1) * table.rowHeight;
    const top = block.y - total;
    const left = block.x + block.width - table.width;
    parts.push(`<rect x="${n(left)}" y="${n(top)}" width="${n(table.width)}" height="${n(total)}" fill="#fff" stroke="currentColor" stroke-width="0.7"/>`);
    let cx = left;
    for (const column of table.columns) {
      parts.push(`<rect x="${n(cx)}" y="${n(top)}" width="${n(column.w)}" height="${n(table.rowHeight)}" fill="none" stroke="currentColor" stroke-width="0.35"/>`);
      parts.push(text(column.label, cx + column.w / 2, top + table.rowHeight / 2 + 0.8, { size: 2.2, weight: "700" }));
      cx += column.w;
    }
    parts.push(text("REVISIONS", left + table.width / 2, top - 1.2, { size: 2.2, weight: "700" }));
    [...rows].reverse().forEach((row, index) => {
      const y = top + (index + 1) * table.rowHeight;
      let x = left;
      parts.push(`<path d="M${n(left)},${n(y)} H${n(left + table.width)}" stroke="currentColor" stroke-width="0.25"/>`);
      for (const column of table.columns) {
        if (x > left) parts.push(`<path d="M${n(x)},${n(y)} V${n(y + table.rowHeight)}" stroke="currentColor" stroke-width="0.25"/>`);
        const value = column.value(row);
        if (value) {
          parts.push(
            column.align === "middle"
              ? text(value, x + column.w / 2, y + table.rowHeight / 2 + 0.8, { size: 2.2 })
              : text(value, x + 1.2, y + table.rowHeight / 2 + 0.8, { size: 2.2, anchor: "start" })
          );
        }
        x += column.w;
      }
    });
  }

  if (template.notesBlock && context.notes.length) {
    const notes = template.notesBlock;
    const x = border.x + notes.x;
    let y = border.y + notes.y + 3.5;
    parts.push(text("GENERAL NOTES:", x, y, { size: 3, anchor: "start", weight: "700" }));
    y += notes.lineHeight + 1;
    let printed = 0;
    context.notes.forEach((note, index) => {
      const wrapped = wrapText(note, notes.width - 6, 2.5);
      wrapped.forEach((line, lineIndex) => {
        if (printed >= notes.maxLines) return;
        parts.push(text(lineIndex === 0 ? `${index + 1}.` : "", x, y, { size: 2.5, anchor: "start" }));
        parts.push(text(line, x + 6, y, { size: 2.5, anchor: "start" }));
        y += notes.lineHeight;
        printed += 1;
      });
    });
  }

  if (template.proprietary && ctx) {
    const notice = template.proprietary;
    const lines = wrapText(proprietaryText(context), notice.width, 2);
    let y = border.y + border.height - 2 - (lines.length - 1) * notice.lineHeight;
    for (const line of lines) {
      parts.push(text(line, border.x + 3, y, { size: 2, anchor: "start" }));
      y += notice.lineHeight;
    }
  }

  if (ctx?.legends?.symbols?.length && block) {
    parts.push(renderSymbolLegend(ctx.legends.symbols, border, block));
  }
  let rightCursor = border.y + 4;
  if (ctx?.legends?.letters) {
    const table = renderLetterTable(ctx.legends.letters, border, rightCursor);
    parts.push(table.svg);
    rightCursor += table.height + 4;
  }
  if (ctx?.legends?.lines?.length) {
    parts.push(renderLineLegend(ctx.legends.lines, border, rightCursor));
  }

  if (!ctx && doc.meta.title && !template.titleBlock) {
    parts.push(text(doc.meta.title, border.x + border.width - 2, border.y + border.height - 2, { anchor: "end", size: 3.5, weight: "600" }));
  }
  return `<g class="frame" color="${color}" fill="none">${parts.join("")}</g>`;
}

const LEGEND_ENTRY_W = 46;
const LEGEND_ENTRY_H = 8;

/** Symbol legend: entries for every symbol family used on the sheet, bottom-left of the frame. */
function renderSymbolLegend(entries: Array<{ definition: SymbolDef; count: number }>, border: Rect, titleBlock: Rect): string {
  const left = border.x + 4;
  const right = titleBlock.x - 6;
  const columns = Math.max(1, Math.floor((right - left) / LEGEND_ENTRY_W));
  const rows = Math.ceil(entries.length / columns);
  const height = rows * LEGEND_ENTRY_H + 5;
  const top = border.y + border.height - 12 - height;
  const width = Math.min(right - left, columns * LEGEND_ENTRY_W);
  const parts = [
    `<rect x="${n(left)}" y="${n(top)}" width="${n(width)}" height="${n(height)}" fill="#fff" stroke="currentColor" stroke-width="0.35"/>`,
    `<path d="M${n(left)},${n(top + 5)} H${n(left + width)}" stroke="currentColor" stroke-width="0.25"/>`,
    text("SYMBOL LEGEND", left + width / 2, top + 3.6, { size: 2.4, weight: "700" })
  ];
  entries.forEach((entry, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = left + column * LEGEND_ENTRY_W;
    const y = top + 5 + row * LEGEND_ENTRY_H;
    const scale = Math.min(0.5, 6 / Math.max(entry.definition.height, 1), 14 / Math.max(entry.definition.width, 1));
    parts.push(
      `<g transform="translate(${n(x + 9)} ${n(y + LEGEND_ENTRY_H / 2)}) scale(${n(scale)})" fill="none" stroke="currentColor" stroke-width="${n(SYMBOL_STROKE_MM / scale)}" stroke-linecap="round" stroke-linejoin="round">${entry.definition.svg}</g>`
    );
    parts.push(text(entry.definition.legend ?? entry.definition.name.toUpperCase(), x + 18, y + LEGEND_ENTRY_H / 2 + 0.8, { size: 2, anchor: "start" }));
  });
  return `<g class="legend-symbols">${parts.join("")}</g>`;
}

/** Line legend: one sample stroke per (line type, service) used on the sheet. */
function renderLineLegend(entries: Array<{ lineType: string; service?: string; count: number }>, border: Rect, top: number): string {
  const rowHeight = 5;
  const width = 104;
  const left = border.x + border.width - 4 - width;
  const height = 5 + entries.length * rowHeight + 1;
  const parts = [
    `<rect x="${n(left)}" y="${n(top)}" width="${n(width)}" height="${n(height)}" fill="#fff" stroke="currentColor" stroke-width="0.35"/>`,
    text("LINE LEGEND", left + width / 2, top + 3.6, { size: 2.4, weight: "700" }),
    `<path d="M${n(left)},${n(top + 5)} H${n(left + width)}" stroke="currentColor" stroke-width="0.25"/>`
  ];
  entries.forEach((entry, index) => {
    const y = top + 5 + index * rowHeight + rowHeight / 2;
    const style = LINE_STYLES[entry.lineType as LineType] ?? LINE_STYLES.process;
    const dash = style.dash ? ` stroke-dasharray="${style.dash}"` : "";
    parts.push(`<path d="M${n(left + 3)},${n(y)} H${n(left + 23)}" stroke="currentColor" stroke-width="${n(style.width)}"${dash}/>`);
    const label = [entry.service, LINE_TYPE_LABELS[entry.lineType as LineType] ?? entry.lineType].filter(Boolean).join(" — ").toUpperCase();
    parts.push(text(label, left + 27, y + 0.8, { size: 2, anchor: "start" }));
  });
  return `<g class="legend-lines">${parts.join("")}</g>`;
}

/** ISA instrument letter table, top-right inside the border. */
function renderLetterTable(
  letters: { first: Array<{ letter: string; meaning: string }>; succeeding: Array<{ letter: string; meaning: string }> },
  border: Rect,
  top: number
): { svg: string; height: number } {
  const rowHeight = 3.2;
  const columnWidth = 52;
  const rows = Math.max(letters.first.length, letters.succeeding.length);
  const width = columnWidth * 2;
  const height = 8 + rows * rowHeight + 1;
  const left = border.x + border.width - 4 - width;
  const parts = [
    `<rect x="${n(left)}" y="${n(top)}" width="${n(width)}" height="${n(height)}" fill="#fff" stroke="currentColor" stroke-width="0.35"/>`,
    text("INSTRUMENT LETTER DESIGNATIONS", left + width / 2, top + 3.4, { size: 2.4, weight: "700" }),
    `<path d="M${n(left)},${n(top + 4.5)} H${n(left + width)} M${n(left)},${n(top + 8)} H${n(left + width)} M${n(left + columnWidth)},${n(top + 4.5)} V${n(top + height)}" stroke="currentColor" stroke-width="0.25"/>`,
    text("FIRST LETTER", left + columnWidth / 2, top + 7.2, { size: 2, weight: "700" }),
    text("SUCCEEDING LETTERS", left + columnWidth * 1.5, top + 7.2, { size: 2, weight: "700" })
  ];
  const column = (entries: Array<{ letter: string; meaning: string }>, x: number) => {
    entries.forEach((entry, index) => {
      const y = top + 8 + (index + 1) * rowHeight - 0.8;
      parts.push(text(entry.letter, x + 4, y, { size: 2, weight: "700" }));
      parts.push(text(entry.meaning, x + 8, y, { size: 2, anchor: "start" }));
    });
  };
  column(letters.first, left);
  column(letters.succeeding, left + columnWidth);
  return { svg: `<g class="legend-letters">${parts.join("")}</g>`, height };
}

export type DocumentRenderOptions = {
  frame?: boolean;
  /** Drawing/revision data bound into the title block and revision table. */
  context?: DrawingContext;
  notes?: boolean;
  background?: string;
  /** Add the XML declaration for a standalone file. */
  standalone?: boolean;
};

/** Complete SVG of the sheet at paper size (1 user unit = 1 mm). */
export function renderDocumentSvg(doc: SchematicDocument, registry: SymbolRegistry, options: DocumentRenderOptions = {}): string {
  const paper = sheetSize(doc.sheet);
  const connectivity = computeConnectivity(doc, registry);
  const ctx: RenderContext = {
    registry,
    notes: options.notes ?? false,
    crossings: connectivity.crossings,
    connectorTargets: options.context?.connectorTargets
  };
  const hidden = new Set(doc.layers.filter((layer) => layer.hidden).map((layer) => layer.id));
  const body = doc.items
    .filter((item) => !hidden.has(item.layer))
    .map((item) => renderItem(item, ctx))
    .join("\n");
  const background = options.background ? `<rect width="100%" height="100%" fill="${escapeXml(options.background)}"/>` : "";
  const frame = options.frame === false ? "" : renderFrame(doc, options.context);
  const header = options.standalone ? '<?xml version="1.0" encoding="UTF-8"?>\n' : "";
  return `${header}<svg xmlns="http://www.w3.org/2000/svg" width="${n(paper.width)}mm" height="${n(paper.height)}mm" viewBox="0 0 ${n(paper.width)} ${n(paper.height)}" font-family="${FONT_FAMILY}">
${background}${frame}
<g class="items">
${body}
${renderJunctions(connectivity)}
</g>
</svg>`;
}
