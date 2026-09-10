/**
 * Built-in symbol library (ISA-5.1 instrumentation, ISO 10628 / ISO 14617
 * process symbols, plus propulsion test-stand hardware), authored in mm on
 * the 2.5 mm module. See Appendix A of the P&ID upgrade plan for scope.
 *
 * Conventions:
 *  - origin at the symbol centre, y down; inline symbols are 20 mm long with
 *    process ports at x = ±10;
 *  - ports sit on the 2.5 mm grid (enforced by a test);
 *  - markup uses currentColor; the renderer sets the stroke width;
 *  - valve bodies declare `actuatorMount`, the stem base where an actuator
 *    symbol is drawn; actuator geometry is authored relative to that point
 *    with its signal port at (0, -7.5) so composed ports stay on grid.
 */
import type { PortDef, SymbolDef } from "./types";

export const BUILTIN_LIBRARY = "fsdp";

const ISA = "ISA-5.1";
const ISO = "ISO 10628";

const INLINE_PORTS: PortDef[] = [
  { id: "in", x: -10, y: 0, side: "left", kind: "process" },
  { id: "out", x: 10, y: 0, side: "right", kind: "process" }
];

const INSTRUMENT_PORTS: PortDef[] = [
  { id: "process", x: 0, y: 5, side: "bottom", kind: "process" },
  { id: "signal_left", x: -5, y: 0, side: "left", kind: "signal" },
  { id: "signal_right", x: 5, y: 0, side: "right", kind: "signal" },
  { id: "signal_top", x: 0, y: -5, side: "top", kind: "signal" }
];

const BOWTIE = "M-6,-3.5 L0,0 L-6,3.5 Z M6,-3.5 L0,0 L6,3.5 Z";
const STUBS = "M-10,0 H-6 M6,0 H10";
const VALVE_MOUNT = { x: 0, y: -2.5 };

type Entry = Omit<SymbolDef, "library" | "version">;

function def(entry: Entry): SymbolDef {
  return { library: BUILTIN_LIBRARY, version: 1, ...entry };
}

function valve(key: string, name: string, legend: string, svg: string, tagPrefix: string, extra: Partial<Entry> = {}): SymbolDef {
  return def({
    key,
    name,
    category: "valve",
    legend,
    standardRef: ISA,
    width: 20,
    height: 7,
    svg,
    ports: INLINE_PORTS,
    tagPrefix,
    actuatorMount: VALVE_MOUNT,
    ...extra
  });
}

function inline(key: string, name: string, legend: string, svg: string, tagPrefix: string, height = 8, extra: Partial<Entry> = {}): SymbolDef {
  return def({ key, name, category: "inline", legend, standardRef: ISO, width: 20, height, svg, ports: INLINE_PORTS, tagPrefix, ...extra });
}

function actuator(key: string, name: string, legend: string, svg: string, signal = true): SymbolDef {
  return def({
    key,
    name,
    category: "actuator",
    legend,
    standardRef: ISA,
    width: 10,
    height: 7.5,
    svg,
    ports: signal ? [{ id: "signal", x: 0, y: -7.5, side: "top", kind: "signal" }] : []
  });
}

function instrument(key: string, name: string, legend: string, svg: string, ports: PortDef[] = INSTRUMENT_PORTS, tagPrefix = "PT"): SymbolDef {
  return def({ key, name, category: "instrument", legend, standardRef: ISA, width: 10, height: 10, svg, ports, tagPrefix });
}

const label = (value: string, y: number, size = 3) =>
  `<text x="0" y="${y}" font-size="${size}" text-anchor="middle" fill="currentColor" stroke="none" font-family="'IBM Plex Sans', Arial, sans-serif">${value}</text>`;

/* ---------- Valves ---------- */

