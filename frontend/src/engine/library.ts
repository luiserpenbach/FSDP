/**
 * Symbol library: built-in ISA-style symbols authored in mm on the 2.5 mm
 * module, plus adapters for user-defined SVG symbols from the `/symbols` API.
 *
 * Geometry conventions:
 *  - origin at the symbol centre, y down;
 *  - ports on the 2.5 mm grid so a symbol placed on-grid has on-grid ports;
 *  - inline symbols are 20 mm long with ports at x = ±10;
 *  - markup uses `stroke="currentColor"`; the renderer sets the stroke width.
 */
import { mirrorSide, rotateOffset, rotateSide } from "./geometry";
import type { PidSymbolDef } from "../types";
import type { Point, PortDef, Rect, Side, SymbolDef, SymbolItem, SymbolRef } from "./types";

export { BUILTIN_LIBRARY, BUILTIN_SYMBOLS, CATEGORY_LABELS, CATEGORY_ORDER } from "./builtinSymbols";
import { BUILTIN_LIBRARY, BUILTIN_SYMBOLS } from "./builtinSymbols";
export const CUSTOM_LIBRARY = "custom";
/** Line width for symbol geometry (ISO 128 medium line). */
export const SYMBOL_STROKE_MM = 0.35;

const INLINE_PORTS: PortDef[] = [
  { id: "in", x: -10, y: 0, side: "left", kind: "process" },
  { id: "out", x: 10, y: 0, side: "right", kind: "process" }
];

function def(partial: Omit<SymbolDef, "library" | "version">): SymbolDef {
  return { library: BUILTIN_LIBRARY, version: 1, ...partial };
}

/** Placeholder for symbols whose library entry is missing. */
export const MISSING_SYMBOL: SymbolDef = def({
  key: "__missing__",
  name: "Missing symbol",
  category: "inline",
  width: 20,
  height: 10,
  svg: '<path d="M-6,-5 H6 V5 H-6 Z M-10,0 H-6 M6,0 H10" stroke-dasharray="1 1"/><path d="M-3,-2 L3,2 M-3,2 L3,-2"/>',
  ports: INLINE_PORTS
});

export function symbolKey(ref: SymbolRef): string {
  return `${ref.library}/${ref.key}@${ref.version}`;
}

export function refFor(defn: SymbolDef): SymbolRef {
  return { library: defn.library, key: defn.key, version: defn.version };
}

/** Width in mm that imported custom symbols are normalised to. */
const CUSTOM_SYMBOL_WIDTH_MM = 20;

function parseViewBox(raw: string): Rect {
  const parts = raw.trim().split(/[\s,]+/).map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
    return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
  }
  return { x: 0, y: 0, width: 64, height: 40 };
}

/**
 * Wrap a user-defined SVG symbol (viewBox units) as a library symbol in mm.
 * The drawing is scaled so its viewBox width becomes 20 mm and re-centred on
 * the origin; ports are scaled the same way. The stroke width is normalised so
 * imported symbols print with the same line weight as built-ins.
 */
export function customSymbolDef(custom: PidSymbolDef): SymbolDef {
  const viewBox = parseViewBox(custom.view_box);
  const scale = CUSTOM_SYMBOL_WIDTH_MM / viewBox.width;
  const centreX = viewBox.x + viewBox.width / 2;
  const centreY = viewBox.y + viewBox.height / 2;
  const strokeWidth = (SYMBOL_STROKE_MM / scale).toFixed(3);
  return {
    library: CUSTOM_LIBRARY,
    key: custom.id,
    version: 1,
    name: custom.name,
    category: custom.category || "custom",
    legend: custom.legend || custom.name.toUpperCase(),
    tagPrefix: custom.tag_prefix || undefined,
    width: CUSTOM_SYMBOL_WIDTH_MM,
    height: viewBox.height * scale,
    svg: `<g transform="scale(${scale}) translate(${-centreX} ${-centreY})" stroke-width="${strokeWidth}">${custom.svg}</g>`,
    ports: custom.ports.map((port) => ({
      id: port.id,
      x: (port.x - centreX) * scale,
      y: (port.y - centreY) * scale,
      side: port.side,
      kind: "process"
    }))
  };
}

export class SymbolRegistry {
  private readonly defs = new Map<string, SymbolDef>();
  private readonly latest = new Map<string, SymbolDef>();

  constructor(defs: SymbolDef[] = []) {
    defs.forEach((definition) => this.register(definition));
  }

  static withBuiltins(customSymbols: PidSymbolDef[] = []): SymbolRegistry {
    return new SymbolRegistry([...BUILTIN_SYMBOLS, ...customSymbols.map(customSymbolDef)]);
  }

  register(definition: SymbolDef): void {
    this.defs.set(symbolKey(refFor(definition)), definition);
    const latestKey = `${definition.library}/${definition.key}`;
    const current = this.latest.get(latestKey);
    if (!current || current.version < definition.version) this.latest.set(latestKey, definition);
  }

