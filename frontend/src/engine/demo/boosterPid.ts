/**
 * Demo drawing: fluid systems of a methane / oxygen super-heavy booster with 33
 * full-flow staged-combustion engines, on seven A0 sheets. It exists to show
 * how large a drawing the tool carries: about 4,600 items, 186 off-page
 * connector pairs, and every engine drawn out rather than "typical".
 *
 * It is an illustration put together from public descriptions of the vehicle
 * and its engines. Tags, line numbers, sizes, pressures, and the exact
 * arrangement are invented; it is not design data of any real vehicle.
 *
 * Seeded as its own project (`backend/app/demo/booster_pid.json`, regenerated
 * by the test next to this file with UPDATE_DEMO_PID=1).
 */
import { createEmptyDocument, type EquipmentItem, type Point, type SchematicDocument, type Side, type SymbolItem } from "../types";
import { at, Builder, ORIENT, type Dir, type LineData, type Step } from "./testStandPid";

export type BoosterSheet = {
  title: string;
  /** Catalog part number per document item id (none assigned yet). */
  parts: Record<string, string>;
  document: SchematicDocument;
};

export type BoosterDemo = {
  project: { name: string; owner: string; description: string };
  number: string;
  title: string;
  size: "A0";
  system: { name: string; fluid: string; description: string };
  notes: string[];
  lineClasses: Array<{ name: string; description: string; material: string; rating: string; wall: string; sizes: string[] }>;
  sheets: BoosterSheet[];
};

export const ENGINE_COUNT = 33;
/** Engines 1-13 gimbal and relight (3 centre, 10 inner ring); 14-33 are the fixed outer ring. */
export const INNER_ENGINES = 13;

const OPPOSITE: Record<Dir, Dir> = { E: "W", W: "E", N: "S", S: "N" };
const pad = (value: number): string => String(value).padStart(2, "0");

const line = (number: string, service: string, size: string, lineClass: string, designPressure: string): LineData => ({ number, service, size, lineClass, designPressure });

type NozzleSpec = { id: string; x: number; y: number; side: Side };

/** Equipment boundary with nozzles; returns the nozzles in sheet coordinates. */
function box(b: Builder, spec: { tag: string; name: string; x: number; y: number; w: number; h: number; nozzles: NozzleSpec[]; dashed?: boolean; caption?: string[] }): Record<string, Point> {
  const item: EquipmentItem = {
    id: spec.tag.toLowerCase(),
    kind: "equipment",
    layer: "equipment",
    position: at(spec.x, spec.y),
    size: { width: spec.w, height: spec.h },
    tag: spec.tag,
    name: spec.name,
    boundary: spec.dashed ? "dashed" : "solid",
    nozzles: spec.nozzles,
    fields: {}
  };
  b.items.push(item);
  (spec.caption ?? []).forEach((text, index, all) => b.label(text, at(spec.x + spec.w / 2, spec.y + spec.h / 2 + 1 + (index - (all.length - 1) / 2) * 3.5), { size: 2.5, anchor: "middle" }));
  return Object.fromEntries(spec.nozzles.map((nozzle) => [nozzle.id, at(spec.x + nozzle.x, spec.y + nozzle.y)]));
}

/** Off-page connector that a flow in direction `flow` starts from. */
function source(b: Builder, start: Point, flow: Dir, ref: string, label: string): Point {
  b.place({ key: "off_page_connector", ref, label }, "in", start, ORIENT[OPPOSITE[flow]]);
  return start;
}

const sink = (ref: string, label: string): Step => ({ key: "off_page_connector", ref, label });

/** Ground-side interface flag that a flow in direction `flow` starts from. */
function ground(b: Builder, start: Point, flow: Dir, label: string): Point {
  b.place({ key: "terminator_in", label }, "out", start, ORIENT[flow]);
  return start;
}

/** Relief valve on a short riser above `tee`, discharging sideways to a vent. */
function reliefUp(b: Builder, tee: Point, data: LineData, tag: string, ventTag: string, side: "E" | "W" = "E", key = "relief_valve"): void {
  const inlet = at(tee.x, tee.y - 10);
  b.line([tee, inlet], data);
  const relief = b.place({ key, tag }, "in", inlet, side === "W" ? { rotation: 270 } : { rotation: 90, mirror: true });
  b.chain(relief.vent, side, { ...data, number: `${data.number}V` }, [10, { key: "vent_atmosphere", tag: ventTag }]);
}

function signalPort(b: Builder, tag: string): Point {
  const item = b.items.find((entry) => entry.id === tag.toLowerCase()) as SymbolItem;
  return b.registry.portsOf(item).find((port) => port.id === "signal")!.position;
}

/** Signal route through the given corners, dropping repeated points. */
function wire(b: Builder, points: Point[]): void {
  const path = points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
  if (path.length > 1) b.signal(path);
}