const VALVES: SymbolDef[] = [
  valve("valve", "Gate valve", "GATE VALVE", `<path d="${BOWTIE} ${STUBS}"/>`, "HV"),
  valve("globe_valve", "Globe valve", "GLOBE VALVE", `<path d="${BOWTIE} ${STUBS}"/><circle cx="0" cy="0" r="1.2" fill="currentColor"/>`, "HV"),
  valve("ball_valve", "Ball valve", "BALL VALVE", `<path d="${BOWTIE} ${STUBS}"/><circle cx="0" cy="0" r="1.8" fill="#fff"/>`, "HV"),
  valve("butterfly_valve", "Butterfly valve", "BUTTERFLY VALVE", `<path d="${BOWTIE} ${STUBS} M-4,4 L4,-4"/><circle cx="0" cy="0" r="1" fill="currentColor"/>`, "HV"),
  valve("needle_valve", "Needle valve", "NEEDLE VALVE", `<path d="${BOWTIE} ${STUBS} M0,0 V-4.5 M-1.5,-4.5 H1.5"/>`, "NV", { height: 9 }),
  valve("plug_valve", "Plug valve", "PLUG VALVE", `<path d="${BOWTIE} ${STUBS}"/><rect x="-1.5" y="-2" width="3" height="4" fill="#fff" stroke="currentColor"/>`, "HV"),
  valve("diaphragm_valve", "Diaphragm valve", "DIAPHRAGM VALVE", `<path d="${BOWTIE} ${STUBS} M-4,-3.5 A4,3 0 0 1 4,-3.5"/>`, "HV", { height: 9 }),
  valve("check_valve", "Check valve", "CHECK VALVE", '<path d="M-6,-3.5 L4,0 L-6,3.5 Z M4,-3.5 V3.5 M-10,0 H-6 M4,0 H10"/>', "CV", { actuatorMount: undefined }),
  valve("check_valve_swing", "Swing check valve", "SWING CHECK VALVE", '<path d="M-6,-3.5 L6,3.5 M-6,3.5 L6,-3.5 M-10,0 H-6 M6,0 H10"/><circle cx="-6" cy="3.5" r="1" fill="currentColor"/>', "CV", { actuatorMount: undefined }),
  valve("three_way_valve", "3-way valve", "3-WAY VALVE", `<path d="${BOWTIE} ${STUBS} M-3.5,6 L0,0 L3.5,6 Z M0,6 V10"/>`, "HV", {
    height: 13.5,
    ports: [...INLINE_PORTS, { id: "branch", x: 0, y: 10, side: "bottom", kind: "process" }]
  }),
  valve("four_way_valve", "4-way valve", "4-WAY VALVE", `<path d="${BOWTIE} ${STUBS} M-3.5,6 L0,0 L3.5,6 Z M0,6 V10 M-3.5,-6 L0,0 L3.5,-6 Z M0,-6 V-10"/>`, "HV", {
    height: 20,
    ports: [...INLINE_PORTS, { id: "branch", x: 0, y: 10, side: "bottom", kind: "process" }, { id: "top", x: 0, y: -10, side: "top", kind: "process" }],
    actuatorMount: undefined
  }),
  valve("angle_valve", "Angle valve", "ANGLE VALVE", '<path d="M-10,0 H-7 M-7,-3.5 L0,0 L-7,3.5 Z M-3.5,7 L0,0 L3.5,7 Z M0,7 V10"/>', "HV", {
    height: 13.5,
    ports: [
      { id: "in", x: -10, y: 0, side: "left", kind: "process" },
      { id: "out", x: 0, y: 10, side: "bottom", kind: "process" }
    ]
  }),
  valve("cross_over_valve", "Cross-over valve", "CROSS-OVER VALVE", `<path d="${BOWTIE} ${STUBS} M-3.5,-6 L0,0 L3.5,-6 Z M0,-6 V-10 M-3.5,6 L0,0 L3.5,6 Z M0,6 V10 M-2,-8 H2 M-2,8 H2"/>`, "XV", {
    height: 20,
    ports: [...INLINE_PORTS, { id: "top", x: 0, y: -10, side: "top", kind: "process" }, { id: "branch", x: 0, y: 10, side: "bottom", kind: "process" }],
    actuatorMount: undefined
  }),
  valve("hand_valve", "Hand valve", "HAND VALVE", `<path d="${BOWTIE} ${STUBS} M0,0 V-6 M-3,-6 H3"/>`, "HV", { height: 12, actuatorMount: undefined }),
  valve("solenoid_valve", "Solenoid valve", "SOLENOID VALVE", `<path d="${BOWTIE} ${STUBS} M0,0 V-4 M-3,-4 H3 V-9 H-3 Z"/>${label("S", -5.4, 3.2)}`, "SV", {
    height: 14,
    ports: [...INLINE_PORTS, { id: "signal", x: 0, y: -10, side: "top", kind: "signal" }],
    actuatorMount: undefined
  }),
  valve("pneumatic_valve", "Pneumatic control valve", "PNEUMATIC CONTROL VALVE", `<path d="${BOWTIE} ${STUBS} M0,0 V-6 M-5,-6 A5,3 0 0 1 5,-6 Z"/>`, "PV", {
    height: 15,
    ports: [...INLINE_PORTS, { id: "signal", x: 0, y: -10, side: "top", kind: "signal" }],
    actuatorMount: undefined
  }),
  valve("motor_valve", "Motor operated valve", "MOTOR OPERATED VALVE", `<path d="${BOWTIE} ${STUBS} M0,0 V-4"/><circle cx="0" cy="-7" r="3"/>${label("M", -5.9, 3)}`, "MOV", {
    height: 14,
    ports: [...INLINE_PORTS, { id: "signal", x: 0, y: -10, side: "top", kind: "signal" }],
    actuatorMount: undefined
  }),
  valve("relief_valve", "Relief valve", "RELIEF VALVE", '<path d="M-10,0 H-7 M-7,-3.5 L0,0 L-7,3.5 Z M-3.5,-7 L0,0 L3.5,-7 Z M0,-7 V-10 M2,-1.5 l3,-1.5 M2,-3.5 l3,-1.5 M2,-5.5 l3,-1.5"/>', "PSV", {
    height: 20,
    ports: [
      { id: "in", x: -10, y: 0, side: "left", kind: "process" },
      { id: "vent", x: 0, y: -10, side: "top", kind: "process" }
    ],
    actuatorMount: undefined
  }),
  valve("safety_valve", "Safety valve (spring loaded)", "SAFETY VALVE", '<path d="M-10,0 H-7 M-7,-3.5 L0,0 L-7,3.5 Z M-3.5,-7 L0,0 L3.5,-7 Z M0,-7 V-10 M-2,-3 L2,-4 M-2,-5 L2,-6 M-2,-7 L2,-8"/>', "PSV", {
    height: 20,
    ports: [
      { id: "in", x: -10, y: 0, side: "left", kind: "process" },
      { id: "vent", x: 0, y: -10, side: "top", kind: "process" }
    ],
    actuatorMount: undefined
  }),
  valve("rupture_disc", "Rupture disc", "RUPTURE DISC", '<path d="M-10,0 H-3 M-3,-5 V5 M-3,-5 Q4,0 -3,5 M3,0 H10"/>', "PSE", { height: 10, actuatorMount: undefined }),
  valve("excess_flow_valve", "Excess flow valve", "EXCESS FLOW VALVE", '<path d="M-6,-3.5 L4,0 L-6,3.5 Z M4,-3.5 V3.5 M-10,0 H-6 M4,0 H10 M-3,-6 H3"/>', "XFV", { height: 12, actuatorMount: undefined })
];

