/**
 * Swagelok tube fitting catalog, built offline from Swagelok's published
 * ordering-number system (material prefix, tube size code, fitting type code,
 * end-connection size and thread suffix), so a fitting can be found from a
 * plain description ("3/8 tube to 1/4 male NPT elbow") or an ordering number
 * ("SS-600-2-4") without a live connection to swagelok.com.
 *
 * Every configuration is generated from the ordering rules, not read from a
 * stock list: a combination can be valid by the rules and still not be a
 * standard product. Pressure ratings of Swagelok tube fittings are set by the
 * tubing they are installed on, so no pressure value is invented here; the
 * reference temperatures are flagged as such in the specs.
 */

export type MaterialCode = "SS" | "B" | "S" | "M" | "HC" | "A";
export type ThreadStd = "NPT" | "ISO_T" | "ISO_P";
export type Gender = "male" | "female";
export type Shape = "straight" | "elbow" | "tee" | "cross" | "cap" | "plug" | "nut" | "ferrule" | "ferrule-set";
/** End types, as drawn and described: Swagelok tube fitting end, male or female thread, or a plain tube stub. */
export type ArmType = "tube" | "male" | "female" | "stub";

export type KindId =
  | "union"
  | "reducing_union"
  | "union_elbow"
  | "union_tee"
  | "union_cross"
  | "bulkhead_union"
  | "male_connector"
  | "female_connector"
  | "male_elbow"
  | "female_elbow"
  | "male_branch_tee"
  | "male_run_tee"
  | "female_branch_tee"
  | "female_run_tee"
  | "bulkhead_male_connector"
  | "bulkhead_female_connector"
  | "tube_adapter_male"
  | "tube_adapter_female"
  | "reducer"
  | "port_connector"
  | "cap"
  | "plug"
  | "nut"
  | "front_ferrule"
  | "back_ferrule"
  | "ferrule_set";

export type Material = {
  code: MaterialCode;
  /** Name used in Swagelok-style descriptions ("Stainless Steel Swagelok Tube Fitting, ..."). */
  title: string;
  /** Short name for tables and the catalog `material` field. */
  short: string;
  /** Reference maximum service temperature of the fitting body, when known. */
  maxTempC?: number;
  maxTempF?: number;
};

export type TubeSize = {
  id: string;
  system: "fractional" | "metric";
  /** "1/4 in." or "6 mm". */
  label: string;
  /** Size code in fitting bodies: "400", "810", "6M0". */
  code: string;
  /** Short code for a second end or a tube stub: "4", "8", "6M". */
  short: string;
  odMm: number;
  odIn: number;
};

export type PipeSize = { id: string; label: string; code: string; inches: number };

export type FittingConfig = {
  kind: KindId;
  material: MaterialCode;
  tube: string;
  /** Second tube size: the small end of a reducing union, the stub of a reducer. */
  tube2?: string;
  pipe?: string;
  thread?: ThreadStd;
};

export type FittingEnd = { type: ArmType; label: string; bulkhead?: boolean };
export type SpecRow = { label: string; value: string; note?: string };

export type Fitting = {
  config: FittingConfig;
  kind: KindDef;
  material: Material;
  tube: TubeSize;
  tube2?: TubeSize;
  pipe?: PipeSize;
  thread?: ThreadStd;
  partNumber: string;
  description: string;
  /** Ends in drawing order: left, right, up, down (straight: left/right, elbow: left/up, tee: left/right/up). */
  ends: FittingEnd[];
  specs: SpecRow[];
  productUrl: string;
};

/* ---------- Reference data ---------- */

export const MATERIALS: Material[] = [
  { code: "SS", title: "Stainless Steel", short: "316 SS", maxTempC: 649, maxTempF: 1200 },
  { code: "B", title: "Brass", short: "Brass", maxTempC: 204, maxTempF: 400 },
  { code: "S", title: "Carbon Steel", short: "Carbon steel", maxTempC: 191, maxTempF: 375 },
  { code: "M", title: "Alloy 400", short: "Alloy 400" },
  { code: "HC", title: "Alloy C-276", short: "Alloy C-276" },
  { code: "A", title: "Aluminum", short: "Aluminum", maxTempC: 204, maxTempF: 400 }
];

const FRACTIONAL: Array<[label: string, sixteenths: number, code: string]> = [
  ["1/16", 1, "100"],
  ["1/8", 2, "200"],
  ["3/16", 3, "300"],
  ["1/4", 4, "400"],
  ["5/16", 5, "500"],
  ["3/8", 6, "600"],
  ["1/2", 8, "810"],
  ["5/8", 10, "1010"],
  ["3/4", 12, "1210"],
  ["7/8", 14, "1410"],
  ["1", 16, "1610"]
];

const METRIC_MM = [2, 3, 4, 6, 8, 10, 12, 14, 15, 16, 18, 20, 22, 25];