  /** Exact version, else the latest version of the same key, else the placeholder. */
  resolve(ref: SymbolRef): SymbolDef {
    return this.defs.get(symbolKey(ref)) ?? this.latest.get(`${ref.library}/${ref.key}`) ?? MISSING_SYMBOL;
  }

  has(ref: SymbolRef): boolean {
    return this.defs.has(symbolKey(ref)) || this.latest.has(`${ref.library}/${ref.key}`);
  }

  list(): SymbolDef[] {
    return [...this.latest.values()];
  }

  builtin(key: string): SymbolDef {
    return this.resolve({ library: BUILTIN_LIBRARY, key, version: 1 });
  }

  /** Actuator definition composed onto an item, if any. */
  actuatorOf(item: SymbolItem): SymbolDef | null {
    if (!item.actuator) return null;
    const definition = this.resolve(item.actuator);
    return definition.category === "actuator" ? definition : null;
  }

  /** Ports of a placed symbol including a composed actuator's ports. */
  portsOf(item: SymbolItem): WorldPort[] {
    return symbolPorts(item, this.resolve(item.symbol), this.actuatorOf(item));
  }

  /** Bounds of a placed symbol including a composed actuator. */
  boundsOf(item: SymbolItem): Rect {
    return symbolBounds(item, this.resolve(item.symbol), this.actuatorOf(item));
  }

  listActuators(): SymbolDef[] {
    return this.list().filter((definition) => definition.category === "actuator");
  }
}

/* ---------- Instance geometry ---------- */

export type WorldPort = {
  id: string;
  position: Point;
  side: Side;
  kind: PortDef["kind"];
  size?: string;
};

/** Port definitions of a body plus its composed actuator, translated to the mount. */
export function composedPorts(definition: SymbolDef, actuatorDef?: SymbolDef | null): PortDef[] {
  if (!actuatorDef || !definition.actuatorMount) return definition.ports;
  const mount = definition.actuatorMount;
  return [
    ...definition.ports,
    ...actuatorDef.ports.map((port) => ({ ...port, x: port.x + mount.x, y: port.y + mount.y }))
  ];
}

/** Ports of a placed symbol in sheet coordinates, after scale, mirror, and rotation. */
export function symbolPorts(item: SymbolItem, definition: SymbolDef, actuatorDef?: SymbolDef | null): WorldPort[] {
  const scale = item.scale ?? 1;
  return composedPorts(definition, actuatorDef).map((port) => {
    let offset: Point = { x: port.x * scale, y: port.y * scale };
    let side = port.side;
    if (item.mirror) {
      offset = { x: -offset.x, y: offset.y };
      side = mirrorSide(side);
    }
    offset = rotateOffset(offset, item.rotation);
    side = rotateSide(side, item.rotation);
    return {
      id: port.id,
      position: { x: item.position.x + offset.x, y: item.position.y + offset.y },
      side,
      kind: port.kind ?? "process",
      size: port.size
    };
  });
}

/** Unrotated extent of a body plus its actuator, relative to the origin. */
export function composedExtent(definition: SymbolDef, actuatorDef?: SymbolDef | null): Rect {
  const body: Rect = { x: -definition.width / 2, y: -definition.height / 2, width: definition.width, height: definition.height };
  if (!actuatorDef || !definition.actuatorMount) return body;
  const mount = definition.actuatorMount;
  const top = mount.y - actuatorDef.height;
  const minY = Math.min(body.y, top);
  const minX = Math.min(body.x, mount.x - actuatorDef.width / 2);
  const maxX = Math.max(body.x + body.width, mount.x + actuatorDef.width / 2);
  return { x: minX, y: minY, width: maxX - minX, height: body.y + body.height - minY };
}

/** Axis-aligned bounds of a placed symbol in sheet coordinates. */
export function symbolBounds(item: SymbolItem, definition: SymbolDef, actuatorDef?: SymbolDef | null): Rect {
  const scale = item.scale ?? 1;
  const extent = composedExtent(definition, actuatorDef);
  // Rotate the four corners of the extent (mirror flips x first).
  const corners = [
    { x: extent.x, y: extent.y },
    { x: extent.x + extent.width, y: extent.y },
    { x: extent.x, y: extent.y + extent.height },
    { x: extent.x + extent.width, y: extent.y + extent.height }
  ].map((corner) => {
    const mirrored = item.mirror ? { x: -corner.x, y: corner.y } : corner;
    return rotateOffset({ x: mirrored.x * scale, y: mirrored.y * scale }, item.rotation);
  });
  const minX = Math.min(...corners.map((corner) => corner.x));
  const maxX = Math.max(...corners.map((corner) => corner.x));
  const minY = Math.min(...corners.map((corner) => corner.y));
  const maxY = Math.max(...corners.map((corner) => corner.y));
  return { x: item.position.x + minX, y: item.position.y + minY, width: maxX - minX, height: maxY - minY };
}
