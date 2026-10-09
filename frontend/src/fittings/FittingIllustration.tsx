/**
 * Product illustration of a Swagelok tube fitting, drawn from its configuration:
 * body shape, each end (tube fitting nut and tube, male or female thread,
 * tube stub), bulkhead nut, and a metal finish per material. Side view in a
 * 240 × 190 box; `annotate` labels each end with its size.
 */
import { useId, type ReactNode } from "react";
import { THREADS, type ArmType, type Fitting, type MaterialCode } from "./swagelok";

const TONES: Record<MaterialCode, [light: string, mid: string, dark: string]> = {
  SS: ["#f5f7f9", "#c2c9d1", "#77828e"],
  B: ["#fcf0c8", "#d8b24f", "#8a6316"],
  S: ["#e4e6e9", "#9aa1a9", "#535a62"],
  M: ["#f1eee8", "#c4beb1", "#7c766a"],
  HC: ["#eef1f3", "#b1b9c1", "#68727b"],
  A: ["#f8fafb", "#d5dbe1", "#9aa4ae"]
};

/** Tubing (and tube stubs) is drawn lighter than the forged body. */
const TUBE_TONES: [string, string, string] = ["#ffffff", "#dde2e7", "#9aa3ad"];

const EDGE = "rgba(30, 40, 52, 0.55)";
const BODY_HALF = 15;

type Paint = { body: string; tube: string; edge: string };

function Hex({ x, w, h, paint }: { x: number; w: number; h: number; paint: Paint }) {
  return (
    <g>
      <rect x={x} y={-h / 2} width={w} height={h} rx={1.5} fill={paint.body} stroke={paint.edge} strokeWidth={0.8} />
      <line x1={x} x2={x + w} y1={-h / 4} y2={-h / 4} stroke={paint.edge} strokeWidth={0.6} />
      <line x1={x} x2={x + w} y1={h / 4} y2={h / 4} stroke={paint.edge} strokeWidth={0.6} />
    </g>
  );
}

function Cylinder({ x, w, h, fill, paint }: { x: number; w: number; h: number; fill: string; paint: Paint }) {
  return <rect x={x} y={-h / 2} width={w} height={h} rx={1.2} fill={fill} stroke={paint.edge} strokeWidth={0.8} />;
}

function Thread({ x, w, paint }: { x: number; w: number; paint: Paint }) {
  // Tapered pipe thread: slightly narrower at the tip, with crest lines.
  const h0 = 25;
  const h1 = 21;
  const crests: ReactNode[] = [];
  for (let cx = x + 3; cx < x + w - 2; cx += 4) {
    const t = (cx - x) / w;
    const half = (h0 + (h1 - h0) * t) / 2;
    crests.push(<line key={cx} x1={cx} x2={cx + 2.5} y1={-half} y2={half} stroke={paint.edge} strokeWidth={0.55} />);
  }
  return (
    <g>
      <polygon
        points={`${x},${-h0 / 2} ${x + w},${-h1 / 2} ${x + w},${h1 / 2} ${x},${h0 / 2}`}
        fill={paint.body}
        stroke={paint.edge}
        strokeWidth={0.8}
      />
      {crests}
    </g>
  );
}

/** One end, drawn pointing right from the body edge at x0. Returns the drawing and its length. */
function Arm({ type, x0, bulkhead, paint }: { type: ArmType; x0: number; bulkhead?: boolean; paint: Paint }) {
  let x = x0;
  const parts: ReactNode[] = [];
  if (bulkhead) {
    parts.push(<Thread key="bh-thread" x={x} w={30} paint={paint} />);
    parts.push(<rect key="panel" x={x + 14} y={-36} width={5} height={72} fill="url(#panelHatch)" stroke={EDGE} strokeWidth={0.5} opacity={0.7} />);
    parts.push(<Hex key="bh-nut" x={x + 4} w={8} h={48} paint={paint} />);
    x += 30;
  }
  if (type === "tube") {
    parts.push(<Cylinder key="neck" x={x} w={8} h={24} fill={paint.body} paint={paint} />);
    parts.push(<Hex key="nut" x={x + 8} w={22} h={40} paint={paint} />);
    parts.push(<Cylinder key="tube" x={x + 30} w={30} h={14} fill={paint.tube} paint={paint} />);
  } else if (type === "male") {
    parts.push(<Cylinder key="neck" x={x} w={6} h={22} fill={paint.body} paint={paint} />);
    parts.push(<Thread key="thread" x={x + 6} w={34} paint={paint} />);
  } else if (type === "female") {
    parts.push(<Hex key="boss" x={x} w={32} h={40} paint={paint} />);
    parts.push(<line key="bore1" x1={x + 10} x2={x + 32} y1={-11} y2={-11} stroke={paint.edge} strokeWidth={0.8} strokeDasharray="3 2" />);
    parts.push(<line key="bore2" x1={x + 10} x2={x + 32} y1={11} y2={11} stroke={paint.edge} strokeWidth={0.8} strokeDasharray="3 2" />);
  } else {
    parts.push(<Cylinder key="stub" x={x} w={44} h={15} fill={paint.tube} paint={paint} />);
    parts.push(<line key="chamfer" x1={x + 41} x2={x + 41} y1={-7.5} y2={7.5} stroke={paint.edge} strokeWidth={0.5} />);
  }
  return <g>{parts}</g>;
}