export const TUBE_SIZES: TubeSize[] = [
  ...FRACTIONAL.map(([label, sixteenths, code]) => ({
    id: `${label}in`,
    system: "fractional" as const,
    label: `${label} in.`,
    code,
    short: String(sixteenths),
    odIn: sixteenths / 16,
    odMm: Math.round(sixteenths * 25.4 * 100 / 16) / 100
  })),
  ...METRIC_MM.map((mm) => ({
    id: `${mm}mm`,
    system: "metric" as const,
    label: `${mm} mm`,
    code: `${mm}M0`,
    short: `${mm}M`,
    odMm: mm,
    odIn: mm / 25.4
  }))
];

export const PIPE_SIZES: PipeSize[] = [
  ["1/16", "1", 1 / 16],
  ["1/8", "2", 1 / 8],
  ["1/4", "4", 1 / 4],
  ["3/8", "6", 3 / 8],
  ["1/2", "8", 1 / 2],
  ["3/4", "12", 3 / 4],
  ["1", "16", 1]
].map(([label, code, inches]) => ({ id: `${label}in`, label: `${label} in.`, code: String(code), inches: Number(inches) }));

export const THREADS: Record<ThreadStd, { label: string; standard: string; male: string | null; female: string | null }> = {
  NPT: { label: "NPT", standard: "ASME B1.20.1 tapered pipe thread", male: "", female: "" },
  ISO_T: { label: "ISO tapered (BSPT)", standard: "ISO 7 tapered thread", male: "RT", female: "RT" },
  // Only the female parallel (gauge) thread has a confirmed suffix; male parallel threads are not offered.
  ISO_P: { label: "ISO parallel (BSPP)", standard: "ISO 228 parallel thread", male: null, female: "RG" }
};

/** Sizes offered when a description names no tube size. */
const COMMON_TUBES = ["1/8in", "1/4in", "3/8in", "1/2in", "3/4in", "1in", "6mm", "10mm", "12mm"];

export type KindDef = {
  id: KindId;
  label: string;
  shape: Shape;
  /** End types in drawing order (see `Fitting.ends`). */
  arms: ArmType[];
  bulkhead?: boolean;
  /** The thread end, if the kind has one. */
  pipe?: Gender;
  /** What the second tube size is: the second fitting end or a tube stub. */
  tube2?: "fitting" | "stub";
  fractionalOnly?: boolean;
  /** Ordering number. */
  pn: (parts: { m: string; t: TubeSize; t2?: TubeSize; p?: PipeSize; suffix: string }) => string;
};

const swap = (code: string, last: string) => code.slice(0, -1) + last;

