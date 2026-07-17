import type { PidSymbolDefinition, SymbolPort } from "../model/types";

const H: SymbolPort[] = [
  { id: "left", name: "Left", x: 0, y: 50, direction: "bidir", required: true },
  { id: "right", name: "Right", x: 100, y: 50, direction: "bidir", required: true }
];

const L: SymbolPort[] = [{ id: "left", name: "Inlet", x: 0, y: 50, direction: "in", required: true }];
const R: SymbolPort[] = [{ id: "right", name: "Outlet", x: 100, y: 50, direction: "out", required: true }];
const B: SymbolPort[] = [{ id: "bottom", name: "Process", x: 50, y: 100, direction: "bidir", required: true }];

function valveBody(prefix: string) {
  return [
    { id: `${prefix}1`, kind: "line" as const, x1: 10, y1: 20, x2: 50, y2: 50 },
    { id: `${prefix}2`, kind: "line" as const, x1: 10, y1: 80, x2: 50, y2: 50 },
    { id: `${prefix}3`, kind: "line" as const, x1: 90, y1: 20, x2: 50, y2: 50 },
    { id: `${prefix}4`, kind: "line" as const, x1: 90, y1: 80, x2: 50, y2: 50 },
    { id: `${prefix}5`, kind: "line" as const, x1: 10, y1: 20, x2: 10, y2: 80 },
    { id: `${prefix}6`, kind: "line" as const, x1: 90, y1: 20, x2: 90, y2: 80 },
    { id: `${prefix}7`, kind: "line" as const, x1: 0, y1: 50, x2: 10, y2: 50 },
    { id: `${prefix}8`, kind: "line" as const, x1: 90, y1: 50, x2: 100, y2: 50 }
  ];
}