/* ---------- Regulators ---------- */

const REGULATORS: SymbolDef[] = [
  def({
    key: "regulator",
    name: "Pressure regulator (reducing)",
    category: "regulator",
    legend: "PRESSURE REGULATOR",
    standardRef: ISA,
    width: 20,
    height: 13.5,
    svg: `<path d="${BOWTIE} ${STUBS} M0,0 V-6 M-5,-6 A5,3 0 0 1 5,-6 Z M0,-9 V-10"/>`,
    ports: INLINE_PORTS,
    tagPrefix: "PCV"
  }),
  def({
    key: "back_pressure_regulator",
    name: "Back-pressure regulator",
    category: "regulator",
    legend: "BACK-PRESSURE REGULATOR",
    standardRef: ISA,
    width: 20,
    height: 13.5,
    svg: `<path d="${BOWTIE} ${STUBS} M0,0 V6 M-5,6 A5,3 0 0 0 5,6 Z M4,-1 L7,-3"/>`,
    ports: INLINE_PORTS,
    tagPrefix: "BPR"
  }),
  def({
    key: "dome_loaded_regulator",
    name: "Dome-loaded regulator",
    category: "regulator",
    legend: "DOME-LOADED REGULATOR",
    standardRef: ISA,
    width: 20,
    height: 15,
    svg: `<path d="${BOWTIE} ${STUBS} M0,0 V-6 M-5,-6 A5,3 0 0 1 5,-6 Z M-5,-6 V-8 M5,-6 V-8 M0,-9 V-10"/>`,
    ports: [...INLINE_PORTS, { id: "dome", x: 0, y: -10, side: "top", kind: "signal" }],
    tagPrefix: "PCV"
  }),
  def({
    key: "loader",
    name: "Loader (pilot regulator)",
    category: "regulator",
    legend: "LOADER",
    standardRef: ISA,
    width: 20,
    height: 12,
    svg: `<path d="${BOWTIE} ${STUBS} M0,0 V-5"/><circle cx="0" cy="-7" r="2.5"/>`,
    ports: INLINE_PORTS,
    tagPrefix: "PCV"
  })
];

/* ---------- Actuators (drawn at the body's actuatorMount) ---------- */

const ACTUATORS: SymbolDef[] = [
  actuator("act_hand", "Hand actuator", "HAND ACTUATOR", '<path d="M0,-1 V-5 M-3,-5 H3"/>', false),
  actuator("act_lever", "Hand lever", "HAND LEVER", '<path d="M0,-1 V-4 L5,-7.5"/>', false),
  actuator("act_diaphragm", "Diaphragm (pneumatic)", "PNEUMATIC DIAPHRAGM ACTUATOR", '<path d="M0,-1 V-4.5 M-5,-4.5 A5,3 0 0 1 5,-4.5 Z"/>'),
  actuator("act_piston", "Cylinder (piston)", "CYLINDER ACTUATOR", '<path d="M0,-1 V-3 M-4,-3 H4 V-7.5 H-4 Z M-4,-5.5 H4"/>'),
  actuator("act_solenoid", "Solenoid", "SOLENOID ACTUATOR", `<path d="M0,-1 V-3 M-3,-3 H3 V-7.5 H-3 Z"/>${label("S", -4.2, 3)}`),
  actuator("act_motor", "Electric motor", "ELECTRIC MOTOR ACTUATOR", `<path d="M0,-1 V-3"/><circle cx="0" cy="-5.25" r="2.25"/>${label("M", -4.4, 2.6)}`),
  actuator("act_rotary_motor", "Rotary motor", "ROTARY MOTOR ACTUATOR", `<path d="M0,-1 V-3"/><circle cx="0" cy="-5.25" r="2.25"/>${label("R", -4.4, 2.6)}`),
  actuator("act_spring", "Spring return", "SPRING RETURN", '<path d="M0,-1 V-2.5 M-2,-2.5 L2,-3.5 M-2,-4.5 L2,-5.5 M-2,-6.5 L2,-7.5"/>', false)
];

/* ---------- Inline fittings and specialties ---------- */