export const KINDS: KindDef[] = [
  { id: "union", label: "Union", shape: "straight", arms: ["tube", "tube"], pn: ({ m, t }) => `${m}-${t.code}-6` },
  {
    id: "reducing_union",
    label: "Reducing Union",
    shape: "straight",
    arms: ["tube", "tube"],
    tube2: "fitting",
    pn: ({ m, t, t2 }) => `${m}-${t.code}-6-${t2?.short}`
  },
  { id: "union_elbow", label: "Union Elbow", shape: "elbow", arms: ["tube", "tube"], pn: ({ m, t }) => `${m}-${t.code}-9` },
  { id: "union_tee", label: "Union Tee", shape: "tee", arms: ["tube", "tube", "tube"], pn: ({ m, t }) => `${m}-${t.code}-3` },
  { id: "union_cross", label: "Union Cross", shape: "cross", arms: ["tube", "tube", "tube", "tube"], pn: ({ m, t }) => `${m}-${t.code}-4` },
  { id: "bulkhead_union", label: "Bulkhead Union", shape: "straight", arms: ["tube", "tube"], bulkhead: true, pn: ({ m, t }) => `${m}-${t.code}-61` },
  {
    id: "male_connector",
    label: "Male Connector",
    shape: "straight",
    arms: ["tube", "male"],
    pipe: "male",
    pn: ({ m, t, p, suffix }) => `${m}-${t.code}-1-${p?.code}${suffix}`
  },
  {
    id: "female_connector",
    label: "Female Connector",
    shape: "straight",
    arms: ["tube", "female"],
    pipe: "female",
    pn: ({ m, t, p, suffix }) => `${m}-${t.code}-7-${p?.code}${suffix}`
  },
  {
    id: "male_elbow",
    label: "Male Elbow",
    shape: "elbow",
    arms: ["tube", "male"],
    pipe: "male",
    pn: ({ m, t, p, suffix }) => `${m}-${t.code}-2-${p?.code}${suffix}`
  },
  {
    id: "female_elbow",
    label: "Female Elbow",
    shape: "elbow",
    arms: ["tube", "female"],
    pipe: "female",
    pn: ({ m, t, p, suffix }) => `${m}-${t.code}-8-${p?.code}${suffix}`
  },
  {
    id: "male_branch_tee",
    label: "Male Branch Tee",
    shape: "tee",
    arms: ["tube", "tube", "male"],
    pipe: "male",
    pn: ({ m, t, p, suffix }) => `${m}-${t.code}-3-${p?.code}${suffix}TTM`
  },
  {
    id: "male_run_tee",
    label: "Male Run Tee",
    shape: "tee",
    arms: ["tube", "male", "tube"],
    pipe: "male",
    pn: ({ m, t, p, suffix }) => `${m}-${t.code}-3-${p?.code}${suffix}TMT`
  },
  {
    id: "female_branch_tee",
    label: "Female Branch Tee",
    shape: "tee",
    arms: ["tube", "tube", "female"],
    pipe: "female",
    pn: ({ m, t, p, suffix }) => `${m}-${t.code}-3-${p?.code}${suffix}TTF`
  },
  {
    id: "female_run_tee",
    label: "Female Run Tee",
    shape: "tee",
    arms: ["tube", "female", "tube"],
    pipe: "female",
    pn: ({ m, t, p, suffix }) => `${m}-${t.code}-3-${p?.code}${suffix}TFT`
  },
  {
    id: "bulkhead_male_connector",
    label: "Bulkhead Male Connector",
    shape: "straight",
    arms: ["tube", "male"],
    bulkhead: true,
    pipe: "male",
    pn: ({ m, t, p, suffix }) => `${m}-${t.code}-11-${p?.code}${suffix}`
  },
  {
    id: "bulkhead_female_connector",
    label: "Bulkhead Female Connector",
    shape: "straight",
    arms: ["tube", "female"],
    bulkhead: true,
    pipe: "female",
    pn: ({ m, t, p, suffix }) => `${m}-${t.code}-71-${p?.code}${suffix}`
  },
  {
    id: "tube_adapter_male",
    label: "Male Tube Adapter",
    shape: "straight",
    arms: ["stub", "male"],
    pipe: "male",
    fractionalOnly: true,
    pn: ({ m, t, p, suffix }) => `${m}-${t.short}-TA-1-${p?.code}${suffix}`
  },
  {
    id: "tube_adapter_female",
    label: "Female Tube Adapter",
    shape: "straight",
    arms: ["stub", "female"],
    pipe: "female",
    fractionalOnly: true,
    pn: ({ m, t, p, suffix }) => `${m}-${t.short}-TA-7-${p?.code}${suffix}`
  },
  {
    id: "reducer",
    label: "Reducer",
    shape: "straight",
    arms: ["tube", "stub"],
    tube2: "stub",
    pn: ({ m, t, t2 }) => `${m}-${t.code}-R-${t2?.short}`
  },
  { id: "port_connector", label: "Port Connector", shape: "straight", arms: ["stub", "stub"], pn: ({ m, t }) => `${m}-${t.code}-PC` },
  { id: "cap", label: "Cap", shape: "cap", arms: ["tube"], pn: ({ m, t }) => `${m}-${t.code}-C` },
  { id: "plug", label: "Plug", shape: "plug", arms: ["stub"], pn: ({ m, t }) => `${m}-${t.code}-P` },
  { id: "nut", label: "Nut", shape: "nut", arms: [], pn: ({ m, t }) => `${m}-${swap(t.code, "2")}-1` },
  { id: "front_ferrule", label: "Front Ferrule", shape: "ferrule", arms: [], pn: ({ m, t }) => `${m}-${swap(t.code, "3")}-1` },
  { id: "back_ferrule", label: "Back Ferrule", shape: "ferrule", arms: [], pn: ({ m, t }) => `${m}-${swap(t.code, "4")}-1` },
  { id: "ferrule_set", label: "Ferrule Set", shape: "ferrule-set", arms: [], pn: ({ m, t }) => `${m}-${t.code}-SET` }
];

const KIND_BY_ID = new Map(KINDS.map((kind) => [kind.id, kind]));
const MATERIAL_BY_CODE = new Map(MATERIALS.map((material) => [material.code, material]));
const TUBE_BY_ID = new Map(TUBE_SIZES.map((tube) => [tube.id, tube]));
const PIPE_BY_ID = new Map(PIPE_SIZES.map((pipe) => [pipe.id, pipe]));

export const kindById = (id: KindId): KindDef => KIND_BY_ID.get(id) ?? KINDS[0];
export const materialByCode = (code: string): Material | undefined => MATERIAL_BY_CODE.get(code as MaterialCode);
export const tubeById = (id: string | undefined): TubeSize | undefined => (id ? TUBE_BY_ID.get(id) : undefined);
export const pipeById = (id: string | undefined): PipeSize | undefined => (id ? PIPE_BY_ID.get(id) : undefined);

/* ---------- Valid combinations ---------- */

/** Thread sizes that pair with a tube size: from half to about twice the tube OD. */
export function pipeOptions(tube: TubeSize): PipeSize[] {
  return PIPE_SIZES.filter((pipe) => {
    const ratio = pipe.inches / tube.odIn;
    return ratio >= 0.45 && ratio <= 2.1;
  });
}

/** Second tube sizes for a reducing union (smaller) or a reducer (either way), same size system. */
export function secondTubeOptions(kind: KindDef, tube: TubeSize): TubeSize[] {
  if (!kind.tube2) return [];
  return TUBE_SIZES.filter((other) => {
    if (other.system !== tube.system || other.id === tube.id) return false;
    const ratio = other.odIn / tube.odIn;
    return kind.tube2 === "fitting" ? ratio < 1 && ratio >= 0.2 : ratio >= 0.33 && ratio <= 3;
  });
}