/** A row of evenly spaced nozzles along one edge of a manifold. */
const row = (prefix: string, count: number, first: number, pitch: number, y: number, side: Side): NozzleSpec[] =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index + 1}`, x: first + index * pitch, y, side }));

function finish(b: Builder, title: string): BoosterSheet {
  const document = createEmptyDocument({ size: "A0", orientation: "landscape", frame: { kind: "basic", template: "fsdp-standard", columns: 16, rows: 12, margin: 10 } });
  document.items = b.items;
  document.meta.title = title;
  return { title, parts: b.parts, document };
}

/* ---------- line data ---------- */

const CRYO = "CRYO-304L";
const HOT = "HOTGAS-INC";
const ENG = "ENG-HP";
const HP = "HP-COPV";
const MP = "MP-316";

/* ---------- sheet 1: tanks, fill and drain, vent, pressurization ---------- */

type TankSide = {
  fluid: "LOX" | "CH4";
  gas: "GOX" | "GCH4";
  /** Thousands and hundreds digits of the tags on this tank. */
  series: number;
  y: number;
  h: number;
  name: string;
  caption: string[];
};

function tankSystems(b: Builder, side: TankSide): Record<string, Point> {
  const { fluid, gas, series, y, h } = side;
  const n = (offset: number) => String(series * 100 + offset);
  const X = 420;
  const W = 280;
  const liquid = (number: number, size: string) => line(`${fluid}-${n(number)}`, fluid, size, CRYO, "9 bar");
  const ullage = (number: number, size: string) => line(`${gas}-${n(number)}`, gas, size, CRYO, "9 bar");

  const tank = box(b, {
    tag: `TK-${n(1)}`,
    name: side.name,
    x: X,
    y,
    w: W,
    h,
    caption: side.caption,
    nozzles: [
      { id: "pt1", x: 140, y: 0, side: "top" },
      { id: "pt2", x: 165, y: 0, side: "top" },
      { id: "pt3", x: 190, y: 0, side: "top" },
      { id: "te", x: 215, y: 0, side: "top" },
      { id: "vent", x: W, y: 15, side: "right" },
      { id: "press", x: W, y: 50, side: "right" },
      { id: "rcs", x: W, y: 85, side: "right" },
      { id: "prepress", x: 0, y: 50, side: "left" },
      { id: "lt", x: 0, y: h - 30, side: "left" },
      { id: "te2", x: 0, y: h - 15, side: "left" },
      { id: "fill", x: 40, y: h, side: "bottom" },
      { id: "outlet", x: fluid === "LOX" ? 200 : 100, y: h, side: "bottom" }
    ]
  });

  // Triplex ullage pressure, ullage temperature, level, and bulk temperature.
  b.bubble(tank.pt1, "N", `PT-${n(1)}`);
  b.bubble(tank.pt2, "N", `PT-${n(2)}`);
  b.bubble(tank.pt3, "N", `PT-${n(3)}`);
  b.bubble(tank.te, "N", `TE-${n(4)}`);
  b.bubble(tank.lt, "W", `LT-${n(5)}`);
  b.bubble(tank.te2, "W", `TE-${n(6)}`, { stem: 22.5 });

  // Vent: two relief valves and the commanded vent valve.
  const vent = ullage(11, '10"');
  b.chain(tank.vent, "E", vent, [
    15,
    { mark: "psv1" },
    60,
    { mark: "psv2" },
    { run: 45, label: true },
    { key: "pneumatic_valve", tag: `PV-${n(11)}` },
    { data: ullage(12, '10"') },
    10,
    { key: "silencer", tag: `SIL-${n(12)}` },
    5,
    { key: "vent_atmosphere", tag: `VENT-${n(13)}` }
  ]);
  reliefUp(b, b.marks.psv1, vent, `PSV-${n(14)}`, `VENT-${n(15)}`, "E", "safety_valve");
  reliefUp(b, b.marks.psv2, vent, `PSV-${n(16)}`, `VENT-${n(17)}`, "E", "safety_valve");

  // Autogenous pressurization from the engines: redundant control valves, check valve, diffuser.
  const press = ullage(21, '6"');
  const pressIn = source(b, at(1040, tank.press.y), "W", `${gas}-PRESS`, `${gas} PRESS`);
  b.chain(pressIn, "W", press, [
    15,
    { mark: "a" },
    { key: "pneumatic_valve", tag: `PV-${n(21)}` },
    { mark: "b" },
    15,
    { key: "check_valve", tag: `CV-${n(23)}` },
    15,
    { mark: "pt" },
    { run: 60, label: true },
    { mark: "te" },
    { until: tank.press.x }
  ]);
  b.chain(b.marks.a, "S", press, [20, { turn: "W" }, { key: "pneumatic_valve", tag: `PV-${n(22)}` }, { turn: "N" }, 20]);
  b.bubble(b.marks.pt, "N", `PT-${n(24)}`);
  b.bubble(b.marks.te, "N", `TE-${n(25)}`);

  // Ullage gas to the attitude-control thrusters.
  b.chain(tank.rcs, "E", ullage(31, '4"'), [20, { key: "ball_valve", tag: `XV-${n(31)}`, actuator: "act_piston" }, { run: 40, label: true }, sink(`${gas}-RCS`, `${gas} TO THRUSTERS`)]);

  // Ground pre-pressurization through the booster quick disconnect.
  const prepress = line(`${gas}-${n(41)}`, gas, '4"', CRYO, "9 bar");
  b.chain(ground(b, at(60, tank.prepress.y), "E", `GSE ${gas} PRE-PRESS`), "E", prepress, [
    5,
    { key: "quick_disconnect", tag: `QD-${n(41)}` },
    10,
    { key: "solenoid_valve", tag: `SV-${n(42)}` },
    10,
    { key: "check_valve", tag: `CV-${n(43)}` },
    { run: 60, label: true },
    { until: tank.prepress.x }
  ]);

  // Fill and drain through the booster quick disconnect.
  const fill = liquid(51, '12"');
  const fillY = y + h + 50;
  b.chain(ground(b, at(60, fillY), "E", `GSE ${fluid} FILL / DRAIN`), "E", fill, [
    5,
    { key: "quick_disconnect", tag: `QD-${n(51)}` },
    15,
    { mark: "trv" },
    25,
    { key: "pneumatic_valve", tag: `PV-${n(52)}` },
    10,
    { key: "strainer", tag: `STR-${n(53)}` },
    15,
    { mark: "pt" },
    15,
    { mark: "te" },
    { run: 60, label: true },
    { until: tank.fill.x },
    { turn: "N" },
    { until: tank.fill.y }
  ]);
  reliefUp(b, b.marks.trv, fill, `TRV-${n(54)}`, `VENT-${n(55)}`);
  b.bubble(b.marks.pt, "S", `PT-${n(56)}`);
  b.bubble(b.marks.te, "S", `TE-${n(57)}`);
  return tank;
}

function sheetTanks(): BoosterSheet {
  const b = new Builder("s1-");
  const ch4 = tankSystems(b, { fluid: "CH4", gas: "GCH4", series: 42, y: 110, h: 140, name: "CH4 MAIN TANK", caption: ["LIQUID METHANE", "FORWARD TANK", "SUBCOOLED · 6 bar ULLAGE"] });
  const lox = tankSystems(b, { fluid: "LOX", gas: "GOX", series: 41, y: 400, h: 180, name: "LOX MAIN TANK", caption: ["LIQUID OXYGEN", "AFT TANK", "SUBCOOLED · 6 bar ULLAGE"] });

  // Methane downcomer: from the forward tank straight down through the oxygen tank.
  const downcomer = line("CH4-4261", "CH4", '24"', CRYO, "9 bar");
  b.chain(ch4.outlet, "S", downcomer, [{ until: 625 }, { mark: "te" }, 15, { mark: "pt" }, { run: 50, label: true }, 10, sink("CH4-DOWNCOMER", "CH4 TO ENGINES")]);
  b.bubble(b.marks.te, "W", "TE-4262");
  b.bubble(b.marks.pt, "W", "PT-4263");
  b.label("CH4 DOWNCOMER", at(524, 330), { size: 2.5 });
  b.label("(THROUGH LOX TANK)", at(524, 334), { size: 2.5 });

  // Oxygen outlet to the outer ring, with a branch that fills the landing tank.
  const main = line("LOX-4161", "LOX", '30"', CRYO, "9 bar");
  b.chain(lox.outlet, "S", main, [15, { mark: "land" }, 30, { mark: "pt" }, 15, { mark: "te" }, { run: 50, label: true }, 10, sink("LOX-MAIN", "LOX TO OUTER RING")]);
  b.bubble(b.marks.pt, "W", "PT-4162");
  b.bubble(b.marks.te, "W", "TE-4163");
  const landFeed = line("LOX-4171", "LOX", '12"', CRYO, "9 bar");
  const landIn = b.chain(b.marks.land, "E", main, [60, { key: "ball_valve", tag: "XV-4171", actuator: "act_piston" }, { data: landFeed }, 30]);
  const landing = box(b, {
    tag: "TK-4102",
    name: "LOX LANDING TANK",
    x: landIn.x,
    y: landIn.y - 15,
    w: 110,
    h: 70,
    caption: ["BOOSTBACK AND", "LANDING BURN LOX"],
    nozzles: [
      { id: "in", x: 0, y: 15, side: "left" },
      { id: "pt", x: 30, y: 0, side: "top" },
      { id: "equal", x: 80, y: 0, side: "top" },
      { id: "lt", x: 110, y: 20, side: "right" },
      { id: "te", x: 110, y: 50, side: "right" },
      { id: "out", x: 55, y: 70, side: "bottom" }
    ]
  });
  b.bubble(landing.pt, "N", "PT-4172");
  b.bubble(landing.lt, "E", "LT-4173");
  b.bubble(landing.te, "E", "TE-4174");
  // Landing tank vent.
  b.chain(landing.equal, "N", line("GOX-4175", "GOX", '2"', CRYO, "9 bar"), [15, { key: "pneumatic_valve", tag: "PV-4175", flip: true }, 10, { turn: "E" }, 60, { key: "vent_atmosphere", tag: "VENT-4176" }]);
  b.chain(landing.out, "S", line("LOX-4181", "LOX", '20"', CRYO, "9 bar"), [15, { mark: "pt" }, { run: 40, label: true }, 10, sink("LOX-LAND", "LOX TO INNER 13")]);
  b.bubble(b.marks.pt, "E", "PT-4182");

  b.label("METHANE TANK, FILL / DRAIN, VENT, AND PRESSURIZATION", at(150, 70), { size: 5 });
  b.label("OXYGEN TANK, LANDING TANK, FILL / DRAIN, VENT, AND PRESSURIZATION", at(150, 365), { size: 5 });
  b.label("BOOSTER QUICK DISCONNECT (GROUND SIDE)", at(30, 135), { size: 3 });
  return finish(b, "Tanks, fill and drain, vent, and pressurization");
}

/* ---------- sheet 2: propellant distribution to the engines ---------- */

const PITCH = 32.5;

function sheetDistribution(): BoosterSheet {
  const b = new Builder("s2-");
  const X0 = 57.5;
  const xOf = (engine: number) => X0 + (engine - 1) * PITCH;

  const prevalves = (nozzles: Record<string, Point>, prefix: string, first: number, count: number, fluid: "LOX" | "CH4", series: number) => {
    for (let index = 0; index < count; index += 1) {
      const engine = first + index;
      const data = line(`${fluid}-${series}${pad(engine)}`, fluid, fluid === "LOX" ? '8"' : '6"', CRYO, "12 bar");
      b.chain(nozzles[`${prefix}${index + 1}`], "S", data, [
        7.5,
        { key: "butterfly_valve", tag: `XV-${series}${pad(engine)}`, actuator: "act_piston" },
        5,
        { mark: "te" },
        12.5,
        sink(`${fluid}-E${pad(engine)}`, `E${pad(engine)}`)
      ]);
      b.bubble(b.marks.te, "E", `TE-${series + 2}${pad(engine)}`, { stem: 5 });
    }
  };

  // Oxygen: the inner 13 engines draw from the landing tank manifold, the outer 20 from the main tank.
  const innerW = (INNER_ENGINES - 1) * PITCH + 30;
  const inner = box(b, {
    tag: "MAN-5101",
    name: "LOX INNER MANIFOLD (E01-E13)",
    x: X0 - 15,
    y: 150,
    w: innerW,
    h: 15,
    nozzles: [
      { id: "feed", x: 100, y: 0, side: "top" },
      { id: "pt", x: 160, y: 0, side: "top" },
      { id: "te", x: 185, y: 0, side: "top" },
      { id: "psv", x: 260, y: 0, side: "top" },
      { id: "cross", x: innerW - 15, y: 0, side: "top" },
      ...row("e", INNER_ENGINES, 15, PITCH, 15, "bottom")
    ]
  });
  const outerX = xOf(INNER_ENGINES + 1) - 15;
  const outerW = (ENGINE_COUNT - INNER_ENGINES - 1) * PITCH + 30;
  const outer = box(b, {
    tag: "MAN-5102",
    name: "LOX OUTER RING MANIFOLD (E14-E33)",
    x: outerX,
    y: 150,
    w: outerW,
    h: 15,
    nozzles: [
      { id: "cross", x: 15, y: 0, side: "top" },
      { id: "feed", x: 320, y: 0, side: "top" },
      { id: "pt", x: 380, y: 0, side: "top" },
      { id: "te", x: 405, y: 0, side: "top" },
      { id: "psv", x: 480, y: 0, side: "top" },
      ...row("e", ENGINE_COUNT - INNER_ENGINES, 15, PITCH, 15, "bottom")
    ]
  });
  const innerFeed = line("LOX-5101", "LOX", '20"', CRYO, "12 bar");
  const outerFeed = line("LOX-5102", "LOX", '30"', CRYO, "12 bar");
  b.chain(source(b, at(inner.feed.x, 100), "S", "LOX-LAND", "LOX FROM LANDING TANK"), "S", innerFeed, [{ until: inner.feed.y }]);
  b.chain(source(b, at(outer.feed.x, 100), "S", "LOX-MAIN", "LOX FROM MAIN TANK"), "S", outerFeed, [{ until: outer.feed.y }]);
  // Crossfeed, so the inner engines run from the main tank during ascent.
  b.chain(inner.cross, "N", innerFeed, [20, { turn: "E" }, 5, { key: "butterfly_valve", tag: "XV-5103", actuator: "act_piston" }, { until: outer.cross.x }, { turn: "S" }, { until: outer.cross.y }]);
  b.label("CROSSFEED", at(inner.cross.x + 2.5, 118), { size: 2.5 });
  for (const [manifold, series] of [[inner, 51] as const, [outer, 52] as const]) {
    b.bubble(manifold.pt, "N", `PT-${series}04`);
    b.bubble(manifold.te, "N", `TE-${series}05`);
    reliefUp(b, manifold.psv, series === 51 ? innerFeed : outerFeed, `TRV-${series}06`, `VENT-${series}07`);
  }
  prevalves(inner, "e", 1, INNER_ENGINES, "LOX", 53);
  prevalves(outer, "e", INNER_ENGINES + 1, ENGINE_COUNT - INNER_ENGINES, "LOX", 53);

  // Methane: one manifold at the foot of the downcomer.
  const fuelW = (ENGINE_COUNT - 1) * PITCH + 30;
  const fuel = box(b, {
    tag: "MAN-5201",
    name: "CH4 DISTRIBUTION MANIFOLD (E01-E33)",
    x: X0 - 15,
    y: 440,
    w: fuelW,
    h: 15,
    nozzles: [
      { id: "feed", x: 535, y: 0, side: "top" },
      { id: "pt", x: 600, y: 0, side: "top" },
      { id: "te", x: 625, y: 0, side: "top" },
      { id: "psv", x: 700, y: 0, side: "top" },
      { id: "psv2", x: 300, y: 0, side: "top" },
      ...row("e", ENGINE_COUNT, 15, PITCH, 15, "bottom")
    ]
  });
  const fuelFeed = line("CH4-5201", "CH4", '24"', CRYO, "12 bar");
  b.chain(source(b, at(fuel.feed.x, 390), "S", "CH4-DOWNCOMER", "CH4 FROM DOWNCOMER"), "S", fuelFeed, [{ until: fuel.feed.y }]);
  b.bubble(fuel.pt, "N", "PT-5904");
  b.bubble(fuel.te, "N", "TE-5905");
  reliefUp(b, fuel.psv, fuelFeed, "TRV-5906", "VENT-5907");
  reliefUp(b, fuel.psv2, fuelFeed, "TRV-5908", "VENT-5909");
  prevalves(fuel, "e", 1, ENGINE_COUNT, "CH4", 54);

  b.label("OXYGEN DISTRIBUTION — MANIFOLDS AND ENGINE PREVALVES", at(150, 70), { size: 5 });
  b.label("METHANE DISTRIBUTION — MANIFOLD AND ENGINE PREVALVES", at(150, 365), { size: 5 });
  const mapY = 620;
  b.label("ENGINE MAP", at(60, mapY), { size: 4 });
  [
    "E01-E03   CENTRE          GIMBALLED · RELIGHT · ON-BOARD SPIN START        SHEET 5",
    "E04-E13   INNER RING      GIMBALLED · RELIGHT · ON-BOARD SPIN START        SHEETS 5-6",
    "E14-E33   OUTER RING      FIXED · GROUND SPIN START THROUGH ENGINE QD      SHEETS 6-7",
    "",
    "PREVALVE XV-53nn / XV-54nn AND ITS TEMPERATURE ELEMENT SERVE ENGINE nn.",
    "GIMBALLED ENGINES CARRY FLEXIBLE INLET JOINTS (EJ) ON THE ENGINE SHEETS."
  ].forEach((text, index) => b.label(text, at(60, mapY + 10 + index * 6), { size: 3 }));
  return finish(b, "Propellant distribution to the engines");
}

/* ---------- sheet 3: autogenous pressurization collection and purge distribution ---------- */

function sheetCollection(): BoosterSheet {
  const b = new Builder("s3-");
  const X0 = 50;
  const width = (ENGINE_COUNT - 1) * PITCH + 30;

  const collect = (gas: "GOX" | "GCH4", series: number, y: number) => {
    const manifold = box(b, {
      tag: `MAN-${series}01`,
      name: `${gas} PRESSURIZATION COLLECTION MANIFOLD`,
      x: X0 - 15,
      y,
      w: width,
      h: 15,
      nozzles: [...row("e", ENGINE_COUNT, 15, PITCH, 0, "top"), { id: "out", x: width / 2 + 2.5, y: 15, side: "bottom" }, { id: "pt", x: 200, y: 15, side: "bottom" }, { id: "te", x: 225, y: 15, side: "bottom" }, { id: "psv", x: 760, y: 15, side: "bottom" }]
    });
    for (let engine = 1; engine <= ENGINE_COUNT; engine += 1) {
      const tap = manifold[`e${engine}`];
      const data = line(`${gas}-${series}${pad(engine)}`, gas, '2"', HOT, "400 bar");
      b.chain(source(b, at(tap.x, y - 40), "S", `${gas}-E${pad(engine)}`, `E${pad(engine)}`), "S", data, [10, { key: "check_valve", tag: `CV-${series}${pad(engine)}` }, { until: tap.y }]);
    }
    const header = line(`${gas}-${series}50`, gas, '6"', HOT, "400 bar");
    b.chain(manifold.out, "S", header, [
      10,
      { key: "filter", tag: `F-${series}51` },
      10,
      { key: "regulator", tag: `PCV-${series}52` },
      { data: line(`${gas}-${series}53`, gas, '6"', CRYO, "9 bar") },
      10,
      { mark: "pt" },
      15,
      sink(`${gas}-PRESS`, `${gas} TO TANK`)
    ]);
    b.bubble(b.marks.pt, "E", `PT-${series}54`);
    b.bubble(manifold.pt, "S", `PT-${series}55`);
    b.bubble(manifold.te, "S", `TE-${series}56`);
    // Relief below the manifold, discharging sideways.
    const inlet = at(manifold.psv.x, manifold.psv.y + 10);
    b.line([manifold.psv, inlet], header);
    const relief = b.place({ key: "safety_valve", tag: `PSV-${series}57` }, "in", inlet, { rotation: 90 });
    b.chain(relief.vent, "E", { ...header, number: `${header.number}V` }, [10, { key: "vent_atmosphere", tag: `VENT-${series}58` }]);
  };
  collect("GOX", 61, 140);
  collect("GCH4", 62, 380);

  // Purge nitrogen to every engine.
  const purge = box(b, {
    tag: "MAN-7101",
    name: "GN2 ENGINE PURGE MANIFOLD",
    x: X0 - 15,
    y: 620,
    w: width,
    h: 15,
    nozzles: [{ id: "feed", x: width / 2 + 2.5, y: 0, side: "top" }, { id: "pt", x: 200, y: 0, side: "top" }, ...row("e", ENGINE_COUNT, 15, PITCH, 15, "bottom")]
  });
  const purgeFeed = line("GN2-7100", "GN2", '2"', MP, "60 bar");
  b.chain(source(b, at(purge.feed.x, 585), "S", "GN2-PURGE-HDR", "GN2 PURGE SUPPLY"), "S", purgeFeed, [{ until: purge.feed.y }]);
  b.bubble(purge.pt, "N", "PT-7102");
  for (let engine = 1; engine <= ENGINE_COUNT; engine += 1) {
    b.chain(purge[`e${engine}`], "S", line(`GN2-71${pad(engine)}`, "GN2", '1/2"', MP, "60 bar"), [5, { key: "orifice", tag: `FO-71${pad(engine)}` }, 10, sink(`PRG-E${pad(engine)}`, `E${pad(engine)}`)]);
  }

  b.label("OXYGEN-RICH PRESSURANT FROM THE ENGINES — COLLECTION, FILTRATION, LETDOWN", at(150, 70), { size: 5 });
  b.label("METHANE PRESSURANT FROM THE ENGINES — COLLECTION, FILTRATION, LETDOWN", at(150, 320), { size: 5 });
  b.label("ENGINE PURGE DISTRIBUTION", at(150, 570), { size: 5 });
  return finish(b, "Autogenous pressurization collection and engine purge");
}

/* ---------- sheet 4: stored gas, thrusters, fire suppression ---------- */

function sheetGas(): BoosterSheet {
  const b = new Builder("s4-");

  /** Charge line, check valve, filter, and a bank of bottles on a header; ends past the isolation valve. */
  const bank = (y: number, service: string, series: number, label: string, bottles: number): Point => {
    const hp = line(`${service}-${series}01`, service, '1"', HP, "420 bar");
    const steps: Step[] = [5, { key: "quick_disconnect", tag: `QD-${series}01` }, 5, { key: "check_valve", tag: `CV-${series}02` }, 5, { key: "filter", tag: `F-${series}03` }, 10];
    for (let index = 1; index <= bottles; index += 1) steps.push({ mark: `k${index}` }, 25);
    steps.push({ mark: "pt" }, 25, { mark: "psv" }, 30, { key: "ball_valve", tag: `XV-${series}20`, actuator: "act_piston" }, 10);
    const end = b.chain(ground(b, at(60, y), "E", label), "E", hp, steps);
    for (let index = 1; index <= bottles; index += 1) {
      const tee = b.marks[`k${index}`];
      b.line([tee, at(tee.x, tee.y + 10)], hp);
      b.place({ key: "gas_bottle", tag: `K-${series}${pad(index + 3)}` }, "out", at(tee.x, tee.y + 10));
    }
    b.bubble(b.marks.pt, "N", `PT-${series}18`);
    reliefUp(b, b.marks.psv, hp, `PSV-${series}19`, `VENT-${series}21`);
    return end;
  };

  // Nitrogen: purge supply and valve actuation pneumatics.
  const n2 = bank(150, "GN2", 44, "GSE GN2 CHARGE", 8);
  const purge = line("GN2-4430", "GN2", '2"', MP, "60 bar");
  b.chain(n2, "E", line("GN2-4401", "GN2", '1"', HP, "420 bar"), [
    10,
    { key: "regulator", tag: "PCV-4431" },
    { data: purge },
    15,
    { mark: "pt" },
    25,
    { mark: "psv" },
    30,
    { mark: "pneu" },
    { run: 50, label: true },
    10,
    sink("GN2-PURGE-HDR", "GN2 TO ENGINE PURGE")
  ]);
  b.bubble(b.marks.pt, "N", "PT-4432");
  reliefUp(b, b.marks.psv, purge, "PSV-4433", "VENT-4434");
  b.chain(b.marks.pneu, "S", purge, [15, { key: "regulator", tag: "PCV-4435" }, { data: line("GN2-4436", "GN2", '1/2"', MP, "10 bar") }, 10, { key: "filter", tag: "F-4437" }, 10, { turn: "E" }, 15, { key: "terminator", label: "VALVE PNEUMATICS", from: "in", to: "in" }]);

  // Spin-start gas for the engines that relight in flight.
  const spinEnd = bank(360, "GN2", 45, "GSE SPIN-START GAS CHARGE", 8);
  const spin = box(b, {
    tag: "MAN-7201",
    name: "SPIN-START MANIFOLD (E01-E13)",
    x: spinEnd.x,
    y: spinEnd.y - 7.5,
    w: (INNER_ENGINES - 1) * PITCH + 30,
    h: 15,
    nozzles: [{ id: "in", x: 0, y: 7.5, side: "left" }, { id: "pt", x: 100, y: 0, side: "top" }, ...row("e", INNER_ENGINES, 15, PITCH, 15, "bottom")]
  });
  b.bubble(spin.pt, "N", "PT-7202");
  for (let engine = 1; engine <= INNER_ENGINES; engine += 1) {
    b.chain(spin[`e${engine}`], "S", line(`GN2-72${pad(engine)}`, "GN2", '1"', HP, "420 bar"), [5, { key: "orifice", tag: `FO-72${pad(engine)}` }, 10, sink(`SPIN-E${pad(engine)}`, `E${pad(engine)}`)]);
  }

  // Ullage gas thrusters for attitude control after staging.
  const thrusters = (x: number, gas: "GOX" | "GCH4", series: number) => {
    const feed = line(`${gas}-${series}01`, gas, '4"', CRYO, "9 bar");
    const end = b.chain(source(b, at(x, 580), "E", `${gas}-RCS`, `${gas} FROM TANK ULLAGE`), "E", feed, [10, { key: "filter", tag: `F-${series}02` }, 15, { mark: "pt" }, 15]);
    b.bubble(b.marks.pt, "N", `PT-${series}03`);
    const manifold = box(b, {
      tag: `MAN-${series}04`,
      name: `${gas} THRUSTER MANIFOLD`,
      x: end.x,
      y: end.y - 7.5,
      w: 3 * 40 + 30,
      h: 15,
      nozzles: [{ id: "in", x: 0, y: 7.5, side: "left" }, ...row("t", 4, 15, 40, 15, "bottom")]
    });
    for (let index = 1; index <= 4; index += 1) {
      b.chain(manifold[`t${index}`], "S", line(`${gas}-${series}1${index}`, gas, '3"', CRYO, "9 bar"), [10, { key: "solenoid_valve", tag: `SV-${series}1${index}` }, 10, { key: "spray_nozzle", tag: `SN-${series}2${index}` }]);
    }
  };
  thrusters(60, "GOX", 46);
  thrusters(420, "GCH4", 47);

  // Engine bay fire suppression.
  const co2 = line("CO2-4801", "CO2", '2"', HP, "150 bar");
  const first = b.place({ key: "gas_bottle", tag: "K-4801" }, "out", at(700, 160));
  b.line([first.out, at(700, 150)], co2);
  const co2End = b.chain(at(700, 150), "E", co2, [25, { mark: "k2" }, 25, { mark: "k3" }, 25, { mark: "k4" }, 25, { mark: "pt" }, 25, { mark: "psv" }, 30, { key: "solenoid_valve", tag: "SV-4810" }, 15]);
  for (const index of [2, 3, 4]) {
    const tee = b.marks[`k${index}`];
    b.line([tee, at(tee.x, tee.y + 10)], co2);
    b.place({ key: "gas_bottle", tag: `K-480${index}` }, "out", at(tee.x, tee.y + 10));
  }
  b.bubble(b.marks.pt, "N", "PT-4805");
  b.chain(b.marks.psv, "N", co2, [5, { key: "rupture_disc", tag: "PSE-4806" }, 5, { key: "vent_atmosphere", tag: "VENT-4807" }]);
  const bay = box(b, {
    tag: "MAN-4811",
    name: "ENGINE BAY CO2 MANIFOLD",
    x: co2End.x,
    y: co2End.y - 7.5,
    w: 5 * 30 + 30,
    h: 15,
    nozzles: [{ id: "in", x: 0, y: 7.5, side: "left" }, ...row("n", 6, 15, 30, 15, "bottom")]
  });
  for (let index = 1; index <= 6; index += 1) {
    b.chain(bay[`n${index}`], "S", line(`CO2-481${index}`, "CO2", '1"', MP, "150 bar"), [15, { key: "spray_nozzle", tag: `SN-482${index}` }]);
  }

  b.label("NITROGEN STORAGE — ENGINE PURGE AND VALVE PNEUMATICS", at(150, 95), { size: 5 });
  b.label("ENGINE BAY FIRE SUPPRESSION", at(700, 110), { size: 4 });
  b.label("SPIN-START GAS STORAGE AND DISTRIBUTION", at(150, 305), { size: 5 });
  b.label("ULLAGE GAS ATTITUDE-CONTROL THRUSTERS", at(150, 530), { size: 5 });
  return finish(b, "Stored gas, thrusters, and fire suppression");
}

/* ---------- sheets 5-7: engines ---------- */

/** Cell pitch; the engine frame is 285 x 259 mm. */
const ENGINE_W = 290;
const ENGINE_H = 265;
const ENGINES_PER_SHEET = 11;

/** One full-flow staged-combustion engine, drawn in a 290 x 265 mm cell with its top-left at (ox, oy). */
function engine(b: Builder, number: number, ox: number, oy: number): void {
  const p = (x: number, y: number) => at(ox + x, oy + y);
  const id = pad(number);
  const gimbal = number <= INNER_ENGINES;
  const T = (letters: string, sequence: number) => `${letters}-${id}${pad(sequence)}`;
  const L = (service: string, sequence: number, size: string, lineClass: string, pressure: string) => line(`${service}-E${id}-${pad(sequence)}`, service, size, lineClass, pressure);
  const ring = number <= 3 ? "CENTRE · GIMBALLED · RELIGHT" : gimbal ? "INNER RING · GIMBALLED · RELIGHT" : "OUTER RING · FIXED";

  b.items.push({ id: `e-${id}`, kind: "equipment", layer: "equipment", position: p(-5, -2.5), size: { width: ENGINE_W - 5, height: 259 }, tag: `E-${id}`, name: `FFSC ENGINE — ${ring}`, boundary: "dashed", nozzles: [], fields: {} });

  const inletJoint = (sequence: number): Step[] => (gimbal ? [5, { key: "expansion_joint", tag: T("EJ", sequence) }] : [25]);

  // Oxygen side: pump, main valve, oxygen-rich preburner, turbine, main injector.
  const loxIn = L("LOX", 1, '8"', CRYO, "12 bar");
  const loxHp = L("LOX", 2, '6"', ENG, "900 bar");
  b.chain(source(b, p(100, 30), "S", `LOX-E${id}`, "LOX"), "S", loxIn, [
    ...inletJoint(1),
    5,
    { mark: "in" },
    5,
    { key: "pump", tag: T("P", 1) },
    { data: loxHp },
    5,
    { mark: "pt" },
    7.5,
    { mark: "bleed" },
    12.5,
    { mark: "fpb" },
    5,
    { key: "ball_valve", tag: T("XV", 1), actuator: "act_rotary_motor" },
    { run: 30, label: true },
    { until: oy + 177.5 }
  ]);
  const lox = { ...b.marks };
  b.bubble(lox.in, "W", T("PT", 1));
  b.bubble(lox.in, "E", T("TE", 2));
  b.bubble(lox.pt, "E", T("PT", 3));
  const opb = box(b, {
    tag: T("OPB", 1),
    name: "",
    x: ox + 80,
    y: oy + 177.5,
    w: 40,
    h: 25,
    caption: ["OX-RICH", "PREBURNER"],
    nozzles: [
      { id: "lox", x: 20, y: 0, side: "top" },
      { id: "fuel", x: 40, y: 7.5, side: "right" },
      { id: "spin", x: 40, y: 17.5, side: "right" },
      { id: "pt", x: 0, y: 7.5, side: "left" },
      { id: "purge", x: 0, y: 17.5, side: "left" },
      { id: "out", x: 20, y: 25, side: "bottom" }
    ]
  });
  b.bubble(opb.pt, "W", T("PT", 4));
  const hotOx = L("GOX", 3, '8"', HOT, "800 bar");
  const oxTurbine = box(b, { tag: T("OT", 2), name: "", x: ox + 80, y: oy + 212.5, w: 40, h: 15, caption: ["OX TURBINE"], nozzles: [{ id: "in", x: 20, y: 0, side: "top" }, { id: "out", x: 20, y: 15, side: "bottom" }] });
  b.line([opb.out, oxTurbine.in], hotOx);
  b.chain(oxTurbine.out, "S", hotOx, [10, { mark: "gox" }, { until: oy + 247.5 }, { turn: "E" }, { until: ox + 117.5 }]);
  // Oxygen-rich turbine gas tapped for tank pressurization.
  b.chain(b.marks.gox, "W", hotOx, [5, { key: "orifice", tag: T("FO", 5) }, 5, { key: "check_valve", tag: T("CV", 6) }, { data: L("GOX", 4, '2"', HOT, "400 bar") }, 5, sink(`GOX-E${id}`, "GOX PRESS")]);
  // Chill-down bleed.
  b.chain(lox.bleed, "W", loxHp, [15, { key: "solenoid_valve", tag: T("SV", 7) }, { data: L("LOX", 5, '1"', CRYO, "12 bar") }, 10, { key: "vent_atmosphere", tag: T("VENT", 8) }]);
  // Oxygen to the fuel-rich preburner.
  b.chain(lox.fpb, "E", loxHp, [10, { key: "globe_valve", tag: T("XV", 9), actuator: "act_rotary_motor" }, { data: L("LOX", 6, '2"', ENG, "900 bar") }, { until: ox + 150 }, { turn: "S" }, { until: oy + 185 }, { turn: "E" }, { until: ox + 165 }]);

  // Methane side: pump, main valve, regenerative jacket, fuel-rich preburner, turbine, main injector.
  const ch4In = L("CH4", 11, '6"', CRYO, "12 bar");
  const ch4Hp = L("CH4", 12, '5"', ENG, "900 bar");
  const ch4Hot = L("CH4", 13, '5"', ENG, "800 bar");
  b.chain(source(b, p(185, 30), "S", `CH4-E${id}`, "CH4"), "S", ch4In, [
    ...inletJoint(11),
    5,
    { mark: "in" },
    5,
    { key: "pump", tag: T("P", 11) },
    { data: ch4Hp },
    5,
    { mark: "pt" },
    7.5,
    { mark: "bleed" },
    5,
    { key: "ball_valve", tag: T("XV", 12), actuator: "act_rotary_motor", flip: true },
    5,
    { key: "heat_exchanger", tag: T("HX", 13) },
    { data: ch4Hot },
    5,
    { mark: "te" },
    10,
    { mark: "opb" },
    5,
    { mark: "gch4" },
    { until: oy + 177.5 }
  ]);
  const ch4 = { ...b.marks };
  b.bubble(ch4.in, "W", T("PT", 14));
  b.bubble(ch4.in, "E", T("TE", 15));
  b.bubble(ch4.pt, "W", T("PT", 16));
  b.bubble(ch4.te, "E", T("TE", 17));
  b.label("REGEN JACKET", p(215, 138.5), { size: 2 });
  const fpb = box(b, {
    tag: T("FPB", 18),
    name: "",
    x: ox + 165,
    y: oy + 177.5,
    w: 40,
    h: 25,
    caption: ["FUEL-RICH", "PREBURNER"],
    nozzles: [
      { id: "ch4", x: 20, y: 0, side: "top" },
      { id: "lox", x: 0, y: 7.5, side: "left" },
      { id: "spin", x: 0, y: 17.5, side: "left" },
      { id: "pt", x: 40, y: 7.5, side: "right" },
      { id: "out", x: 20, y: 25, side: "bottom" }
    ]
  });
  b.bubble(fpb.pt, "E", T("PT", 19));
  const hotFuel = L("GCH4", 14, '8"', HOT, "800 bar");
  const fuelTurbine = box(b, { tag: T("FT", 20), name: "", x: ox + 165, y: oy + 212.5, w: 40, h: 15, caption: ["FUEL TURBINE"], nozzles: [{ id: "in", x: 20, y: 0, side: "top" }, { id: "out", x: 20, y: 15, side: "bottom" }] });
  b.line([fpb.out, fuelTurbine.in], hotFuel);
  b.chain(fuelTurbine.out, "S", hotFuel, [{ until: oy + 247.5 }, { turn: "W" }, { until: ox + 167.5 }]);
  // Warm methane from the jacket tapped for tank pressurization.
  b.chain(ch4.gch4, "E", ch4Hot, [5, { key: "orifice", tag: T("FO", 21) }, 5, { key: "check_valve", tag: T("CV", 22) }, { data: L("GCH4", 15, '2"', HOT, "400 bar") }, 5, sink(`GCH4-E${id}`, "GCH4 PRESS")]);
  b.chain(ch4.bleed, "E", ch4Hp, [15, { key: "solenoid_valve", tag: T("SV", 23) }, { data: L("CH4", 16, '1"', CRYO, "12 bar") }, 10, { key: "vent_atmosphere", tag: T("VENT", 24) }]);
  // Methane to the oxygen-rich preburner.
  b.chain(ch4.opb, "W", ch4Hot, [5, { key: "globe_valve", tag: T("XV", 25), actuator: "act_rotary_motor" }, { data: L("CH4", 17, '2"', ENG, "800 bar") }, { until: ox + 135 }, { turn: "S" }, { until: oy + 185 }, { turn: "W" }, { until: ox + 120 }]);

  // Main combustion chamber.
  const chamber = box(b, {
    tag: T("MCC", 26),
    name: "",
    x: ox + 117.5,
    y: oy + 235,
    w: 50,
    h: 20,
    caption: ["MAIN CHAMBER", "AND NOZZLE"],
    nozzles: [
      { id: "ox", x: 0, y: 12.5, side: "left" },
      { id: "purge", x: 0, y: 17.5, side: "left" },
      { id: "fuel", x: 50, y: 12.5, side: "right" },
      { id: "pc", x: 25, y: 0, side: "top" }
    ]
  });
  b.bubble(chamber.pc, "N", T("PT", 27), { stem: 5 });

  // Spin start: from the on-board bottles on engines that relight, from the ground on the outer ring.
  const spin = L("GN2", 21, '1"', HP, "420 bar");
  const spinStart = gimbal ? source(b, p(142.5, 30), "S", `SPIN-E${id}`, "SPIN") : ground(b, p(142.5, 30), "S", "GSE SPIN");
  const spinSteps: Step[] = gimbal ? [5, { key: "solenoid_valve", tag: T("SV", 28) }, 5] : [2.5, { key: "quick_disconnect", tag: T("QD", 30) }, 2.5, { key: "solenoid_valve", tag: T("SV", 28) }, 5];
  const junction = b.chain(spinStart, "S", spin, [...spinSteps, { key: "check_valve", tag: T("CV", 29) }, { until: oy + 195 }]);
  b.line([junction, opb.spin], spin);
  b.line([junction, fpb.spin], spin);

  // Nitrogen purge of the oxygen preburner and the main injector.
  const purge = L("GN2", 22, '1/2"', MP, "60 bar");
  b.chain(source(b, p(10, 30), "S", `PRG-E${id}`, "PURGE"), "S", purge, [5, { key: "solenoid_valve", tag: T("SV", 31), flip: true }, 5, { key: "check_valve", tag: T("CV", 32) }, { until: oy + 195 }, { mark: "pb" }, { until: oy + 252.5 }, { turn: "E" }, { until: ox + 117.5 }]);
  b.line([b.marks.pb, opb.purge], purge);

  // Engine controller drives the two main valves.
  const controller = b.place({ key: "instrument_computer", tag: T("UC", 33) }, "signal_top", p(120, 140));
  const mov = signalPort(b, T("XV", 1));
  const mfv = signalPort(b, T("XV", 12));
  wire(b, [mov, at(controller.signal_top.x, mov.y), controller.signal_top]);
  wire(b, [mfv, at(ox + 157.5, mfv.y), at(ox + 157.5, controller.signal_right.y), controller.signal_right]);
}

function sheetEngines(first: number): BoosterSheet {
  const b = new Builder(`s${4 + Math.ceil(first / ENGINES_PER_SHEET)}-`);
  const last = Math.min(first + ENGINES_PER_SHEET - 1, ENGINE_COUNT);
  for (let number = first; number <= last; number += 1) {
    const slot = number - first;
    engine(b, number, 20 + (slot % 4) * ENGINE_W, 37.5 + Math.floor(slot / 4) * ENGINE_H);
  }
  return finish(b, `Engines E${pad(first)}-E${pad(last)}`);
}

export function buildBoosterDemo(): BoosterDemo {
  const sheets = [sheetTanks(), sheetDistribution(), sheetCollection(), sheetGas()];
  for (let first = 1; first <= ENGINE_COUNT; first += ENGINES_PER_SHEET) sheets.push(sheetEngines(first));
  return {
    project: {
      name: "Super Heavy Booster (illustrative)",
      owner: "Propulsion Engineering",
      description: "Scale demo: fluid systems of a 33-engine methane / oxygen booster, drawn from public descriptions. Tags, sizes, and pressures are invented; not design data."
    },
    number: "SHB-0100",
    title: "P&ID\nBOOSTER FLUID SYSTEMS\nVEHICLE AND 33 ENGINES",
    size: "A0",
    system: { name: "Booster Propulsion", fluid: "LOX / LCH4", description: "Tanks, feed, autogenous pressurization, stored gas, and engines of the booster." },
    notes: [
      "ILLUSTRATIVE MODEL. TAGS, SIZES, AND PRESSURES ARE INVENTED. NOT DESIGN DATA.",
      "ENGINE TAGS ARE nnss: ENGINE nn, ITEM ss."
    ],
    lineClasses: [
      { name: CRYO, description: "Cryogenic propellant and ullage lines", material: "304L", rating: "12 bar", wall: "4 mm", sizes: ['1"', '2"', '4"', '6"', '8"', '10"', '12"', '20"', '24"', '30"'] },
      { name: HOT, description: "Hot gas lines", material: "Inconel 718", rating: "800 bar", wall: "per stress report", sizes: ['2"', '6"', '8"'] },
      { name: ENG, description: "Engine high-pressure propellant lines", material: "Inconel 718", rating: "900 bar", wall: "per stress report", sizes: ['2"', '5"', '6"'] },
      { name: HP, description: "Stored gas tubing", material: "316L", rating: "420 bar", wall: "0.083 in", sizes: ['1"', '2"'] },
      { name: MP, description: "Regulated gas tubing", material: "316L", rating: "150 bar", wall: "0.049 in", sizes: ['1/2"', '1"', '2"'] }
    ],
    sheets
  };
}