const INLINE: SymbolDef[] = [
  inline("filter", "Filter", "FILTER", '<path d="M-4,-6 H4 V6 H-4 Z M-10,0 H-4 M4,0 H10 M-4,-3 L4,-1 M-4,1 L4,3"/>', "F", 12),
  inline("coalescing_filter", "Coalescing filter", "COALESCING FILTER", '<path d="M-4,-6 H4 V6 H-4 Z M-10,0 H-4 M4,0 H10 M-4,-3 L4,-1 M-4,1 L4,3 M0,6 V8"/>', "F", 16),
  inline("strainer", "Strainer (Y-type)", "Y-STRAINER", '<path d="M-10,0 H10 M-3,0 L1,5 M-1,0 L3,5 M1,5 H3"/>', "STR", 10),
  inline("basket_strainer", "Basket strainer", "BASKET STRAINER", '<path d="M-10,0 H10 M-4,-5 L4,5 M-4,5 L4,-5"/>', "STR", 10),
  inline("orifice", "Orifice plate", "ORIFICE PLATE", '<path d="M-10,0 H-1 M1,0 H10 M-1,-4 V4 M1,-4 V4"/>', "FO"),
  inline("restriction_orifice", "Restriction orifice", "RESTRICTION ORIFICE", `<path d="M-10,0 H-1 M1,0 H10 M-1,-4 V4 M1,-4 V4"/>${label("RO", -5, 2.4)}`, "RO", 14),
  inline("venturi", "Venturi", "VENTURI", '<path d="M-6,-3 L-1,-1 H1 L6,-3 M-6,3 L-1,1 H1 L6,3 M-10,0 H-6 M6,0 H10 M-6,-3 V3 M6,-3 V3"/>', "FE", 6),
  inline("flow_nozzle", "Flow nozzle", "FLOW NOZZLE", '<path d="M-10,0 H-3 M-3,-4 V4 M-3,-4 Q3,-2 3,0 Q3,2 -3,4 M3,0 H10"/>', "FE"),
  inline("flex_hose", "Flex hose", "FLEX HOSE", '<path d="M-10,0 H-6 C-4,-4 -2,4 0,0 C2,-4 4,4 6,0 H10"/>', "FH", 6),
  inline("vacuum_jacketed_hose", "Vacuum-jacketed hose", "VACUUM JACKETED HOSE", '<path d="M-10,0 H-6 C-4,-4 -2,4 0,0 C2,-4 4,4 6,0 H10 M-6,-4 H6 M-6,4 H6"/>', "VJH"),
  inline("reducer", "Reducer (concentric)", "REDUCER", '<path d="M-10,0 H-5 M-5,-4 L5,-2 V2 L-5,4 Z M5,0 H10"/>', "RED"),
  inline("eccentric_reducer", "Reducer (eccentric)", "ECCENTRIC REDUCER", '<path d="M-10,0 H-5 M-5,-4 L5,-1 V2 L-5,4 Z M5,0 H10"/>', "RED"),
  inline("flange", "Flange pair", "FLANGE", '<path d="M-10,0 H10 M-1,-4 V4 M1,-4 V4"/>', "FL"),
  inline("blind_flange", "Blind flange", "BLIND FLANGE", '<path d="M-10,0 H0 M0,-4 V4 M2,-4 V4 M0,-4 H2 M0,4 H2"/>', "FL"),
  inline("union", "Union", "UNION", '<path d="M-10,0 H10 M-1.5,-3 V3 M1.5,-3 V3 M-1.5,-3 H1.5 M-1.5,3 H1.5"/>', "UN", 6),
  inline("cap", "Cap", "CAP", '<path d="M-10,0 H0 M0,-3 V3 M0,-3 H3 V3 H0"/>', "CAP", 6, { ports: [{ id: "in", x: -10, y: 0, side: "left", kind: "process" }] }),
  inline("plug", "Plug", "PLUG", '<path d="M-10,0 H0 M0,-3 V3 M0,0 H4"/>', "PLG", 6, { ports: [{ id: "in", x: -10, y: 0, side: "left", kind: "process" }] }),
  inline("expansion_joint", "Expansion joint (bellows)", "EXPANSION JOINT", '<path d="M-10,0 H-6 M-6,-3 V3 M6,-3 V3 M-6,-3 L-3,3 L0,-3 L3,3 L6,-3 M6,0 H10"/>', "EJ", 6),
  inline("sight_glass", "Sight glass", "SIGHT GLASS", '<circle cx="0" cy="0" r="3"/><path d="M-10,0 H-3 M3,0 H10 M-1.5,-1.5 L1.5,1.5"/>', "SG", 6),
  inline("silencer", "Silencer", "SILENCER", '<path d="M-4,-3 H4 V3 H-4 Z M-2,-3 V3 M0,-3 V3 M2,-3 V3 M-10,0 H-4 M4,0 H10"/>', "SIL", 6),
  inline("water_separator", "Water separator", "WATER SEPARATOR", '<circle cx="0" cy="0" r="5"/><path d="M0,-2.5 L2,0.5 A2,2 0 1 1 -2,0.5 Z M-10,0 H-5 M5,0 H10 M0,5 V10"/>', "WS", 20, {
    ports: [...INLINE_PORTS, { id: "drain", x: 0, y: 10, side: "bottom", kind: "process" }]
  }),
  inline("float_trap", "Float trap", "FLOAT TRAP", '<circle cx="0" cy="0" r="5"/><circle cx="0" cy="1" r="2"/><path d="M-10,0 H-5 M5,0 H10"/>', "FT", 10),
  inline("demister", "Demister", "DEMISTER", '<path d="M-6,-4 H6 V4 H-6 Z M-6,-4 L6,4 M-6,4 L6,-4 M-10,0 H-6 M6,0 H10"/>', "DM"),
  inline("manifold", "Manifold", "MANIFOLD", '<path d="M-8,-3 H8 V3 H-8 Z M-10,0 H-8 M8,0 H10 M-5,-3 V-7.5 M0,-3 V-7.5 M5,-3 V-7.5"/>', "MAN", 15, {
    ports: [
      ...INLINE_PORTS,
      { id: "p1", x: -5, y: -7.5, side: "top", kind: "process" },
      { id: "p2", x: 0, y: -7.5, side: "top", kind: "process" },
      { id: "p3", x: 5, y: -7.5, side: "top", kind: "process" }
    ]
  }),
  inline("quick_disconnect", "Quick disconnect", "QUICK DISCONNECT", '<path d="M-10,0 H-2 M2,0 H10 M-2,-4 V4 M2,-4 V4 M-5,-4 V4 M5,-4 V4"/>', "QD"),
  inline("flow_meter", "Flow meter (inline)", "FLOW METER", '<rect x="-6" y="-4" width="12" height="8"/><path d="M-3,0 L3,-3 M-3,0 L3,3 M-10,0 H-6 M6,0 H10"/>', "FM"),
  inline("turbine_meter", "Turbine flow meter", "TURBINE FLOW METER", '<rect x="-6" y="-4" width="12" height="8"/><path d="M-3,-3 L3,3 M-3,3 L3,-3 M-10,0 H-6 M6,0 H10"/>', "FE"),
  inline("mass_flow_controller", "Mass flow controller", "MASS FLOW CONTROLLER", `<rect x="-7" y="-4" width="14" height="8"/>${label("MFC", 1, 2.4)}<path d="M-10,0 H-7 M7,0 H10 M0,-4 V-7.5"/>`, "MFC", 15, {
    ports: [...INLINE_PORTS, { id: "signal", x: 0, y: -7.5, side: "top", kind: "signal" }]
  }),
  inline("spray_nozzle", "Spray nozzle", "SPRAY NOZZLE", '<path d="M-10,0 H-2 M-2,-3 L4,0 L-2,3 Z M4,0 L8,-3 M4,0 L8,3 M4,0 L8,0"/>', "SN", 6, { ports: [{ id: "in", x: -10, y: 0, side: "left", kind: "process" }] }),
  inline("field_weld", "Field weld", "FIELD WELD", '<path d="M-10,0 H10"/><path d="M0,0 L-2,-4 H2 Z" fill="currentColor"/>', "FW"),
  inline("shop_weld", "Shop weld", "SHOP WELD", '<path d="M-10,0 H10 M0,0 L-2,-4 H2 Z"/>', "SW"),
  inline("flow_arrow", "Flow direction arrow", "FLOW DIRECTION", '<path d="M-10,0 H10"/><path d="M2,-2.5 L7,0 L2,2.5 Z" fill="currentColor"/>', "", 5),
  inline("spec_break", "Spec break", "SPEC BREAK", `<path d="M-10,0 H10 M0,-5 V5"/>${label("SPEC", -6, 2)}${label("BREAK", 8.5, 2)}`, "", 17),
  inline("component", "Generic component", "COMPONENT", '<path d="M-6,-5 H6 V5 H-6 Z M-10,0 H-6 M6,0 H10"/>', "C", 10)
];

