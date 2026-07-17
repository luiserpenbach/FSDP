import type { PidSymbolDefinition, SymbolPrimitive } from "../../pid-cad";
import { INSTRUMENT_LETTERS } from "../../pid-cad";

function arcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const start = { x: cx + r * Math.cos(toRad(startAngle)), y: cy + r * Math.sin(toRad(startAngle)) };
  const end = { x: cx + r * Math.cos(toRad(endAngle)), y: cy + r * Math.sin(toRad(endAngle)) };
  const large = Math.abs(endAngle - startAngle) > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y}`;
}

export function renderPrimitive(primitive: SymbolPrimitive, selected = false) {
  const common = {
    fill: "none" as const,
    key: primitive.id,
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: primitive.strokeWidth ?? 3,
    className: selected ? "selected" : undefined
  };
  if (primitive.kind === "line") {
    return <line {...common} x1={primitive.x1} x2={primitive.x2} y1={primitive.y1} y2={primitive.y2} />;
  }
  if (primitive.kind === "rect") {
    return <rect {...common} height={primitive.height} width={primitive.width} x={primitive.x} y={primitive.y} />;
  }
  if (primitive.kind === "circle") {
    return <circle {...common} cx={primitive.cx} cy={primitive.cy} r={primitive.r} />;
  }
  if (primitive.kind === "polyline") {
    return <polyline {...common} points={primitive.points.map((p) => `${p.x},${p.y}`).join(" ")} />;
  }
  return <path {...common} d={arcPath(primitive.cx, primitive.cy, primitive.r, primitive.startAngle, primitive.endAngle)} />;
}

export function SymbolArtwork({ symbol, showLetter = true }: { symbol: PidSymbolDefinition; showLetter?: boolean }) {
  const letter = showLetter ? INSTRUMENT_LETTERS[symbol.id] : undefined;
  return (
    <svg aria-label={symbol.name} className="pidSymbolSvg" viewBox="0 0 100 100">
      {symbol.primitives.map((primitive) => renderPrimitive(primitive))}
      {letter && (
        <text className="pidInstrumentLetter" dominantBaseline="middle" textAnchor="middle" x="50" y="42">
          {letter}
        </text>
      )}
    </svg>
  );
}