export function tubeOptions(kind: KindDef): TubeSize[] {
  return kind.fractionalOnly ? TUBE_SIZES.filter((tube) => tube.system === "fractional") : TUBE_SIZES;
}

export function threadOptions(kind: KindDef): ThreadStd[] {
  if (!kind.pipe) return [];
  const gender = kind.pipe;
  return (Object.keys(THREADS) as ThreadStd[]).filter((std) => THREADS[std][gender] !== null);
}

/**
 * Bring a configuration back into the valid set after one field changed:
 * keep what still fits, otherwise pick the nearest valid value.
 */
export function normalizeConfig(config: FittingConfig): FittingConfig {
  const kind = kindById(config.kind);
  const tubes = tubeOptions(kind);
  const tube = tubes.find((option) => option.id === config.tube) ?? tubes.find((option) => option.id === "1/4in") ?? tubes[0];
  const next: FittingConfig = { kind: kind.id, material: materialByCode(config.material)?.code ?? "SS", tube: tube.id };
  if (kind.tube2) {
    const options = secondTubeOptions(kind, tube);
    const current = options.find((option) => option.id === config.tube2);
    next.tube2 = (current ?? nearestTube(options, tube.odIn * 0.6))?.id;
  }
  if (kind.pipe) {
    const options = pipeOptions(tube);
    const current = options.find((option) => option.id === config.pipe);
    next.pipe = (current ?? nearestPipe(options, tube.odIn))?.id;
    const threads = threadOptions(kind);
    next.thread = config.thread && threads.includes(config.thread) ? config.thread : threads[0];
  }
  return next;
}

function nearestTube(options: TubeSize[], odIn: number): TubeSize | undefined {
  return [...options].sort((a, b) => Math.abs(a.odIn - odIn) - Math.abs(b.odIn - odIn))[0];
}

function nearestPipe(options: PipeSize[], inches: number): PipeSize | undefined {
  // Prefer the same nominal size, then the smaller of two equally close sizes.
  return [...options].sort((a, b) => Math.abs(a.inches - inches) - Math.abs(b.inches - inches) || a.inches - b.inches)[0];
}

function isValid(config: FittingConfig): boolean {
  const kind = KIND_BY_ID.get(config.kind);
  const tube = tubeById(config.tube);
  if (!kind || !tube || !MATERIAL_BY_CODE.has(config.material)) return false;
  if (kind.fractionalOnly && tube.system !== "fractional") return false;
  if (kind.tube2 && !secondTubeOptions(kind, tube).some((option) => option.id === config.tube2)) return false;
  if (kind.pipe) {
    if (!pipeOptions(tube).some((option) => option.id === config.pipe)) return false;
    if (!config.thread || !threadOptions(kind).includes(config.thread)) return false;
  }
  return true;
}

/* ---------- Building a fitting ---------- */

const PRODUCT_URL = "https://products.swagelok.com/en/c/straights/p/";

function threadText(gender: Gender, thread: ThreadStd): string {
  const g = gender === "male" ? "Male" : "Female";
  if (thread === "NPT") return `${g} NPT`;
  if (thread === "ISO_T") return `${g} ISO Tapered Thread`;
  return `${g} ISO Parallel Thread`;
}

function sizeText(kind: KindDef, tube: TubeSize, tube2?: TubeSize, pipe?: PipeSize, thread?: ThreadStd): string {
  if (kind.pipe && pipe && thread) return `${tube.label} Tube OD x ${pipe.label} ${threadText(kind.pipe, thread)}`;
  if (tube2) return `${tube.label} x ${tube2.label} Tube OD`;
  return `${tube.label} Tube OD`;
}

function endLabel(type: ArmType, tube: TubeSize, pipe?: PipeSize, thread?: ThreadStd, gender?: Gender): string {
  if (type === "tube") return `${tube.label} Swagelok tube fitting`;
  if (type === "stub") return `${tube.label} tube stub`;
  return `${pipe?.label ?? ""} ${threadText(gender ?? (type as Gender), thread ?? "NPT")}`.trim();
}

function turnsFromFingerTight(tube: TubeSize): string {
  return tube.odIn <= 3 / 16 + 1e-6 ? "3/4 turn" : "1-1/4 turns";
}

