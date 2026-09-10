/**
 * The one renderer. Produces SVG markup strings for items, junctions, the
 * sheet frame, and whole documents. The React canvas embeds the item markup
 * per item; the export path concatenates the same markup into a complete SVG
 * at paper size, so screen and print never drift.
 */
import { computeConnectivity, type Connectivity } from "./connectivity";
import { SYMBOL_STROKE_MM, type SymbolRegistry } from "./library";
import { frameRect, sheetSize, zoneLabels } from "./sheet";
import { NOTE_SIZE_MM } from "./spatial";
import type {
  EquipmentItem,
  Item,
  LabelItem,
  LineItem,
  LineType,
  NoteItem,
  Point,
  SchematicDocument,
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
};

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
  const parts = [
    `<g transform="${transform}" fill="none" stroke="currentColor" stroke-width="${n(SYMBOL_STROKE_MM / scale)}" stroke-linecap="round" stroke-linejoin="round">${definition.svg}</g>`
  ];
  const caption = item.tag ?? item.label ?? "";
  if (definition.category === "instrument") {
    const { letters, number } = splitTag(caption);
    if (letters) parts.push(text(letters, item.position.x, item.position.y - 0.5, { size: 2.2 }));
    if (number) parts.push(text(number, item.position.x, item.position.y + 2.4, { size: 2.2 }));
  } else if (definition.category === "connector") {
    parts.push(text(caption, item.position.x - 2, item.position.y + 0.9, { size: 2.2 }));
  } else if (caption) {
    const swap = item.rotation === 90 || item.rotation === 270;
    const halfHeight = ((swap ? definition.width : definition.height) * scale) / 2;
    parts.push(text(caption, item.position.x, item.position.y + halfHeight + 3.2, { size: TEXT_MM }));
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

export function renderLine(item: LineItem): string {
  const style = LINE_STYLES[item.lineType] ?? LINE_STYLES.process;
  const width = item.strokeWidth ?? style.width;
  const color = item.color ?? DEFAULT_INK;
  const dash = style.dash ? ` stroke-dasharray="${style.dash}"` : "";
  const parts = [
    `<path d="${pathFromPoints(item.points)}" fill="none" stroke="currentColor" stroke-width="${n(width)}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`
  ];
  if (item.showArrow) parts.push(arrowHead(item.points, Math.max(2, width * 4)));
  if (item.lineNumber && item.points.length >= 2) {
    // Label the longest segment, offset to its left-hand side.
    let best = 0;
    let bestLength = -1;
    for (let index = 0; index < item.points.length - 1; index += 1) {
      const a = item.points[index];
      const b = item.points[index + 1];
      const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (length > bestLength) {
        bestLength = length;
        best = index;
      }
    }
    const a = item.points[best];
    const b = item.points[best + 1];
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

export function renderEquipment(item: EquipmentItem): string {
  const color = item.color ?? DEFAULT_INK;
  const dash = item.boundary === "dashed" ? ' stroke-dasharray="3 1.5"' : "";
  const caption = [item.tag, item.name].filter(Boolean).join("  ");
  return `<g class="item item-equipment" data-id="${escapeXml(item.id)}" color="${escapeXml(color)}"><rect x="${n(item.position.x)}" y="${n(item.position.y)}" width="${n(item.size.width)}" height="${n(item.size.height)}" fill="none" stroke="currentColor" stroke-width="0.35"${dash}/>${caption ? text(caption, item.position.x + 1, item.position.y - 1.2, { anchor: "start", size: TEXT_MM, weight: "600" }) : ""}</g>`;
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
      return renderLine(item);
    case "equipment":
      return renderEquipment(item);
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

/** Border and zone strip. */
export function renderFrame(doc: SchematicDocument, color = DEFAULT_INK): string {
  const sheet = doc.sheet;
  if (sheet.frame.kind === "none") return "";
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
  if (doc.meta.title) {
    parts.push(text(doc.meta.title, border.x + border.width - 2, border.y + border.height - 2, { anchor: "end", size: 3.5, weight: "600" }));
  }
  return `<g class="frame" color="${color}" fill="none">${parts.join("")}</g>`;
}

export type DocumentRenderOptions = {
  frame?: boolean;
  notes?: boolean;
  background?: string;
  /** Add the XML declaration for a standalone file. */
  standalone?: boolean;
};

/** Complete SVG of the sheet at paper size (1 user unit = 1 mm). */
export function renderDocumentSvg(doc: SchematicDocument, registry: SymbolRegistry, options: DocumentRenderOptions = {}): string {
  const paper = sheetSize(doc.sheet);
  const ctx: RenderContext = { registry, notes: options.notes ?? false };
  const connectivity = computeConnectivity(doc, registry);
  const hidden = new Set(doc.layers.filter((layer) => layer.hidden).map((layer) => layer.id));
  const body = doc.items
    .filter((item) => !hidden.has(item.layer))
    .map((item) => renderItem(item, ctx))
    .join("\n");
  const background = options.background ? `<rect width="100%" height="100%" fill="${escapeXml(options.background)}"/>` : "";
  const frame = options.frame === false ? "" : renderFrame(doc);
  const header = options.standalone ? '<?xml version="1.0" encoding="UTF-8"?>\n' : "";
  return `${header}<svg xmlns="http://www.w3.org/2000/svg" width="${n(paper.width)}mm" height="${n(paper.height)}mm" viewBox="0 0 ${n(paper.width)} ${n(paper.height)}" font-family="${FONT_FAMILY}">
${background}${frame}
<g class="items">
${body}
${renderJunctions(connectivity)}
</g>
</svg>`;
}
