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

export const BUILTIN_LIBRARY = "fsdp";
export const CUSTOM_LIBRARY = "custom";
/** Line width for symbol geometry (ISO 128 medium line). */
export const SYMBOL_STROKE_MM = 0.35;

const INLINE_PORTS: PortDef[] = [
  { id: "in", x: -10, y: 0, side: "left", kind: "process" },
  { id: "out", x: 10, y: 0, side: "right", kind: "process" }
];

const VALVE_BODY = 'M-6,-3.5 L0,0 L-6,3.5 Z M6,-3.5 L0,0 L6,3.5 Z';
const INLINE_STUBS = 'M-10,0 H-6 M6,0 H10';

function def(partial: Omit<SymbolDef, "library" | "version">): SymbolDef {
  return { library: BUILTIN_LIBRARY, version: 1, ...partial };
}

export const BUILTIN_SYMBOLS: SymbolDef[] = [
  def({
    key: "valve",
    name: "Valve (gate)",
    category: "valve",
    legend: "GATE VALVE",
    standardRef: "ISA-5.1",
    width: 20,
    height: 7,
    svg: `<path d="${VALVE_BODY} ${INLINE_STUBS}"/>`,
    ports: INLINE_PORTS,
    tagPrefix: "HV"
  }),
  def({
    key: "ball_valve",
    name: "Ball valve",
    category: "valve",
    legend: "BALL VALVE",
    standardRef: "ISA-5.1",
    width: 20,
    height: 7,
    svg: `<path d="${VALVE_BODY} ${INLINE_STUBS}"/><circle cx="0" cy="0" r="1.8" fill="#fff"/>`,
    ports: INLINE_PORTS,
    tagPrefix: "HV"
  }),
  def({
    key: "globe_valve",
    name: "Globe valve",
    category: "valve",
    legend: "GLOBE VALVE",
    standardRef: "ISA-5.1",
    width: 20,
    height: 7,
    svg: `<path d="${VALVE_BODY} ${INLINE_STUBS}"/><circle cx="0" cy="0" r="1.2" fill="currentColor"/>`,
    ports: INLINE_PORTS,
    tagPrefix: "HV"
  }),
  def({
    key: "needle_valve",
    name: "Needle valve",
    category: "valve",
    legend: "NEEDLE VALVE",
    standardRef: "ISA-5.1",
    width: 20,
    height: 9,
    svg: `<path d="${VALVE_BODY} ${INLINE_STUBS} M0,0 V-4.5 M-1.5,-4.5 H1.5"/>`,
    ports: INLINE_PORTS,
    tagPrefix: "NV"
  }),
  def({
    key: "check_valve",
    name: "Check valve",
    category: "valve",
    legend: "CHECK VALVE",
    standardRef: "ISA-5.1",
    width: 20,
    height: 7,
    svg: '<path d="M-6,-3.5 L4,0 L-6,3.5 Z M4,-3.5 V3.5 M-10,0 H-6 M4,0 H10"/>',
    ports: INLINE_PORTS,
    tagPrefix: "CV"
  }),
  def({
    key: "three_way_valve",
    name: "3-way valve",
    category: "valve",
    legend: "3-WAY VALVE",
    standardRef: "ISA-5.1",
    width: 20,
    height: 13.5,
    svg: `<path d="${VALVE_BODY} ${INLINE_STUBS} M-3.5,6 L0,0 L3.5,6 Z M0,6 V10"/>`,
    ports: [...INLINE_PORTS, { id: "branch", x: 0, y: 10, side: "bottom", kind: "process" }],
    tagPrefix: "HV"
  }),
  def({
    key: "hand_valve",
    name: "Hand valve",
    category: "valve",
    legend: "HAND VALVE",
    standardRef: "ISA-5.1",
    width: 20,
    height: 12,
    svg: `<path d="${VALVE_BODY} ${INLINE_STUBS} M0,0 V-6 M-3,-6 H3"/>`,
    ports: INLINE_PORTS,
    tagPrefix: "HV"
  }),
  def({
    key: "solenoid_valve",
    name: "Solenoid valve",
    category: "valve",
    legend: "SOLENOID VALVE",
    standardRef: "ISA-5.1",
    width: 20,
    height: 14,
    svg: `<path d="${VALVE_BODY} ${INLINE_STUBS} M0,0 V-4 M-3,-4 H3 V-9 H-3 Z"/><text x="0" y="-5.4" font-size="3.2" text-anchor="middle" fill="currentColor" stroke="none">S</text>`,
    ports: [...INLINE_PORTS, { id: "signal", x: 0, y: -10, side: "top", kind: "signal" }],
    tagPrefix: "SV"
  }),
  def({
    key: "pneumatic_valve",
    name: "Pneumatic control valve",
    category: "valve",
    legend: "PNEUMATIC CONTROL VALVE",
    standardRef: "ISA-5.1",
    width: 20,
    height: 15,
    svg: `<path d="${VALVE_BODY} ${INLINE_STUBS} M0,0 V-6 M-5,-6 A5,3 0 0 1 5,-6 Z"/>`,
    ports: [...INLINE_PORTS, { id: "signal", x: 0, y: -10, side: "top", kind: "signal" }],
    tagPrefix: "PV"
  }),
  def({
    key: "relief_valve",
    name: "Relief valve",
    category: "valve",
    legend: "RELIEF VALVE",
    standardRef: "ISA-5.1",
    width: 20,
    height: 20,
    svg: '<path d="M-10,0 H-7 M-7,-3.5 L0,0 L-7,3.5 Z M-3.5,-7 L0,0 L3.5,-7 Z M0,-7 V-10 M2,-1.5 l3,-1.5 M2,-3.5 l3,-1.5 M2,-5.5 l3,-1.5"/>',
    ports: [
      { id: "in", x: -10, y: 0, side: "left", kind: "process" },
      { id: "vent", x: 0, y: -10, side: "top", kind: "process" }
    ],
    tagPrefix: "PSV"
  }),
  def({
    key: "rupture_disc",
    name: "Rupture disc",
    category: "valve",
    legend: "RUPTURE DISC",
    standardRef: "ISA-5.1",
    width: 20,
    height: 10,
    svg: '<path d="M-10,0 H-3 M-3,-5 V5 M-3,-5 Q4,0 -3,5 M3,0 H10"/>',
    ports: INLINE_PORTS,
    tagPrefix: "PSE"
  }),
  def({
    key: "regulator",
    name: "Pressure regulator",
    category: "regulator",
    legend: "PRESSURE REGULATOR",
    standardRef: "ISA-5.1",
    width: 20,
    height: 13.5,
    svg: `<path d="${VALVE_BODY} ${INLINE_STUBS} M0,0 V-6 M-5,-6 A5,3 0 0 1 5,-6 Z M0,-9 V-10"/>`,
    ports: INLINE_PORTS,
    tagPrefix: "PCV"
  }),
  def({
    key: "filter",
    name: "Filter",
    category: "inline",
    legend: "FILTER",
    standardRef: "ISO 10628",
    width: 20,
    height: 12,
    svg: '<path d="M-4,-6 H4 V6 H-4 Z M-10,0 H-4 M4,0 H10 M-4,-3 L4,-1 M-4,1 L4,3"/>',
    ports: INLINE_PORTS,
    tagPrefix: "F"
  }),
  def({
    key: "strainer",
    name: "Strainer",
    category: "inline",
    legend: "STRAINER",
    standardRef: "ISO 10628",
    width: 20,
    height: 10,
    svg: '<path d="M-10,0 H10 M-4,-5 L4,5 M-4,5 L4,-5"/>',
    ports: INLINE_PORTS,
    tagPrefix: "STR"
  }),
  def({
    key: "orifice",
    name: "Orifice plate",
    category: "inline",
    legend: "ORIFICE",
    standardRef: "ISA-5.1",
    width: 20,
    height: 8,
    svg: '<path d="M-10,0 H-1 M1,0 H10 M-1,-4 V4 M1,-4 V4"/>',
    ports: INLINE_PORTS,
    tagPrefix: "FO"
  }),
  def({
    key: "flex_hose",
    name: "Flex hose",
    category: "inline",
    legend: "FLEX HOSE",
    standardRef: "ISO 10628",
    width: 20,
    height: 6,
    svg: '<path d="M-10,0 H-6 C-4,-4 -2,4 0,0 C2,-4 4,4 6,0 H10"/>',
    ports: INLINE_PORTS,
    tagPrefix: "FH"
  }),
  def({
    key: "reducer",
    name: "Reducer",
    category: "inline",
    legend: "REDUCER",
    standardRef: "ISO 10628",
    width: 20,
    height: 8,
    svg: '<path d="M-10,0 H-5 M-5,-4 L5,-2 V2 L-5,4 Z M5,0 H10"/>',
    ports: INLINE_PORTS,
    tagPrefix: "RED"
  }),
  def({
    key: "quick_disconnect",
    name: "Quick disconnect",
    category: "inline",
    legend: "QUICK DISCONNECT",
    standardRef: "ISO 10628",
    width: 20,
    height: 8,
    svg: '<path d="M-10,0 H-2 M2,0 H10 M-2,-4 V4 M2,-4 V4 M-5,-4 V4 M5,-4 V4"/>',
    ports: INLINE_PORTS,
    tagPrefix: "QD"
  }),
  def({
    key: "heat_exchanger",
    name: "Heat exchanger",
    category: "equipment",
    legend: "HEAT EXCHANGER",
    standardRef: "ISO 10628",
    width: 20,
    height: 12,
    svg: '<circle cx="0" cy="0" r="6"/><path d="M-6,0 L-3,-3 L0,3 L3,-3 L6,0 M-10,0 H-6 M6,0 H10"/>',
    ports: INLINE_PORTS,
    tagPrefix: "HX"
  }),
  def({
    key: "pump",
    name: "Pump",
    category: "equipment",
    legend: "PUMP",
    standardRef: "ISO 10628",
    width: 20,
    height: 12,
    svg: '<circle cx="0" cy="0" r="6"/><path d="M-3,-4 L5,0 L-3,4 M-10,0 H-6 M6,0 H10"/>',
    ports: INLINE_PORTS,
    tagPrefix: "P"
  }),
  def({
    key: "compressor",
    name: "Compressor",
    category: "equipment",
    legend: "COMPRESSOR",
    standardRef: "ISO 10628",
    width: 20,
    height: 12,
    svg: '<circle cx="0" cy="0" r="6"/><path d="M-4,-4 L4,-2 V2 L-4,4 Z M-10,0 H-6 M6,0 H10"/>',
    ports: INLINE_PORTS,
    tagPrefix: "C"
  }),
  def({
    key: "tank",
    name: "Tank / vessel",
    category: "equipment",
    legend: "TANK",
    standardRef: "ISO 10628",
    width: 15,
    height: 20,
    svg: '<path d="M-7.5,-7.5 V7.5 A7.5,2.5 0 0 0 7.5,7.5 V-7.5 A7.5,2.5 0 0 0 -7.5,-7.5 Z"/>',
    ports: [
      { id: "top", x: 0, y: -10, side: "top", kind: "nozzle" },
      { id: "out", x: 7.5, y: 0, side: "right", kind: "nozzle" },
      { id: "bottom", x: 0, y: 10, side: "bottom", kind: "nozzle" },
      { id: "left", x: -7.5, y: 0, side: "left", kind: "nozzle" }
    ],
    tagPrefix: "TK"
  }),
  def({
    key: "gas_bottle",
    name: "Gas bottle",
    category: "equipment",
    legend: "GAS CYLINDER",
    standardRef: "ISO 10628",
    width: 10,
    height: 25,
    svg: '<path d="M-5,-7.5 V10 A5,2 0 0 0 5,10 V-7.5 Q5,-10 2,-10 H-2 Q-5,-10 -5,-7.5 Z M0,-10 V-12.5"/>',
    ports: [{ id: "out", x: 0, y: -12.5, side: "top", kind: "nozzle" }],
    tagPrefix: "K"
  }),
  def({
    key: "instrument",
    name: "Instrument (field)",
    category: "instrument",
    legend: "FIELD MOUNTED INSTRUMENT",
    standardRef: "ISA-5.1",
    width: 10,
    height: 10,
    svg: '<circle cx="0" cy="0" r="5" fill="#fff"/>',
    ports: [
      { id: "process", x: 0, y: 5, side: "bottom", kind: "process" },
      { id: "signal_left", x: -5, y: 0, side: "left", kind: "signal" },
      { id: "signal_right", x: 5, y: 0, side: "right", kind: "signal" },
      { id: "signal_top", x: 0, y: -5, side: "top", kind: "signal" }
    ],
    tagPrefix: "PT"
  }),
  def({
    key: "instrument_panel",
    name: "Instrument (control room)",
    category: "instrument",
    legend: "CONTROL ROOM INSTRUMENT",
    standardRef: "ISA-5.1",
    width: 10,
    height: 10,
    svg: '<circle cx="0" cy="0" r="5" fill="#fff"/><path d="M-5,0 H5"/>',
    ports: [
      { id: "process", x: 0, y: 5, side: "bottom", kind: "process" },
      { id: "signal_left", x: -5, y: 0, side: "left", kind: "signal" },
      { id: "signal_right", x: 5, y: 0, side: "right", kind: "signal" },
      { id: "signal_top", x: 0, y: -5, side: "top", kind: "signal" }
    ],
    tagPrefix: "PI"
  }),
  def({
    key: "instrument_plc",
    name: "Instrument (shared display / PLC)",
    category: "instrument",
    legend: "PLC / SHARED DISPLAY",
    standardRef: "ISA-5.1",
    width: 10,
    height: 10,
    svg: '<rect x="-5" y="-5" width="10" height="10" fill="#fff"/><circle cx="0" cy="0" r="5"/>',
    ports: [
      { id: "signal_left", x: -5, y: 0, side: "left", kind: "signal" },
      { id: "signal_right", x: 5, y: 0, side: "right", kind: "signal" },
      { id: "signal_top", x: 0, y: -5, side: "top", kind: "signal" },
      { id: "signal_bottom", x: 0, y: 5, side: "bottom", kind: "signal" }
    ],
    tagPrefix: "PLC"
  }),
  def({
    key: "terminator",
    name: "Off-sheet terminator",
    category: "connector",
    legend: "OFF-SHEET CONNECTION",
    standardRef: "ISA-5.1",
    width: 30,
    height: 8,
    svg: '<path d="M-15,-4 H9 L15,0 L9,4 H-15 Z" fill="#fff"/>',
    ports: [{ id: "in", x: -15, y: 0, side: "left", kind: "process" }],
    tagPrefix: "IF"
  }),
  def({
    key: "component",
    name: "Generic component",
    category: "inline",
    legend: "COMPONENT",
    width: 20,
    height: 10,
    svg: '<path d="M-6,-5 H6 V5 H-6 Z M-10,0 H-6 M6,0 H10"/>',
    ports: INLINE_PORTS,
    tagPrefix: "C"
  })
];

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
    category: "custom",
    legend: custom.name.toUpperCase(),
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
}

/* ---------- Instance geometry ---------- */

export type WorldPort = {
  id: string;
  position: Point;
  side: Side;
  kind: PortDef["kind"];
  size?: string;
};

/** Ports of a placed symbol in sheet coordinates, after scale, mirror, and rotation. */
export function symbolPorts(item: SymbolItem, definition: SymbolDef): WorldPort[] {
  const scale = item.scale ?? 1;
  return definition.ports.map((port) => {
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

/** Axis-aligned bounds of a placed symbol in sheet coordinates. */
export function symbolBounds(item: SymbolItem, definition: SymbolDef): Rect {
  const scale = item.scale ?? 1;
  const swap = item.rotation === 90 || item.rotation === 270;
  const width = (swap ? definition.height : definition.width) * scale;
  const height = (swap ? definition.width : definition.height) * scale;
  return { x: item.position.x - width / 2, y: item.position.y - height / 2, width, height };
}