/** Build the fitting for a configuration; returns null when the combination breaks the ordering rules. */
export function buildFitting(config: FittingConfig): Fitting | null {
  if (!isValid(config)) return null;
  const kind = kindById(config.kind);
  const material = materialByCode(config.material) as Material;
  const tube = tubeById(config.tube) as TubeSize;
  const tube2 = kind.tube2 ? tubeById(config.tube2) : undefined;
  const pipe = kind.pipe ? pipeById(config.pipe) : undefined;
  const thread = kind.pipe ? config.thread : undefined;
  const suffix = kind.pipe && thread ? (THREADS[thread][kind.pipe] ?? "") : "";
  const partNumber = kind.pn({ m: material.code, t: tube, t2: tube2, p: pipe, suffix });

  const component = kind.shape === "nut" || kind.shape === "ferrule" || kind.shape === "ferrule-set";
  let description: string;
  if (kind.id === "ferrule_set") {
    description = `${material.title} Ferrule Set (1 Front Ferrule / 1 Back Ferrule) for ${tube.label} Tube OD`;
  } else if (component) {
    description = `${material.title} ${kind.label} for ${tube.label} Swagelok Tube Fitting`;
  } else {
    description = `${material.title} Swagelok Tube Fitting, ${kind.label}, ${sizeText(kind, tube, tube2, pipe, thread)}`;
  }

  const ends: FittingEnd[] = kind.arms.map((type, index) => {
    // The second tube size belongs to the second end of a reducing union / reducer.
    const size = tube2 && index === 1 ? tube2 : tube;
    return {
      type,
      label: endLabel(type, size, pipe, thread, type === "male" || type === "female" ? type : undefined),
      bulkhead: kind.bulkhead && index === 0 ? true : undefined
    };
  });

  const specs: SpecRow[] = [
    { label: "Ordering number", value: partNumber },
    { label: "Product", value: component ? `Swagelok tube fitting component — ${kind.label}` : `Swagelok tube fitting — ${kind.label}` },
    { label: "Body material", value: material.code === "SS" ? "316 stainless steel" : material.title }
  ];
  if (!component) {
    specs.push({ label: "Configuration", value: SHAPE_TEXT[kind.shape] + (kind.bulkhead ? ", bulkhead" : "") });
    specs.push({ label: "End connections", value: ends.map((end, index) => `${index + 1}: ${end.label}`).join(" · ") });
  }
  specs.push({
    label: "Tube OD",
    value: tube2
      ? `${tube.label} (${formatMm(tube.odMm)}) × ${tube2.label} (${formatMm(tube2.odMm)})`
      : `${tube.label} (${formatMm(tube.odMm)}${tube.system === "metric" ? `, ${tube.odIn.toFixed(3)} in.` : ""})`
  });
  if (pipe && thread && kind.pipe) {
    specs.push({ label: "Thread", value: `${pipe.label} ${threadText(kind.pipe, thread)}`, note: THREADS[thread].standard });
  }
  specs.push({
    label: "Pressure rating",
    value: "Rated to the tubing",
    note: kind.pipe
      ? "Tube end: set by tubing material, OD and wall (Swagelok Tubing Data, MS-01-181). Threaded end: see the Swagelok pipe-thread ratings; the lower value governs."
      : "Set by tubing material, OD and wall thickness (Swagelok Tubing Data, MS-01-181)."
  });
  specs.push({
    label: "Max temperature",
    value: material.maxTempC != null ? `${material.maxTempC} °C (${material.maxTempF} °F)` : "See Swagelok catalog",
    note: material.maxTempC != null ? "Reference value; pressure derates at elevated temperature." : undefined
  });
  if (kind.arms.includes("tube") || component) {
    specs.push({
      label: "Installation",
      value: `${turnsFromFingerTight(tube)} from finger-tight`,
      note: "Check initial make-up with a Swagelok gap inspection gauge."
    });
  }
  if (kind.arms.includes("tube") && !component) {
    specs.push({ label: "Supplied", value: kind.bulkhead ? "Assembled with nuts and ferrules, and a bulkhead retaining nut" : "Assembled with nuts and ferrules" });
  }
  if (kind.arms.includes("stub")) {
    specs.push({ label: "Tube stub", value: `Inserts into a ${(tube2 ?? tube).label} Swagelok tube fitting like tubing` });
  }

  return {
    config: normalizedShape(config, kind),
    kind,
    material,
    tube,
    tube2,
    pipe,
    thread,
    partNumber,
    description,
    ends,
    specs,
    productUrl: `${PRODUCT_URL}${encodeURIComponent(partNumber)}`
  };
}

/** Drop fields the kind does not use, so equal fittings have equal configs. */
function normalizedShape(config: FittingConfig, kind: KindDef): FittingConfig {
  const next: FittingConfig = { kind: config.kind, material: config.material, tube: config.tube };
  if (kind.tube2) next.tube2 = config.tube2;
  if (kind.pipe) {
    next.pipe = config.pipe;
    next.thread = config.thread;
  }
  return next;
}

const SHAPE_TEXT: Record<Shape, string> = {
  straight: "Straight",
  elbow: "90° elbow",
  tee: "Tee",
  cross: "Cross",
  cap: "Cap (closes a tube fitting end)",
  plug: "Plug (closes a tube fitting port)",
  nut: "Nut",
  ferrule: "Ferrule",
  "ferrule-set": "Ferrule set"
};

function formatMm(mm: number): string {
  return `${Number.isInteger(mm) ? mm : mm.toFixed(2)} mm`;
}