/* ---------- Instruments (ISA-5.1 bubbles) ---------- */

const INSTRUMENTS: SymbolDef[] = [
  instrument("instrument", "Instrument, field mounted", "FIELD MOUNTED INSTRUMENT", '<circle cx="0" cy="0" r="5" fill="#fff"/>'),
  instrument("instrument_panel", "Instrument, main panel (control room)", "CONTROL ROOM INSTRUMENT", '<circle cx="0" cy="0" r="5" fill="#fff"/><path d="M-5,0 H5"/>', INSTRUMENT_PORTS, "PI"),
  instrument("instrument_aux_panel", "Instrument, local / auxiliary panel", "LOCAL PANEL INSTRUMENT", '<circle cx="0" cy="0" r="5" fill="#fff"/><path d="M-5,0 H5" stroke-dasharray="1.2 0.8"/>', INSTRUMENT_PORTS, "PI"),
  instrument("instrument_dcs", "Shared display / DCS", "SHARED DISPLAY (DCS)", '<rect x="-5" y="-5" width="10" height="10" fill="#fff"/><circle cx="0" cy="0" r="5"/><path d="M-5,0 H5"/>', INSTRUMENT_PORTS, "PIC"),
  instrument("instrument_dcs_field", "Shared display, field", "SHARED DISPLAY, FIELD", '<rect x="-5" y="-5" width="10" height="10" fill="#fff"/><circle cx="0" cy="0" r="5"/>', INSTRUMENT_PORTS, "PIC"),
  instrument("instrument_plc", "PLC function", "PLC", '<rect x="-5" y="-5" width="10" height="10" fill="#fff"/><path d="M0,-5 L5,0 L0,5 L-5,0 Z"/>', INSTRUMENT_PORTS, "UC"),
  instrument("instrument_computer", "Computer function", "COMPUTER FUNCTION", '<path d="M-2.5,-5 H2.5 L5,0 L2.5,5 H-2.5 L-5,0 Z" fill="#fff"/>', INSTRUMENT_PORTS, "UC"),
  instrument("instrument_interlock", "Interlock", "INTERLOCK", `<path d="M0,-5 L5,0 L0,5 L-5,0 Z" fill="#fff"/>`, INSTRUMENT_PORTS, "I"),
  instrument("instrument_hardwired_shutdown", "Hardwired shutdown", "HARDWIRED SHUTDOWN", '<circle cx="0" cy="0" r="5" fill="#fff"/><path d="M0,-4 L4,0 L0,4 L-4,0 Z"/>', INSTRUMENT_PORTS, "HS"),
  instrument("instrument_data_collector", "Data collector", "DATA COLLECTOR", '<rect x="-5" y="-5" width="10" height="10" fill="#fff"/>', INSTRUMENT_PORTS, "DC"),
  instrument("instrument_laptop", "Laptop controller", "LAPTOP CONTROLLER", '<rect x="-5" y="-5" width="10" height="10" fill="#fff"/><path d="M-5,-2.5 H5"/>', INSTRUMENT_PORTS, "LC"),
  instrument("instrument_prm", "PRM process controller", "PRM PROCESS CONTROLLER", '<rect x="-5" y="-5" width="10" height="10" fill="#fff"/><rect x="-3.5" y="-3.5" width="7" height="7"/>', INSTRUMENT_PORTS, "PRM"),
  def({
    key: "instrument_element",
    name: "Primary element (boxed letters)",
    category: "instrument",
    legend: "PRIMARY CONTROL ELEMENT",
    standardRef: ISA,
    width: 10,
    height: 6,
    svg: '<rect x="-5" y="-3" width="10" height="6" rx="1" fill="#fff"/>',
    ports: [
      { id: "process", x: 0, y: 2.5, side: "bottom", kind: "process" },
      { id: "signal_left", x: -5, y: 0, side: "left", kind: "signal" },
      { id: "signal_right", x: 5, y: 0, side: "right", kind: "signal" },
      { id: "signal_top", x: 0, y: -2.5, side: "top", kind: "signal" }
    ],
    tagPrefix: "TE"
  }),
  def({
    key: "pressure_gauge",
    name: "Pressure gauge",
    category: "instrument",
    legend: "PRESSURE GAUGE",
    standardRef: ISA,
    width: 10,
    height: 10,
    svg: '<circle cx="0" cy="0" r="5" fill="#fff"/><path d="M0,0 L2.5,-3"/>',
    ports: [{ id: "process", x: 0, y: 5, side: "bottom", kind: "process" }],
    tagPrefix: "PG"
  }),
  def({
    key: "thermocouple",
    name: "Thermocouple / temperature element",
    category: "instrument",
    legend: "TEMPERATURE ELEMENT",
    standardRef: ISA,
    width: 10,
    height: 10,
    svg: '<circle cx="0" cy="0" r="5" fill="#fff"/><path d="M0,5 V0 M-1.5,0 L0,-2.5 L1.5,0"/>',
    ports: [
      { id: "process", x: 0, y: 5, side: "bottom", kind: "process" },
      { id: "signal_left", x: -5, y: 0, side: "left", kind: "signal" },
      { id: "signal_right", x: 5, y: 0, side: "right", kind: "signal" }
    ],
    tagPrefix: "TE"
  })
];

