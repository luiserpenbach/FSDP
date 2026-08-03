/**
 * Stroke-based P&ID symbol set (ISA-inspired schematic glyphs).
 * All symbols share a 64x40 viewBox and draw with currentColor so the
 * canvas theme controls their appearance.
 */
import type { ReactNode } from "react";

const STROKE = 2.2;

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      className="pidGlyphSvg"
      viewBox="0 0 64 40"
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
};

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
];

export function PidGlyph({ type }: { type: string }) {
  const Glyph = GLYPHS[type] ?? ComponentGlyph;
  return <Glyph />;
}
