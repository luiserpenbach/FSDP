/**
 * Stroke-based P&ID symbol set (ISA-inspired schematic glyphs).
 * All built-in symbols share a 64x40 viewBox and draw with currentColor so the
 * canvas theme controls their appearance.
 *
 * Every symbol also declares its connection ports in viewBox coordinates.
 * Ports sit exactly where the drawn pipe stubs end, so React Flow handles
 * rendered from this data land on the symbol lines with no visual gap.
 */
import { createContext, useContext, type ReactNode } from "react";
import { sanitizeSvgInner } from "./pid/svgSanitize";
import type { PidSymbolDef, SymbolPort } from "../types";

const STROKE = 2.2;

export const SYMBOL_VIEWBOX = "0 0 64 40";

export type ViewBox = { x: number; y: number; width: number; height: number };

export function parseViewBox(raw: string | undefined): ViewBox {
  const parts = (raw ?? SYMBOL_VIEWBOX).trim().split(/[\s,]+/).map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
    return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
  }
  return { x: 0, y: 0, width: 64, height: 40 };
}

export const CUSTOM_SYMBOL_PREFIX = "custom:";

export function customSymbolType(symbolId: string): string {
  return `${CUSTOM_SYMBOL_PREFIX}${symbolId}`;
}

export function customSymbolId(symbolType: string): string | null {
  return symbolType.startsWith(CUSTOM_SYMBOL_PREFIX)
    ? symbolType.slice(CUSTOM_SYMBOL_PREFIX.length)
    : null;
}

/** User-defined symbols, keyed by symbol id, provided by the app once loaded. */
export const CustomSymbolsContext = createContext<Record<string, PidSymbolDef>>({});

export function useCustomSymbol(symbolType: string): PidSymbolDef | null {
  const customSymbols = useContext(CustomSymbolsContext);
  const id = customSymbolId(symbolType);
  return id ? customSymbols[id] ?? null : null;
}

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      className="pidGlyphSvg"
      viewBox={SYMBOL_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      preserveAspectRatio="xMidYMid meet"
    >
      {children}
    </svg>
  );
}

function ValveGlyph() {
  return (
    <Svg>
      <path d="M12 10 L32 20 L12 30 Z" />
      <path d="M52 10 L32 20 L52 30 Z" />
      <path d="M2 20 H12 M52 20 H62" />
    </Svg>
  );
}

function CheckValveGlyph() {
  return (
    <Svg>
      <path d="M14 10 L34 20 L14 30 Z" />
      <path d="M2 20 H14 M34 20 H62" />
      <path d="M34 10 V30" />
      <path d="M40 26 A9 9 0 0 0 34 20" />
    </Svg>
  );
}

function RegulatorGlyph() {
  return (
    <Svg>
      <path d="M14 16 L32 25 L14 34 Z" />
      <path d="M50 16 L32 25 L50 34 Z" />
      <path d="M2 25 H14 M50 25 H62" />
      <path d="M32 25 V12" />
      <path d="M22 12 A10 5 0 0 1 42 12 H22 Z" />
    </Svg>
  );
}

function ReliefValveGlyph() {
  return (
    <Svg>
      <path d="M18 18 L34 26 L18 34 Z" />
      <path d="M4 26 H18" />
      <path d="M34 26 L34 12 L46 6" />
      <path d="M28 20 l6 -3 M28 15 l6 -3 M28 10 l6 -3" />
    </Svg>
  );
}

function SensorGlyph() {
  return (
    <Svg>
      <circle cx="32" cy="17" r="12" />
      <path d="M32 29 V38 M20 38 H44" strokeWidth={1.6} />
    </Svg>
  );
}

function FilterGlyph() {
  return (
    <Svg>
      <path d="M22 6 H42 V34 H22 Z" />
      <path d="M2 20 H22 M42 20 H62" />
      <path d="M24 12 l16 4 M24 20 l16 4 M24 28 l16 4" strokeWidth={1.6} />
    </Svg>
  );
}

function SourceGlyph() {
  return (
    <Svg>
      <path d="M18 8 H46 A10 12 0 0 1 46 32 H18 A10 12 0 0 1 18 8 Z" />
      <path d="M56 20 H62" />
      <path d="M32 8 V2" />
    </Svg>
  );
}

