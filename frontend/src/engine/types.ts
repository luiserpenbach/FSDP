/**
 * Schematic document schema (version 1).
 *
 * This is the source of truth for a P&ID sheet. Everything is in paper-space
 * millimetres: item positions, line vertices, symbol geometry, text sizes.
 * The React canvas and the export pipeline both render this document with the
 * same renderer (`render.ts`), so what is edited is what prints.
 *
 * Design rules:
 *  - Connectivity is by coincidence (KiCad model): a line end that sits on a
 *    port, or on another line, is connected. Nothing stores "edge source /
 *    target"; `connectivity.ts` derives nets and junction dots from geometry.
 *  - Items reference library symbols by {library, key, version}; instances pin
 *    a version so library edits never silently rewrite a drawing.
 *  - The document is plain JSON so it can be stored, diffed, and rendered on
 *    the server without the engine's runtime.
 */

export const SCHEMA_VERSION = 1 as const;

/** ISA symbol module: symbols and ports are authored on this grid. */
export const DEFAULT_GRID_MM = 2.5;
export const FINE_GRID_MM = 1.25;

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };

export type Rotation = 0 | 90 | 180 | 270;
export type Side = "left" | "right" | "top" | "bottom";

export type SheetSizeId =
  | "A4"
  | "A3"
  | "A2"
  | "A1"
  | "A0"
  | "ANSI_A"
  | "ANSI_B"
  | "ANSI_C"
  | "ANSI_D"
  | "ANSI_E";

export type Sheet = {
  size: SheetSizeId;
  orientation: "landscape" | "portrait";
  frame: {
    /** "none" draws nothing; "basic" draws a border with zone ticks. */
    kind: "none" | "basic";
    /**
     * Frame template that adds the title block, revision table, notes, and
     * proprietary blocks (`frames.ts`). Defaults to "basic" when `kind` is
     * "basic" and "none" otherwise.
     */
    template?: "none" | "basic" | "fsdp-standard";
    /** Zone columns (numbered right-to-left) and rows (lettered bottom-to-top). */
    columns: number;
    rows: number;
    /** Border inset from the paper edge. */
    margin: number;
  };
};

export type Layer = {
  id: string;
  name: string;
  color?: string;
  hidden?: boolean;
  locked?: boolean;
};

export const DEFAULT_LAYERS: Layer[] = [
  { id: "process", name: "Process lines", color: "#1f2937" },
  { id: "signal", name: "Signal lines", color: "#1f2937" },
  { id: "symbols", name: "Symbols", color: "#1f2937" },
  { id: "equipment", name: "Equipment", color: "#1f2937" },
  { id: "annotation", name: "Annotations", color: "#1f2937" },
  { id: "notes", name: "Review notes (not printed)", color: "#b45309" }
];

export type SymbolRef = { library: string; key: string; version: number };

export type FieldValue = string | number | boolean | null;

type ItemBase = {
  id: string;
  layer: string;
  locked?: boolean;
};

export type SymbolItem = ItemBase & {
  kind: "symbol";
  symbol: SymbolRef;
  /** Symbol origin (the library symbol's centre) in sheet mm. */
  position: Point;
  rotation: Rotation;
  mirror?: boolean;
  /** Uniform scale applied to the library geometry (1 = authored size). */
  scale?: number;
  /** Component tag, e.g. "PT-3222". */
  tag?: string;
  /** Free label shown when no tag is set. */
  label?: string;
  color?: string;
  /** Link into the digital thread (ComponentInstance.id). */
  componentId?: string;
  fields: Record<string, FieldValue>;
};

export type LineType =
  | "process"
  | "signal_electric"
  | "signal_pneumatic"
  | "signal_software"
  | "capillary"
  | "vacuum"
  | "future";

export type LineItem = ItemBase & {
  kind: "line";
  /** Orthogonal polyline vertices in sheet mm, at least two. */
  points: Point[];
  lineType: LineType;
  /** Fluid / service, e.g. "GHe". */
  service?: string;
  lineNumber?: string;
  size?: string;
  spec?: string;
  color?: string;
  strokeWidth?: number;
  /** Draw a flow arrow at the last vertex. */
  showArrow?: boolean;
  fields: Record<string, FieldValue>;
};

export type EquipmentItem = ItemBase & {
  kind: "equipment";
  /** Top-left corner in sheet mm. */
  position: Point;
  size: Size;
  tag?: string;
  name: string;
  boundary: "solid" | "dashed";
  color?: string;
  fields: Record<string, FieldValue>;
};

export type LabelItem = ItemBase & {
  kind: "label";
  position: Point;
  text: string;
  /** Font size in mm (cap height follows the font). */
  fontSize: number;
  rotation: Rotation;
  anchor: "start" | "middle" | "end";
  color?: string;
};

/** Review pin. Never printed. */
export type NoteItem = ItemBase & {
  kind: "note";
  position: Point;
  text: string;
  author?: string;
  createdAt?: string;
};

export type Item = SymbolItem | LineItem | EquipmentItem | LabelItem | NoteItem;
export type ItemKind = Item["kind"];

export type SchematicDocument = {
  schemaVersion: typeof SCHEMA_VERSION;
  sheet: Sheet;
  layers: Layer[];
  items: Item[];
  meta: {
    title?: string;
    grid?: number;
    convertedFrom?: "reactflow";
  };
};

/* ---------- Library definitions ---------- */

export type PortKind = "process" | "signal" | "nozzle";

export type PortDef = {
  id: string;
  /** Offset from the symbol origin in mm (unrotated). */
  x: number;
  y: number;
  /** Direction a line leaves the port (unrotated). */
  side: Side;
  kind?: PortKind;
  /** Nominal connection size, e.g. "1/4 in". */
  size?: string;
};

export type FieldDef = {
  key: string;
  label: string;
  type: "text" | "number" | "boolean";
  unit?: string;
};

export type SymbolDef = {
  library: string;
  key: string;
  version: number;
  name: string;
  category: string;
  /** Legend text printed in the symbol legend block. */
  legend?: string;
  standardRef?: string;
  /** Bounding box of the drawn geometry in mm, centred on the origin. */
  width: number;
  height: number;
  /**
   * Inner SVG markup in mm, origin at the symbol centre, drawn with
   * `stroke="currentColor"` and no explicit stroke width (the renderer sets it).
   */
  svg: string;
  ports: PortDef[];
  /** Default tag function letters, e.g. "PT". */
  tagPrefix?: string;
  fields?: FieldDef[];
};

export function createEmptyDocument(sheet?: Partial<Sheet>): SchematicDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    sheet: {
      size: "A3",
      orientation: "landscape",
      frame: { kind: "basic", columns: 4, rows: 3, margin: 10 },
      ...sheet
    },
    layers: DEFAULT_LAYERS.map((layer) => ({ ...layer })),
    items: [],
    meta: { grid: DEFAULT_GRID_MM }
  };
}