/* ---------- Terminators and connectors ---------- */

const CONNECTORS: SymbolDef[] = [
  def({
    key: "terminator",
    name: "Off-sheet terminator (out)",
    category: "connector",
    legend: "OFF-SHEET CONNECTION",
    standardRef: ISA,
    width: 30,
    height: 8,
    svg: '<path d="M-15,-4 H9 L15,0 L9,4 H-15 Z" fill="#fff"/>',
    ports: [{ id: "in", x: -15, y: 0, side: "left", kind: "process" }],
    tagPrefix: "IF"
  }),
  def({
    key: "terminator_in",
    name: "Off-sheet terminator (in)",
    category: "connector",
    legend: "OFF-SHEET CONNECTION (IN)",
    standardRef: ISA,
    width: 30,
    height: 8,
    svg: '<path d="M15,-4 H-9 L-15,0 L-9,4 H15 Z" fill="#fff"/>',
    ports: [{ id: "out", x: 15, y: 0, side: "right", kind: "process" }],
    tagPrefix: "IF"
  }),
  def({
    key: "off_page_connector",
    name: "Off-page connector (sheet reference)",
    category: "connector",
    legend: "OFF-PAGE CONNECTOR",
    standardRef: ISA,
    width: 30,
    height: 8,
    svg: '<path d="M-15,-4 H9 L15,0 L9,4 H-15 Z" fill="#fff"/><path d="M-11,-4 V4"/>',
    ports: [{ id: "in", x: -15, y: 0, side: "left", kind: "process" }],
    tagPrefix: "SHT"
  }),
  def({
    key: "vent_atmosphere",
    name: "Vent to atmosphere",
    category: "connector",
    legend: "VENT TO ATMOSPHERE",
    standardRef: ISO,
    width: 20,
    height: 10,
    svg: '<path d="M-10,0 H0 M0,0 V-7 M-4,-7 L0,-10 L4,-7"/>',
    ports: [{ id: "in", x: -10, y: 0, side: "left", kind: "process" }],
    tagPrefix: "VENT"
  }),
  def({
    key: "drain",
    name: "Drain",
    category: "connector",
    legend: "DRAIN",
    standardRef: ISO,
    width: 20,
    height: 10,
    svg: '<path d="M-10,0 H0 M0,0 V6 M-3,6 H3 M-2,8 H2 M-1,10 H1"/>',
    ports: [{ id: "in", x: -10, y: 0, side: "left", kind: "process" }],
    tagPrefix: "DRN"
  }),
  def({
    key: "utility_connection",
    name: "Utility connection",
    category: "connector",
    legend: "UTILITY CONNECTION",
    standardRef: ISA,
    width: 20,
    height: 10,
    svg: '<circle cx="5" cy="0" r="5" fill="#fff"/><path d="M-10,0 H0"/>',
    ports: [{ id: "in", x: -10, y: 0, side: "left", kind: "process" }],
    tagPrefix: "U"
  }),
  def({
    key: "tie_in",
    name: "Tie-in point",
    category: "connector",
    legend: "TIE-IN POINT",
    standardRef: ISA,
    width: 20,
    height: 8,
    svg: `<path d="M-10,0 H10"/><path d="M0,-4 L4,0 L0,4 L-4,0 Z" fill="#fff"/>${label("T", 1, 2.4)}`,
    ports: INLINE_PORTS,
    tagPrefix: "TP"
  })
];