export const BUILT_IN_SYMBOLS: PidSymbolDefinition[] = [
  {
    id: "gate_valve",
    name: "Gate valve",
    category: "valve",
    builtIn: true,
    ports: H,
    primitives: [...valveBody("gv"), { id: "gv9", kind: "line", x1: 50, y1: 50, x2: 50, y2: 18 }]
  },
  {
    id: "valve",
    name: "Valve",
    category: "valve",
    builtIn: true,
    ports: H,
    primitives: valveBody("v")
  },
  {
    id: "globe_valve",
    name: "Globe valve",
    category: "valve",
    builtIn: true,
    ports: H,
    primitives: [
      ...valveBody("gl"),
      { id: "gl9", kind: "arc", cx: 50, cy: 50, r: 14, startAngle: 200, endAngle: 340 }
    ]
  },
  {
    id: "ball_valve",
    name: "Ball valve",
    category: "valve",
    builtIn: true,
    ports: H,
    primitives: [
      { id: "bv1", kind: "line", x1: 0, y1: 50, x2: 22, y2: 50 },
      { id: "bv2", kind: "line", x1: 78, y1: 50, x2: 100, y2: 50 },
      { id: "bv3", kind: "circle", cx: 50, cy: 50, r: 22 },
      { id: "bv4", kind: "line", x1: 32, y1: 50, x2: 68, y2: 50 }
    ]
  },
  {
    id: "check_valve",
    name: "Check valve",
    category: "valve",
    builtIn: true,
    ports: H,
    primitives: [
      { id: "cv1", kind: "line", x1: 0, y1: 50, x2: 28, y2: 50 },
      { id: "cv2", kind: "line", x1: 72, y1: 50, x2: 100, y2: 50 },
      { id: "cv3", kind: "line", x1: 28, y1: 22, x2: 28, y2: 78 },
      { id: "cv4", kind: "line", x1: 28, y1: 22, x2: 72, y2: 50 },
      { id: "cv5", kind: "line", x1: 28, y1: 78, x2: 72, y2: 50 }
    ]
  },
  {
    id: "regulator",
    name: "Regulator",
    category: "valve",
    builtIn: true,
    ports: H,
    primitives: [
      { id: "r1", kind: "line", x1: 8, y1: 50, x2: 28, y2: 50 },
      { id: "r2", kind: "rect", x: 28, y: 28, width: 44, height: 44 },
      { id: "r3", kind: "line", x1: 72, y1: 50, x2: 92, y2: 50 },
      { id: "r4", kind: "line", x1: 50, y1: 28, x2: 50, y2: 10 },
      { id: "r5", kind: "line", x1: 40, y1: 10, x2: 60, y2: 10 }
    ]
  },
  {
    id: "psv",
    name: "Relief valve (PSV)",
    category: "valve",
    builtIn: true,
    ports: [
      { id: "bottom", name: "Inlet", x: 50, y: 100, direction: "in", required: true },
      { id: "right", name: "Outlet", x: 100, y: 40, direction: "out", required: true }
    ],
    primitives: [
      { id: "p1", kind: "line", x1: 50, y1: 100, x2: 50, y2: 70 },
      { id: "p2", kind: "line", x1: 30, y1: 70, x2: 70, y2: 70 },
      { id: "p3", kind: "line", x1: 30, y1: 70, x2: 50, y2: 30 },
      { id: "p4", kind: "line", x1: 70, y1: 70, x2: 50, y2: 30 },
      { id: "p5", kind: "line", x1: 50, y1: 30, x2: 50, y2: 18 },
      { id: "p6", kind: "line", x1: 50, y1: 40, x2: 100, y2: 40 }
    ]
  },
  {
    id: "orifice",
    name: "Orifice",
    category: "fitting",
    builtIn: true,
    ports: H,
    primitives: [
      { id: "o1", kind: "line", x1: 0, y1: 50, x2: 38, y2: 50 },
      { id: "o2", kind: "line", x1: 62, y1: 50, x2: 100, y2: 50 },
      { id: "o3", kind: "line", x1: 38, y1: 28, x2: 38, y2: 72 },
      { id: "o4", kind: "line", x1: 62, y1: 28, x2: 62, y2: 72 },
      { id: "o5", kind: "circle", cx: 50, cy: 50, r: 8 }
    ]
  },
  {
    id: "filter",
    name: "Filter",
    category: "equipment",
    builtIn: true,
    ports: H,
    primitives: [
      { id: "f1", kind: "rect", x: 20, y: 20, width: 60, height: 60 },
      { id: "f2", kind: "line", x1: 20, y1: 80, x2: 80, y2: 20 },
      { id: "f3", kind: "line", x1: 0, y1: 50, x2: 20, y2: 50 },
      { id: "f4", kind: "line", x1: 80, y1: 50, x2: 100, y2: 50 }
    ]
  },
  {
    id: "pump",
    name: "Pump",
    category: "equipment",
    builtIn: true,
    ports: H,
    primitives: [
      { id: "pu1", kind: "circle", cx: 50, cy: 50, r: 28 },
      { id: "pu2", kind: "line", x1: 0, y1: 50, x2: 22, y2: 50 },
      { id: "pu3", kind: "line", x1: 78, y1: 50, x2: 100, y2: 50 },
      { id: "pu4", kind: "line", x1: 38, y1: 38, x2: 62, y2: 50 },
      { id: "pu5", kind: "line", x1: 38, y1: 62, x2: 62, y2: 50 }
    ]
  },
  {
    id: "heat_exchanger",
    name: "Heat exchanger",
    category: "equipment",
    builtIn: true,
    ports: [
      ...H,
      { id: "top", name: "Utility in", x: 50, y: 0, direction: "in", required: false },
      { id: "bottom", name: "Utility out", x: 50, y: 100, direction: "out", required: false }
    ],
    primitives: [
      { id: "hx1", kind: "rect", x: 22, y: 18, width: 56, height: 64 },
      { id: "hx2", kind: "line", x1: 0, y1: 50, x2: 22, y2: 50 },
      { id: "hx3", kind: "line", x1: 78, y1: 50, x2: 100, y2: 50 },
      { id: "hx4", kind: "polyline", points: [{ x: 34, y: 30 }, { x: 50, y: 42 }, { x: 34, y: 54 }, { x: 50, y: 66 }, { x: 34, y: 78 }] },
      { id: "hx5", kind: "line", x1: 50, y1: 0, x2: 50, y2: 18 },
      { id: "hx6", kind: "line", x1: 50, y1: 82, x2: 50, y2: 100 }
    ]
  },
  {
    id: "source",
    name: "Tank / source",
    category: "equipment",
    builtIn: true,
    ports: R,
    primitives: [
      { id: "t1", kind: "rect", x: 15, y: 14, width: 70, height: 70 },
      { id: "t2", kind: "line", x1: 15, y1: 58, x2: 85, y2: 58 },
      { id: "t3", kind: "line", x1: 85, y1: 58, x2: 100, y2: 58 }
    ]
  },
  {
    id: "sink",
    name: "Equipment / sink",
    category: "equipment",
    builtIn: true,
    ports: L,
    primitives: [
      { id: "e1", kind: "circle", cx: 55, cy: 50, r: 35 },
      { id: "e2", kind: "line", x1: 0, y1: 50, x2: 20, y2: 50 },
      { id: "e3", kind: "line", x1: 42, y1: 35, x2: 68, y2: 50 },
      { id: "e4", kind: "line", x1: 68, y1: 50, x2: 42, y2: 65 }
    ]
  },
  {
    id: "flange",
    name: "Flange pair",
    category: "fitting",
    builtIn: true,
    ports: H,
    primitives: [
      { id: "fl1", kind: "line", x1: 0, y1: 50, x2: 38, y2: 50 },
      { id: "fl2", kind: "line", x1: 62, y1: 50, x2: 100, y2: 50 },
      { id: "fl3", kind: "line", x1: 38, y1: 30, x2: 38, y2: 70 },
      { id: "fl4", kind: "line", x1: 44, y1: 30, x2: 44, y2: 70 },
      { id: "fl5", kind: "line", x1: 56, y1: 30, x2: 56, y2: 70 },
      { id: "fl6", kind: "line", x1: 62, y1: 30, x2: 62, y2: 70 }
    ]
  },
  {
    id: "cap",
    name: "Cap / blind",
    category: "fitting",
    builtIn: true,
    ports: [{ id: "left", name: "Line", x: 0, y: 50, direction: "bidir", required: true }],
    primitives: [
      { id: "c1", kind: "line", x1: 0, y1: 50, x2: 55, y2: 50 },
      { id: "c2", kind: "line", x1: 55, y1: 28, x2: 55, y2: 72 },
      { id: "c3", kind: "line", x1: 55, y1: 28, x2: 72, y2: 28 },
      { id: "c4", kind: "line", x1: 55, y1: 72, x2: 72, y2: 72 }
    ]
  },
  {
    id: "sensor",
    name: "Instrument",
    category: "instrument",
    builtIn: true,
    ports: B,
    primitives: [
      { id: "s1", kind: "circle", cx: 50, cy: 42, r: 30 },
      { id: "s2", kind: "line", x1: 50, y1: 72, x2: 50, y2: 100 },
      { id: "s3", kind: "line", x1: 31, y1: 42, x2: 69, y2: 42 }
    ]
  },
  {
    id: "pt",
    name: "PT — Pressure",
    category: "instrument",
    builtIn: true,
    ports: B,
    primitives: [
      { id: "pt1", kind: "circle", cx: 50, cy: 42, r: 30 },
      { id: "pt2", kind: "line", x1: 50, y1: 72, x2: 50, y2: 100 }
    ]
  },
  {
    id: "tt",
    name: "TT — Temperature",
    category: "instrument",
    builtIn: true,
    ports: B,
    primitives: [
      { id: "tt1", kind: "circle", cx: 50, cy: 42, r: 30 },
      { id: "tt2", kind: "line", x1: 50, y1: 72, x2: 50, y2: 100 }
    ]
  },
  {
    id: "ft",
    name: "FT — Flow",
    category: "instrument",
    builtIn: true,
    ports: B,
    primitives: [
      { id: "ft1", kind: "circle", cx: 50, cy: 42, r: 30 },
      { id: "ft2", kind: "line", x1: 50, y1: 72, x2: 50, y2: 100 }
    ]
  },
  {
    id: "junction",
    name: "Junction",
    category: "fitting",
    builtIn: true,
    ports: [{ id: "center", name: "Center", x: 50, y: 50, direction: "bidir", required: false }],
    primitives: [{ id: "j1", kind: "circle", cx: 50, cy: 50, r: 8 }]
  },
  {
    id: "off_page_from",
    name: "Off-page (from)",
    category: "connector",
    builtIn: true,
    ports: [{ id: "left", name: "Process", x: 0, y: 50, direction: "bidir", required: true }],
    primitives: [
      { id: "opf1", kind: "line", x1: 0, y1: 50, x2: 55, y2: 50 },
      { id: "opf2", kind: "polyline", points: [
        { x: 55, y: 22 },
        { x: 92, y: 50 },
        { x: 55, y: 78 },
        { x: 55, y: 22 }
      ] }
    ]
  },
  {
    id: "off_page_to",
    name: "Off-page (to)",
    category: "connector",
    builtIn: true,
    ports: [{ id: "right", name: "Process", x: 100, y: 50, direction: "bidir", required: true }],
    primitives: [
      { id: "opt1", kind: "line", x1: 45, y1: 50, x2: 100, y2: 50 },
      { id: "opt2", kind: "polyline", points: [
        { x: 45, y: 22 },
        { x: 8, y: 50 },
        { x: 45, y: 78 },
        { x: 45, y: 22 }
      ] }
    ]
  }
];

/** Instrument bubble letter overlay — rendered in UI from symbol id. */
export const INSTRUMENT_LETTERS: Record<string, string> = {
  sensor: "I",
  pt: "PT",
  tt: "TT",
  ft: "FT"
};