/* ---------- Every configuration (for ordering-number lookup) ---------- */

const allConfigCache = new Map<MaterialCode, Fitting[]>();

/** Every valid configuration in one material. Built once per material on first lookup. */
export function allFittings(material: MaterialCode): Fitting[] {
  const cached = allConfigCache.get(material);
  if (cached) return cached;
  const out: Fitting[] = [];
  for (const kind of KINDS) {
    for (const tube of tubeOptions(kind)) {
      const seconds = kind.tube2 ? secondTubeOptions(kind, tube) : [undefined];
      const pipes = kind.pipe ? pipeOptions(tube) : [undefined];
      const threads = kind.pipe ? threadOptions(kind) : [undefined];
      for (const tube2 of seconds) {
        for (const pipe of pipes) {
          for (const thread of threads) {
            const fitting = buildFitting({ kind: kind.id, material, tube: tube.id, tube2: tube2?.id, pipe: pipe?.id, thread });
            if (fitting) out.push(fitting);
          }
        }
      }
    }
  }
  allConfigCache.set(material, out);
  return out;
}

/* ---------- Understanding a description ---------- */

export type ParsedQuery = {
  text: string;
  partNumber?: string;
  material?: MaterialCode;
  tubes: TubeSize[];
  pipe?: PipeSize;
  gender?: Gender;
  thread?: ThreadStd;
  kinds: KindId[];
  /** Things the parser could not use, shown to the user. */
  warnings: string[];
};

const UNICODE_FRACTIONS: Record<string, string> = {
  "½": " 1/2",
  "¼": " 1/4",
  "¾": " 3/4",
  "⅛": " 1/8",
  "⅜": " 3/8",
  "⅝": " 5/8",
  "⅞": " 7/8"
};

const MATERIAL_PATTERNS: Array<[RegExp, MaterialCode]> = [
  [/\b(?:alloy\s*c-?276|c-?276|hastelloy)\b/, "HC"],
  [/\b(?:alloy\s*400|monel)\b/, "M"],
  [/\b(?:stainless(?:\s*steel)?|316l?|ss|inox)\b/, "SS"],
  [/\b(?:carbon\s*steel|carbon|cs|steel)\b/, "S"],
  [/\b(?:brass)\b/, "B"],
  [/\b(?:alumin(?:i)?um|alu)\b/, "A"]
];

const PN_PATTERN = /^[a-z]{1,3}-[0-9a-z]+(?:-[0-9a-z]+)*-?$/i;

function fractionValue(text: string): number {
  const cleaned = text.replace(/\s+/g, "");
  const mixed = /^(\d+)-(\d+)\/(\d+)$/.exec(cleaned);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const fraction = /^(\d+)\/(\d+)$/.exec(cleaned);
  if (fraction) return Number(fraction[1]) / Number(fraction[2]);
  return Number(cleaned);
}

function tubeForValue(value: number, unit: string, raw: string): TubeSize | undefined {
  const isMm = unit === "mm" || (!unit && /^\d+$/.test(raw) && value >= 2 && METRIC_MM.includes(value));
  if (isMm) return TUBE_SIZES.find((tube) => tube.system === "metric" && Math.abs(tube.odMm - value) < 1e-6);
  return TUBE_SIZES.find((tube) => tube.system === "fractional" && Math.abs(tube.odIn - value) < 1e-6);
}