/* ---------- Equipment ---------- */

const EQUIPMENT: SymbolDef[] = [
  def({
    key: "tank",
    name: "Tank / vessel (vertical)",
    category: "equipment",
    legend: "VESSEL",
    standardRef: ISO,
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
    key: "vessel_horizontal",
    name: "Vessel (horizontal)",
    category: "equipment",
    legend: "HORIZONTAL VESSEL",
    standardRef: ISO,
    width: 30,
    height: 10,
    svg: '<path d="M-10,-5 H10 A5,5 0 0 1 10,5 H-10 A5,5 0 0 1 -10,-5 Z"/>',
    ports: [
      { id: "top", x: 0, y: -5, side: "top", kind: "nozzle" },
      { id: "bottom", x: 0, y: 5, side: "bottom", kind: "nozzle" },
      { id: "left", x: -15, y: 0, side: "left", kind: "nozzle" },
      { id: "right", x: 15, y: 0, side: "right", kind: "nozzle" }
    ],
    tagPrefix: "V"
  }),
  def({
    key: "dewar",
    name: "Dewar (vacuum insulated)",
    category: "equipment",
    legend: "DEWAR",
    standardRef: ISO,
    width: 15,
    height: 20,
    svg: '<path d="M-7.5,-7.5 V7.5 A7.5,2.5 0 0 0 7.5,7.5 V-7.5 A7.5,2.5 0 0 0 -7.5,-7.5 Z M-5.5,-6 V6 A5.5,2 0 0 0 5.5,6 V-6" stroke-dasharray="1.5 1"/>',
    ports: [
      { id: "top", x: 0, y: -10, side: "top", kind: "nozzle" },
      { id: "out", x: 7.5, y: 0, side: "right", kind: "nozzle" }
    ],
    tagPrefix: "DW"
  }),
  def({
    key: "gas_bottle",
    name: "Gas cylinder",
    category: "equipment",
    legend: "GAS CYLINDER",
    standardRef: ISO,
    width: 10,
    height: 25,
    svg: '<path d="M-5,-7.5 V10 A5,2 0 0 0 5,10 V-7.5 Q5,-10 2,-10 H-2 Q-5,-10 -5,-7.5 Z M0,-10 V-12.5"/>',
    ports: [{ id: "out", x: 0, y: -12.5, side: "top", kind: "nozzle" }],
    tagPrefix: "K"
  }),
  def({
    key: "accumulator",
    name: "Accumulator",
    category: "equipment",
    legend: "ACCUMULATOR",
    standardRef: ISO,
    width: 10,
    height: 20,
    svg: '<path d="M-5,-7.5 V7.5 A5,2.5 0 0 0 5,7.5 V-7.5 A5,2.5 0 0 0 -5,-7.5 Z M-5,0 H5"/>',
    ports: [
      { id: "top", x: 0, y: -10, side: "top", kind: "nozzle" },
      { id: "bottom", x: 0, y: 10, side: "bottom", kind: "nozzle" }
    ],
    tagPrefix: "ACC"
  }),
  def({
    key: "pump",
    name: "Pump (centrifugal)",
    category: "equipment",
    legend: "PUMP",
    standardRef: ISO,
    width: 20,
    height: 12,
    svg: '<circle cx="0" cy="0" r="6"/><path d="M-3,-4 L5,0 L-3,4 M-10,0 H-6 M6,0 H10"/>',
    ports: INLINE_PORTS,
    tagPrefix: "P"
  }),
  def({
    key: "vacuum_pump",
    name: "Vacuum pump",
    category: "equipment",
    legend: "VACUUM PUMP",
    standardRef: ISO,
    width: 20,
    height: 12,
    svg: '<circle cx="0" cy="0" r="6"/><path d="M-4,-3 L4,-3 L0,3 Z M-10,0 H-6 M6,0 H10"/>',
    ports: INLINE_PORTS,
    tagPrefix: "VP"
  }),
  def({
    key: "compressor",
    name: "Compressor",
    category: "equipment",
    legend: "COMPRESSOR",
    standardRef: ISO,
    width: 20,
    height: 12,
    svg: '<circle cx="0" cy="0" r="6"/><path d="M-4,-4 L4,-2 V2 L-4,4 Z M-10,0 H-6 M6,0 H10"/>',
    ports: INLINE_PORTS,
    tagPrefix: "C"
  }),
  def({
    key: "motor",
    name: "Motor",
    category: "equipment",
    legend: "MOTOR",
    standardRef: ISO,
    width: 10,
    height: 10,
    svg: `<circle cx="0" cy="0" r="5"/>${label("M", 1.1, 3.2)}`,
    ports: [
      { id: "shaft", x: 0, y: 5, side: "bottom", kind: "nozzle" },
      { id: "power", x: 0, y: -5, side: "top", kind: "signal" }
    ],
    tagPrefix: "M"
  }),
  def({
    key: "heat_exchanger",
    name: "Heat exchanger",
    category: "equipment",
    legend: "HEAT EXCHANGER",
    standardRef: ISO,
    width: 20,
    height: 12,
    svg: '<circle cx="0" cy="0" r="6"/><path d="M-6,0 L-3,-3 L0,3 L3,-3 L6,0 M-10,0 H-6 M6,0 H10"/>',
    ports: INLINE_PORTS,
    tagPrefix: "HX"
  }),
  def({
    key: "shell_tube_exchanger",
    name: "Shell and tube exchanger",
    category: "equipment",
    legend: "SHELL AND TUBE EXCHANGER",
    standardRef: ISO,
    width: 30,
    height: 10,
    svg: '<path d="M-10,-5 H10 A5,5 0 0 1 10,5 H-10 A5,5 0 0 1 -10,-5 Z M-10,-5 V5 M10,-5 V5 M-15,0 H-10 M10,0 H15 M-5,-5 V-7.5 M5,5 V7.5"/>',
    ports: [
      { id: "shell_in", x: -15, y: 0, side: "left", kind: "nozzle" },
      { id: "shell_out", x: 15, y: 0, side: "right", kind: "nozzle" },
      { id: "tube_in", x: -5, y: -7.5, side: "top", kind: "nozzle" },
      { id: "tube_out", x: 5, y: 7.5, side: "bottom", kind: "nozzle" }
    ],
    tagPrefix: "HX"
  }),
  def({
    key: "heater",
    name: "Electric heater",
    category: "equipment",
    legend: "ELECTRIC HEATER",
    standardRef: ISO,
    width: 20,
    height: 8,
    svg: '<rect x="-8" y="-4" width="16" height="8"/><path d="M-6,0 L-4,-2 L-2,2 L0,-2 L2,2 L4,-2 L6,0 M-10,0 H-8 M8,0 H10"/>',
    ports: [...INLINE_PORTS, { id: "power", x: 0, y: -5, side: "top", kind: "signal" }],
    tagPrefix: "HTR"
  }),
  def({
    key: "cryocooler",
    name: "Cryocooler / cold head",
    category: "equipment",
    legend: "CRYOCOOLER",
    standardRef: ISO,
    width: 20,
    height: 15,
    svg: '<rect x="-8" y="-7.5" width="16" height="15"/><path d="M-4,-3 L0,0 L-4,3 M0,0 H4 M-10,0 H-8 M8,0 H10"/>',
    ports: [...INLINE_PORTS, { id: "power", x: 0, y: -7.5, side: "top", kind: "signal" }],
    tagPrefix: "CC"
  }),
  def({
    key: "cylinder_actuator",
    name: "Pneumatic / hydraulic cylinder",
    category: "equipment",
    legend: "CYLINDER",
    standardRef: ISO,
    width: 20,
    height: 8,
    svg: '<rect x="-8" y="-4" width="16" height="8"/><path d="M-2,-4 V4 M8,0 H10 M-10,0 H-8"/>',
    ports: [...INLINE_PORTS],
    tagPrefix: "CYL"
  }),
  def({
    key: "equipment_box",
    name: "Generic equipment (box)",
    category: "equipment",
    legend: "EQUIPMENT",
    standardRef: ISO,
    width: 20,
    height: 15,
    svg: '<rect x="-10" y="-7.5" width="20" height="15"/>',
    ports: [
      { id: "left", x: -10, y: 0, side: "left", kind: "nozzle" },
      { id: "right", x: 10, y: 0, side: "right", kind: "nozzle" },
      { id: "top", x: 0, y: -7.5, side: "top", kind: "nozzle" },
      { id: "bottom", x: 0, y: 7.5, side: "bottom", kind: "nozzle" }
    ],
    tagPrefix: "H"
  })
];

export const BUILTIN_SYMBOLS: SymbolDef[] = [...VALVES, ...REGULATORS, ...ACTUATORS, ...INLINE, ...INSTRUMENTS, ...CONNECTORS, ...EQUIPMENT];

export const CATEGORY_LABELS: Record<string, string> = {
  valve: "Valves",
  regulator: "Regulators",
  actuator: "Actuators",
  inline: "Inline components",
  instrument: "Instruments",
  connector: "Terminators and connectors",
  equipment: "Equipment",
  custom: "Custom symbols"
};

export const CATEGORY_ORDER = ["valve", "regulator", "actuator", "inline", "instrument", "connector", "equipment", "custom"];