function SinkGlyph() {
  return (
    <Svg>
      <path d="M2 20 H16" />
      <path d="M16 12 V28" />
      <path d="M16 14 L44 8 L58 20 L44 32 L16 26" />
    </Svg>
  );
}

function PumpGlyph() {
  return (
    <Svg>
      <circle cx="32" cy="20" r="14" />
      <path d="M24 12 L44 20 L24 28" />
      <path d="M2 20 H18 M46 20 H62" />
    </Svg>
  );
}

function ComponentGlyph() {
  return (
    <Svg>
      <rect x="18" y="8" width="28" height="24" rx="3" />
      <path d="M2 20 H18 M46 20 H62" />
    </Svg>
  );
}

function JunctionGlyph() {
  return (
    <Svg>
      <path d="M8 20 H56 M32 20 V6" />
      <circle cx="32" cy="20" r="4" fill="currentColor" stroke="none" />
    </Svg>
  );
}

const GLYPHS: Record<string, () => ReactNode> = {
  valve: ValveGlyph,
  check_valve: CheckValveGlyph,
  regulator: RegulatorGlyph,
  relief_valve: ReliefValveGlyph,
  sensor: SensorGlyph,
  filter: FilterGlyph,
  source: SourceGlyph,
  tank: SourceGlyph,
  sink: SinkGlyph,
  pump: PumpGlyph,
  junction: JunctionGlyph,
};

const INLINE_PORTS: SymbolPort[] = [
  { id: "in", x: 2, y: 20, side: "left" },
  { id: "out", x: 62, y: 20, side: "right" },
];

/** Connection ports per symbol, in 64x40 viewBox coordinates. */
export const SYMBOL_PORTS: Record<string, SymbolPort[]> = {
  valve: INLINE_PORTS,
  check_valve: INLINE_PORTS,
  regulator: [
    { id: "in", x: 2, y: 25, side: "left" },
    { id: "out", x: 62, y: 25, side: "right" },
  ],
  relief_valve: [
    { id: "in", x: 4, y: 26, side: "left" },
    { id: "vent", x: 46, y: 6, side: "top" },
  ],
  sensor: [{ id: "process", x: 32, y: 38, side: "bottom" }],
  filter: INLINE_PORTS,
  source: [
    { id: "out", x: 62, y: 20, side: "right" },
    { id: "top", x: 32, y: 2, side: "top" },
  ],
  tank: [
    { id: "out", x: 62, y: 20, side: "right" },
    { id: "top", x: 32, y: 2, side: "top" },
  ],
  sink: [{ id: "in", x: 2, y: 20, side: "left" }],
  pump: INLINE_PORTS,
  component: INLINE_PORTS,
};

export function getSymbolPorts(symbolType: string, custom: PidSymbolDef | null): SymbolPort[] {
  if (custom) return custom.ports;
  return SYMBOL_PORTS[symbolType] ?? SYMBOL_PORTS.component;
}

export function getSymbolViewBox(custom: PidSymbolDef | null): ViewBox {
  return parseViewBox(custom?.view_box);
}

export const SYMBOL_LABELS: Record<string, string> = {
  valve: "Valve",
  check_valve: "Check valve",
  regulator: "Regulator",
  relief_valve: "Relief valve",
  sensor: "Sensor",
  filter: "Filter",
  source: "Tank / Source",
  sink: "Sink / Interface",
  pump: "Pump",
  junction: "Junction",
};

export const PALETTE_SYMBOLS = [
  "valve",
  "check_valve",
  "regulator",
  "relief_valve",
  "sensor",
  "filter",
  "pump",
  "source",
  "sink",
  "junction",
];

export function CustomGlyph({ symbol }: { symbol: PidSymbolDef }) {
  // Re-scrub on render so symbols stored before the API blocklist tighten
  // (or written via a bypass) cannot execute via innerHTML.
  const safeSvg = sanitizeSvgInner(symbol.svg);
  return (
    <svg
      className="pidGlyphSvg"
      viewBox={symbol.view_box}
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      preserveAspectRatio="xMidYMid meet"
      dangerouslySetInnerHTML={{ __html: safeSvg }}
    />
  );
}

export function PidGlyph({ type }: { type: string }) {
  const custom = useCustomSymbol(type);
  if (custom) return <CustomGlyph symbol={custom} />;
  const Glyph = GLYPHS[type] ?? ComponentGlyph;
  return <Glyph />;
}