/** Read a free-text fitting description into structured search terms. */
export function parseQuery(input: string): ParsedQuery {
  const text = input.trim();
  const query: ParsedQuery = { text, tubes: [], kinds: [], warnings: [] };
  if (!text) return query;
  if (PN_PATTERN.test(text) && /\d/.test(text)) {
    query.partNumber = text.toUpperCase();
    return query;
  }

  let s = ` ${text.toLowerCase()} `
    .replace(/[½¼¾⅛⅜⅝⅞]/g, (char) => UNICODE_FRACTIONS[char])
    .replace(/[“”″]/g, '"')
    .replace(/(\d)\s*[x×*]\s*(?=\d)/g, "$1 x ")
    .replace(/(\s)(\d+)\s+(\d+\/\d+)/g, "$1$2-$3");

  for (const [pattern, code] of MATERIAL_PATTERNS) {
    if (pattern.test(s)) {
      query.material = code;
      s = s.replace(pattern, " ");
      break;
    }
  }

  if (/\b(?:female|fnpt|fpt|internal)\b/.test(s)) query.gender = "female";
  else if (/\b(?:male|mnpt|mpt|external)\b/.test(s)) query.gender = "male";

  if (/\b(?:bspp|parallel|iso\s*228|g\s*thread)\b/.test(s)) query.thread = "ISO_P";
  else if (/\b(?:bspt|bsp|iso(?:\s*7)?|tapered\s*iso|r\s*thread)\b/.test(s)) query.thread = "ISO_T";
  else if (/\b(?:[mf]?npt|nptf|[mf]pt|pipe\s*thread)\b/.test(s)) query.thread = "NPT";

  // Sizes: a size followed (or preceded) by a thread word is a thread size; the rest are tube sizes.
  const sizePattern = /(\d+-\d+\/\d+|\d+\/\d+|\d*\.\d+|\d+)\s*(mm|in\.?|inch(?:es)?|")?/g;
  for (const match of s.matchAll(sizePattern)) {
    const raw = match[1];
    const unit = (match[2] ?? "").startsWith("mm") ? "mm" : match[2] ? "in" : "";
    const value = fractionValue(raw);
    if (!Number.isFinite(value) || value <= 0) continue;
    const start = match.index ?? 0;
    const after = s.slice(start + match[0].length, start + match[0].length + 18);
    const before = s.slice(Math.max(0, start - 14), start);
    // "90° elbow", "45 deg": angles, not sizes.
    if (/^\s*(?:°|deg)/.test(after) || ((raw === "90" || raw === "45") && !unit)) continue;
    const threadAfter = /^\s*(?:[mf]?npt|nptf|[mf]pt|bsp[tp]?|iso|pipe|thread|male\s+(?:npt|iso|bsp|pipe|thread)|female\s+(?:npt|iso|bsp|pipe|thread)|m\b|f\b)/.test(after);
    const threadBefore = /(?:[mf]?npt|bsp[tp]?|thread|pipe)\s*$/.test(before);
    if ((threadAfter || threadBefore) && unit !== "mm") {
      const pipe = PIPE_SIZES.find((option) => Math.abs(option.inches - value) < 1e-6);
      if (pipe && !query.pipe) query.pipe = pipe;
      else if (!pipe) query.warnings.push(`No thread size ${raw} in.`);
      continue;
    }
    const tube = tubeForValue(value, unit, raw);
    if (tube) {
      if (!query.tubes.some((existing) => existing.id === tube.id)) query.tubes.push(tube);
    } else {
      query.warnings.push(`No Swagelok tube size ${raw}${unit === "mm" ? " mm" : unit ? " in." : ""}`);
    }
  }
  if (query.pipe && !query.thread) query.thread = "NPT";

  query.kinds = kindsFor(s, query);
  return query;
}

function kindsFor(s: string, query: ParsedQuery): KindId[] {
  const has = (pattern: RegExp) => pattern.test(s);
  const threaded = Boolean(query.pipe || query.thread || query.gender);
  const genders: Gender[] = query.gender ? [query.gender] : ["male", "female"];
  const byGender = (male: KindId, female: KindId): KindId[] => genders.map((gender) => (gender === "male" ? male : female));
  const twoTubes = query.tubes.length >= 2;
  const kinds: KindId[] = [];
  const add = (...ids: KindId[]) => ids.forEach((id) => !kinds.includes(id) && kinds.push(id));

  if (has(/\bferrule\s*set|\bferrules\b|\bset\b/)) add("ferrule_set");
  if (has(/\bfront\s*ferrule/)) add("front_ferrule");
  if (has(/\b(?:back|rear)\s*ferrule/)) add("back_ferrule");
  if (has(/\bferrule\b/) && !kinds.length) add("ferrule_set", "front_ferrule", "back_ferrule");
  if (has(/\bnuts?\b/)) add("nut");
  if (has(/\bcaps?\b/)) add("cap");
  if (has(/\bplugs?\b/)) add("plug");
  if (has(/\bport\s*connector/)) add("port_connector");
  if (has(/\btube\s*adapt[eo]r/) || (has(/\badapt[eo]r\b/) && has(/\bstub\b/))) add(...byGender("tube_adapter_male", "tube_adapter_female"));
  if (has(/\breduc(?:ing|er)\s*union\b/)) add("reducing_union");
  if (has(/\bcross\b/)) add("union_cross");

  if (has(/\bbulkhead\b/)) {
    if (threaded) add(...byGender("bulkhead_male_connector", "bulkhead_female_connector"));
    else add("bulkhead_union", "bulkhead_male_connector", "bulkhead_female_connector");
  }
  if (has(/\b(?:elbow|ell|90)\b/)) {
    if (threaded) add(...byGender("male_elbow", "female_elbow"));
    else add("union_elbow", "male_elbow", "female_elbow");
  }
  if (has(/\btees?\b/)) {
    const run = has(/\brun\b/);
    const branch = has(/\bbranch\b/);
    if (threaded) {
      for (const gender of genders) {
        if (!run) add(gender === "male" ? "male_branch_tee" : "female_branch_tee");
        if (!branch) add(gender === "male" ? "male_run_tee" : "female_run_tee");
      }
    } else add("union_tee", "male_branch_tee", "female_branch_tee");
  }
  if (has(/\breducer\b/) && !has(/\breducer\s*union\b/)) add("reducer", "reducing_union");
  if (has(/\bunion\b/) && !kinds.length) add(twoTubes ? "reducing_union" : "union");
  if (has(/\b(?:connector|adapt[eo]r|fitting|straight|coupling|to)\b/) && !kinds.length) {
    if (threaded) add(...byGender("male_connector", "female_connector"));
    else if (twoTubes) add("reducing_union", "reducer");
    else add("union");
  }
  if (!kinds.length) {
    if (threaded) add(...byGender("male_connector", "female_connector"), ...byGender("male_elbow", "female_elbow"));
    else if (twoTubes) add("reducing_union", "reducer");
  }
  return kinds;
}

/* ---------- Search ---------- */

export type SearchResult = {
  query: ParsedQuery;
  results: Fitting[];
  /** Why there are no results, or a hint about how the description was read. */
  message?: string;
};

/** Find fittings for a description or an ordering number (best match first). */
export function searchFittings(input: string, limit = 48): SearchResult {
  const query = parseQuery(input);
  if (!query.text) return { query, results: [] };

  if (query.partNumber) {
    const prefix = query.partNumber.split("-")[0];
    const material = materialByCode(prefix);
    if (!material) {
      return { query, results: [], message: `"${prefix}" is not a Swagelok material prefix (try SS, B, S, M, HC or A).` };
    }
    const wanted = query.partNumber.replace(/-$/, "");
    const matches = allFittings(material.code)
      .filter((fitting) => fitting.partNumber.startsWith(wanted))
      .sort((a, b) => Number(b.partNumber === wanted) - Number(a.partNumber === wanted) || a.partNumber.length - b.partNumber.length);
    return {
      query,
      results: matches.slice(0, limit),
      message: matches.length ? undefined : `No tube fitting matches ${wanted} under the ordering rules this selector knows.`
    };
  }

  const kinds = query.kinds.length ? query.kinds.map(kindById) : query.tubes.length ? DEFAULT_KINDS.map(kindById) : [];
  if (!kinds.length) {
    return {
      query,
      results: [],
      message: "Name a fitting type (union, elbow, tee, male connector, cap…) or a size, or paste an ordering number."
    };
  }
  const material = query.material ?? "SS";
  const tubes = query.tubes.length ? [query.tubes[0]] : COMMON_TUBES.map((id) => tubeById(id) as TubeSize);
  const results: Fitting[] = [];
  const seen = new Set<string>();
  for (const kind of kinds) {
    for (const tube of tubes) {
      if (kind.fractionalOnly && tube.system !== "fractional") continue;
      const seconds = kind.tube2
        ? query.tubes[1]
          ? [query.tubes[1]]
          : secondTubeOptions(kind, tube)
        : [undefined];
      const pipes = kind.pipe ? (query.pipe ? [query.pipe] : rankedPipes(tube)) : [undefined];
      const threads: Array<ThreadStd | undefined> = kind.pipe
        ? [query.thread && threadOptions(kind).includes(query.thread) ? query.thread : kind.pipe === "male" && query.thread === "ISO_P" ? "ISO_T" : "NPT"]
        : [undefined];
      for (const tube2 of seconds) {
        for (const pipe of pipes) {
          for (const thread of threads) {
            const fitting = buildFitting({ kind: kind.id, material, tube: tube.id, tube2: tube2?.id, pipe: pipe?.id, thread });
            if (fitting && !seen.has(fitting.partNumber)) {
              seen.add(fitting.partNumber);
              results.push(fitting);
            }
          }
        }
      }
    }
  }
  let message: string | undefined;
  if (!results.length) {
    message = query.tubes[0]
      ? `No ${kinds.map((kind) => kind.label.toLowerCase()).join(" / ")} for ${query.tubes[0].label} tube${query.pipe ? ` with a ${query.pipe.label} thread` : ""} under the ordering rules.`
      : "No fitting matches that description.";
  }
  return { query, results: results.slice(0, limit), message };
}

/** Kinds offered when only a size was given. */
const DEFAULT_KINDS: KindId[] = ["union", "union_elbow", "union_tee", "male_connector", "female_connector", "male_elbow", "cap", "plug"];

/** Thread sizes for a tube, the same nominal size first. */
function rankedPipes(tube: TubeSize): PipeSize[] {
  return [...pipeOptions(tube)].sort(
    (a, b) => Math.abs(a.inches - tube.odIn) - Math.abs(b.inches - tube.odIn) || a.inches - b.inches
  );
}

/** One-line summary of how a description was read ("Male elbow · 3/8 in. tube · 1/4 in. NPT · 316 SS"). */
export function describeQuery(query: ParsedQuery): string[] {
  if (query.partNumber) return [`Ordering number ${query.partNumber}`];
  const chips: string[] = [];
  if (query.kinds.length) chips.push(query.kinds.map((id) => kindById(id).label).join(" / "));
  if (query.tubes[0]) chips.push(`${query.tubes[0].label} tube`);
  if (query.tubes[1]) chips.push(`× ${query.tubes[1].label}`);
  if (query.pipe) chips.push(`${query.pipe.label} ${query.thread ? THREADS[query.thread].label : "thread"}`);
  else if (query.thread) chips.push(THREADS[query.thread].label);
  if (query.gender && !query.kinds.length) chips.push(query.gender);
  chips.push(materialByCode(query.material ?? "SS")?.short ?? "316 SS");
  return chips;
}