function armLength(type: ArmType, bulkhead?: boolean): number {
  const base = type === "tube" ? 60 : type === "male" ? 40 : type === "female" ? 32 : 44;
  return base + (bulkhead ? 30 : 0);
}

const ANGLES: Record<string, number[]> = {
  straight: [180, 0],
  elbow: [180, 270],
  tee: [180, 0, 270],
  cross: [180, 0, 270, 90],
  cap: [180],
  plug: [180]
};

const CENTERS: Record<string, [number, number]> = {
  straight: [120, 98],
  elbow: [148, 124],
  tee: [120, 126],
  cross: [120, 95],
  cap: [158, 95],
  plug: [158, 95]
};

function shortEndLabel(fitting: Fitting, type: ArmType, index: number): string {
  const size = fitting.tube2 && index === 1 ? fitting.tube2 : fitting.tube;
  if (type === "tube") return `${size.label} tube`;
  if (type === "stub") return `${size.label} stub`;
  const thread = fitting.thread ? THREADS[fitting.thread].label.replace(/ \(.*\)/, "") : "";
  return `${fitting.pipe?.label ?? ""} ${thread} ${type === "male" ? "M" : "F"}`.replace(/\s+/g, " ").trim();
}

export function FittingIllustration({
  fitting,
  annotate = false,
  className = "",
  title
}: {
  fitting: Fitting;
  annotate?: boolean;
  className?: string;
  title?: string;
}) {
  // Gradient ids must be valid in url(#...) and differ per material (static renders reuse useId values).
  const uid = `${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-${fitting.material.code}`;
  const [light, mid, dark] = TONES[fitting.material.code];
  const paint: Paint = { body: `url(#body-${uid})`, tube: `url(#tube-${uid})`, edge: EDGE };
  const shape = fitting.kind.shape;

  let content: ReactNode;
  if (shape === "nut" || shape === "ferrule" || shape === "ferrule-set") {
    content = <Component fitting={fitting} paint={paint} />;
  } else {
    const [cx, cy] = CENTERS[shape];
    const angles = ANGLES[shape];
    const labels: ReactNode[] = [];
    const arms = fitting.ends.map((end, index) => {
      const angle = angles[index] ?? 0;
      const x0 = shape === "cap" || shape === "plug" ? 12 : fitting.kind.id === "port_connector" ? 0 : BODY_HALF;
      if (annotate) {
        const reach = x0 + armLength(end.type, end.bulkhead) + 6;
        const rad = (angle * Math.PI) / 180;
        const tx = cx + Math.cos(rad) * reach;
        const ty = cy + Math.sin(rad) * reach;
        const horizontal = angle === 0 || angle === 180;
        labels.push(
          <text
            key={`label-${index}`}
            className="fittingIllustrationLabel"
            x={tx}
            y={horizontal ? ty + 34 : angle === 270 ? ty - 2 : ty + 10}
            textAnchor={horizontal ? (angle === 0 ? "end" : "start") : "middle"}
          >
            {shortEndLabel(fitting, end.type, index)}
          </text>
        );
      }
      return (
        // Mirror (not rotate) the left end so its shading stays lit from above.
        <g key={index} transform={angle === 180 ? "scale(-1 1)" : `rotate(${angle})`}>
          <Arm type={end.type} x0={x0} bulkhead={end.bulkhead} paint={paint} />
        </g>
      );
    });
    let body: ReactNode = null;
    if (shape === "straight" && fitting.kind.id !== "port_connector") {
      body = <Hex x={-BODY_HALF} w={BODY_HALF * 2} h={44} paint={paint} />;
    } else if (shape === "elbow" || shape === "tee" || shape === "cross") {
      body = <rect x={-19} y={-19} width={38} height={38} rx={5} fill={paint.body} stroke={EDGE} strokeWidth={0.8} />;
    } else if (shape === "cap") {
      body = (
        <g>
          <Hex x={-12} w={22} h={40} paint={paint} />
          <path d="M10,-14 Q22,-14 22,0 Q22,14 10,14 Z" fill={paint.body} stroke={EDGE} strokeWidth={0.8} />
        </g>
      );
    } else if (shape === "plug") {
      body = <Hex x={-12} w={24} h={40} paint={paint} />;
    }
    content = (
      <>
        <g transform={`translate(${cx} ${cy})`}>
          {arms}
          {body}
        </g>
        {labels}
      </>
    );
  }

  // An empty title marks a decorative thumbnail (the text next to it names the fitting).
  const a11y = title === "" ? { "aria-hidden": true } : { role: "img", "aria-label": title ?? `Illustration of ${fitting.description}` };

  return (
    <svg
      className={`fittingIllustration ${className}`.trim()}
      viewBox="0 0 240 190"
      {...a11y}
    >
      <defs>
        <linearGradient id={`body-${uid}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={light} />
          <stop offset="0.45" stopColor={mid} />
          <stop offset="1" stopColor={dark} />
        </linearGradient>
        <linearGradient id={`tube-${uid}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={TUBE_TONES[0]} />
          <stop offset="0.5" stopColor={TUBE_TONES[1]} />
          <stop offset="1" stopColor={TUBE_TONES[2]} />
        </linearGradient>
        <pattern id="panelHatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="4" height="4" fill="#cfd5dc" />
          <line x1="0" y1="0" x2="0" y2="4" stroke="#8b96a3" strokeWidth="1" />
        </pattern>
      </defs>
      {content}
    </svg>
  );
}

/** Nuts and ferrules: a side view and, for the nut, an end view. */
function Component({ fitting, paint }: { fitting: Fitting; paint: Paint }) {
  const shape = fitting.kind.shape;
  const front = (x: number, y: number) => (
    <g transform={`translate(${x} ${y})`}>
      <polygon points="0,-9 30,-17 34,-17 34,17 30,17 0,9" fill={paint.body} stroke={EDGE} strokeWidth={0.8} />
      <line x1={0} x2={34} y1={0} y2={0} stroke={EDGE} strokeWidth={0.4} strokeDasharray="2 2" />
    </g>
  );
  const back = (x: number, y: number) => (
    <g transform={`translate(${x} ${y})`}>
      <polygon points="0,-13 4,-19 18,-19 18,19 4,19 0,13" fill={paint.body} stroke={EDGE} strokeWidth={0.8} />
      <line x1={0} x2={18} y1={0} y2={0} stroke={EDGE} strokeWidth={0.4} strokeDasharray="2 2" />
    </g>
  );
  if (shape === "nut") {
    const r = 40;
    const hexagon = Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i;
      return `${170 + r * Math.cos(a)},${95 + r * Math.sin(a)}`;
    }).join(" ");
    return (
      <g>
        <g transform="translate(40 95)">
          <Hex x={0} w={58} h={72} paint={paint} />
          <line x1={0} x2={46} y1={-22} y2={-22} stroke={EDGE} strokeWidth={0.7} strokeDasharray="3 2" />
          <line x1={0} x2={46} y1={22} y2={22} stroke={EDGE} strokeWidth={0.7} strokeDasharray="3 2" />
        </g>
        <polygon points={hexagon} fill={paint.body} stroke={EDGE} strokeWidth={0.9} />
        <circle cx={170} cy={95} r={22} fill="#26313d" opacity={0.75} />
        <circle cx={170} cy={95} r={13} fill={paint.tube} stroke={EDGE} strokeWidth={0.6} />
      </g>
    );
  }
  if (shape === "ferrule-set") {
    return (
      <g>
        {front(66, 95)}
        {back(140, 95)}
        <text className="fittingIllustrationLabel" x={83} y={132} textAnchor="middle">front</text>
        <text className="fittingIllustrationLabel" x={149} y={132} textAnchor="middle">back</text>
      </g>
    );
  }
  return fitting.kind.id === "front_ferrule" ? (
    <g transform="translate(77 0) scale(1.6) translate(0 59)">{front(10, 0)}</g>
  ) : (
    <g transform="translate(82 0) scale(2) translate(0 47.5)">{back(10, 0)}</g>
  );
}
