/**
 * Editor session: selection, active tool, and drag state on top of a
 * DocumentStore. Framework-free; the React canvas feeds it pointer and key
 * events in sheet millimetres and re-renders from `snapshot`.
 */
import { applyCommand, translateItem, type Command } from "./commands";
import { computeConnectivity, indexPorts, type Connectivity, type IndexedPort } from "./connectivity";
import {
  dragSegment,
  duplicateItems,
  expandSelectionForEquipment,
  mirrorItemsCommand,
  moveItemsCommand,
  rotateItemsCommand
} from "./edit";
import { DEFAULT_TAG_SCHEME, nextTag, renumberCommand, type TagContext, type TagScheme } from "./tags";
import { normalizeRotation, rectFromPoints, simplifyPolyline, snapPoint, subtract } from "./geometry";
import { type SymbolRegistry } from "./library";
import { previewSegment } from "./routing";
import { snapCursor, type SnapResult } from "./snap";
import { SpatialIndex, hitTest, type Hit } from "./spatial";
import type { DocumentStore } from "./store";
import {
  DEFAULT_GRID_MM,
  type EquipmentItem,
  type Item,
  type LabelItem,
  type LineItem,
  type LineAnnotation,
  type LineType,
  type NoteItem,
  type Point,
  type Rect,
  type Rotation,
  type SchematicDocument,
  type SymbolItem,
  type SymbolRef
} from "./types";

export type ToolId = "select" | "wire" | "place" | "label" | "equipment" | "note" | "measure";

export type AlignMode = "left" | "right" | "top" | "bottom" | "centerX" | "centerY";

export type Modifiers = { shift?: boolean; ctrl?: boolean; alt?: boolean };

export type DragState =
  | { kind: "move"; ids: string[]; origin: Point; applied: Point; moved: boolean; key: string }
  | { kind: "window"; origin: Point; current: Point }
  | { kind: "segment"; lineId: string; index: number; key: string };

export type WireState = { points: Point[]; verticalFirst: boolean; startSnap: SnapResult | null };

export type PlaceState = { symbol: SymbolRef; rotation: Rotation; mirror: boolean };

export type EditorState = {
  tool: ToolId;
  selection: string[];
  hover: string | null;
  cursor: Point | null;
  snap: SnapResult | null;
  drag: DragState | null;
  wire: WireState | null;
  place: PlaceState | null;
  equipmentDraft: Rect | null;
  /** Measure tool: first click, the live or fixed second point, and whether it is fixed. */
  measure: { from: Point; to: Point | null; fixed: boolean } | null;
  lineType: LineType;
  grid: number;
  /** System / class digits used when suggesting structured tags. */
  tagContext: TagContext;
};

export type EditorSnapshot = {
  doc: SchematicDocument;
  state: EditorState;
  connectivity: Connectivity;
  version: number;
};

export type EditorOptions = { author?: string; makeId?: () => string; tagScheme?: TagScheme };

function parseLetters(tag: string): string | null {
  const match = /^([A-Za-z]+)/.exec(tag.trim());
  return match ? match[1].toUpperCase() : null;
}

function defaultId(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class Editor {
  private stateValue: EditorState;
  private index: SpatialIndex;
  private ports: IndexedPort[];
  private connectivityValue: Connectivity;
  private snapshotValue: EditorSnapshot;
  private listeners = new Set<() => void>();
  private unsubscribeStore: () => void;
  private clipboard: Item[] = [];
  private pasteCount = 0;
  /** Hit tolerance in mm; the host sets it from the zoom level. */
  tolerance = 1.5;
  tagScheme: TagScheme;

  setTolerance(mm: number): void {
    this.tolerance = mm;
  }
  readonly makeId: () => string;

  constructor(
    readonly store: DocumentStore,
    readonly registry: SymbolRegistry,
    readonly options: EditorOptions = {}
  ) {
    this.makeId = options.makeId ?? defaultId;
    this.tagScheme = options.tagScheme ?? DEFAULT_TAG_SCHEME;
    this.stateValue = {
      tool: "select",
      selection: [],
      hover: null,
      cursor: null,
      snap: null,
      drag: null,
      wire: null,
      place: null,
      equipmentDraft: null,
      measure: null,
      lineType: "process",
      grid: store.doc.meta.grid ?? DEFAULT_GRID_MM,
      tagContext: {}
    };
    this.index = new SpatialIndex(store.doc, registry);
    this.ports = indexPorts(store.doc, registry);
    this.connectivityValue = computeConnectivity(store.doc, registry);
    this.snapshotValue = { doc: store.doc, state: this.stateValue, connectivity: this.connectivityValue, version: 0 };
    this.unsubscribeStore = store.subscribe(() => this.onDocumentChanged());
  }

  dispose(): void {
    this.unsubscribeStore();
    this.listeners.clear();
  }

  get doc(): SchematicDocument {
    return this.store.doc;
  }

  get state(): EditorState {
    return this.stateValue;
  }

  get snapshot(): EditorSnapshot {
    return this.snapshotValue;
  }

  get connectivity(): Connectivity {
    return this.connectivityValue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onDocumentChanged(): void {
    this.index = new SpatialIndex(this.store.doc, this.registry);
    this.ports = indexPorts(this.store.doc, this.registry);
    this.connectivityValue = computeConnectivity(this.store.doc, this.registry);
    const present = new Set(this.store.doc.items.map((item) => item.id));
    const selection = this.stateValue.selection.filter((id) => present.has(id));
    this.stateValue = { ...this.stateValue, selection };
    this.emit();
  }

  private setState(patch: Partial<EditorState>): void {
    this.stateValue = { ...this.stateValue, ...patch };
    this.emit();
  }

  private emit(): void {
    this.snapshotValue = {
      doc: this.store.doc,
      state: this.stateValue,
      connectivity: this.connectivityValue,
      version: this.snapshotValue.version + 1
    };
    this.listeners.forEach((listener) => listener());
  }

  /* ---------- Queries ---------- */

  selectedItems(): Item[] {
    const ids = new Set(this.stateValue.selection);
    return this.store.doc.items.filter((item) => ids.has(item.id));
  }

  itemById(id: string): Item | undefined {
    return this.store.doc.items.find((item) => item.id === id);
  }

  hitAt(point: Point): Hit | null {
    return hitTest(this.index, point, this.tolerance);
  }

  /** Ghost symbol for the place tool, or null. */
  ghostSymbol(): SymbolItem | null {
    const { place, cursor } = this.stateValue;
    if (!place || !cursor || this.stateValue.tool !== "place") return null;
    return {
      id: "__ghost__",
      kind: "symbol",
      layer: "symbols",
      symbol: place.symbol,
      position: cursor,
      rotation: place.rotation,
      mirror: place.mirror,
      fields: {}
    };
  }

  /** Vertices of the line being drawn, including the live preview to the cursor. */
  wirePreview(): Point[] {
    const { wire, cursor } = this.stateValue;
    if (!wire) return [];
    if (!cursor) return wire.points;
    const last = wire.points[wire.points.length - 1];
    return [...wire.points.slice(0, -1), ...previewSegment(last, cursor, wire.verticalFirst)];
  }

  /* ---------- Tool switching ---------- */

  setTool(tool: ToolId): void {
    this.setState({ tool, wire: null, drag: null, equipmentDraft: null, measure: null, place: tool === "place" ? this.stateValue.place : null });
  }

  /* ---------- Align, distribute, clipboard, find ---------- */

  private selectionBounds(): Array<{ id: string; rect: Rect }> {
    return this.stateValue.selection
      .map((id) => ({ id, rect: this.index.boundsOf(id) }))
      .filter((entry): entry is { id: string; rect: Rect } => Boolean(entry.rect));
  }

  /** Align the selected items' bounds to the selection's extreme edge or centre. */
  alignSelection(mode: AlignMode): void {
    const entries = this.selectionBounds();
    if (entries.length < 2) return;
    const grid = this.stateValue.grid;
    const minX = Math.min(...entries.map((entry) => entry.rect.x));
    const maxX = Math.max(...entries.map((entry) => entry.rect.x + entry.rect.width));
    const minY = Math.min(...entries.map((entry) => entry.rect.y));
    const maxY = Math.max(...entries.map((entry) => entry.rect.y + entry.rect.height));
    const centreX = snapPoint({ x: (minX + maxX) / 2, y: 0 }, grid).x;
    const centreY = snapPoint({ x: 0, y: (minY + maxY) / 2 }, grid).y;
    const commands: Command[] = [];
    let working = this.store.doc;
    for (const entry of entries) {
      const { rect } = entry;
      let delta: Point = { x: 0, y: 0 };
      switch (mode) {
        case "left": delta = { x: minX - rect.x, y: 0 }; break;
        case "right": delta = { x: maxX - (rect.x + rect.width), y: 0 }; break;
        case "top": delta = { x: 0, y: minY - rect.y }; break;
        case "bottom": delta = { x: 0, y: maxY - (rect.y + rect.height) }; break;
        case "centerX": delta = { x: centreX - (rect.x + rect.width / 2), y: 0 }; break;
        case "centerY": delta = { x: 0, y: centreY - (rect.y + rect.height / 2) }; break;
      }
      delta = snapPoint(delta, grid);
      if (delta.x === 0 && delta.y === 0) continue;
      const command = moveItemsCommand(working, this.registry, [entry.id], delta);
      commands.push(command);
      working = applyCommand(working, command);
    }
    if (commands.length) this.store.dispatch({ type: "batch", commands, label: `Align ${mode}` });
  }

  /** Spread the selected items evenly between the two outermost along an axis. */
  distributeSelection(axis: "x" | "y"): void {
    const entries = this.selectionBounds();
    if (entries.length < 3) return;
    const grid = this.stateValue.grid;
    const centre = (rect: Rect) => (axis === "x" ? rect.x + rect.width / 2 : rect.y + rect.height / 2);
    const sorted = [...entries].sort((a, b) => centre(a.rect) - centre(b.rect));
    const first = centre(sorted[0].rect);
    const last = centre(sorted[sorted.length - 1].rect);
    const step = (last - first) / (sorted.length - 1);
    const commands: Command[] = [];
    let working = this.store.doc;
    sorted.forEach((entry, index) => {
      if (index === 0 || index === sorted.length - 1) return;
      const target = snapPoint({ x: first + step * index, y: first + step * index }, grid);
      const current = centre(entry.rect);
      const delta = axis === "x" ? { x: target.x - current, y: 0 } : { x: 0, y: target.y - current };
      if (delta.x === 0 && delta.y === 0) return;
      const command = moveItemsCommand(working, this.registry, [entry.id], delta);
      commands.push(command);
      working = applyCommand(working, command);
    });
    if (commands.length) this.store.dispatch({ type: "batch", commands, label: `Distribute ${axis}` });
  }

  copySelection(): number {
    const selected = new Set(this.stateValue.selection);
    this.clipboard = this.store.doc.items.filter((item) => selected.has(item.id)).map((item) => JSON.parse(JSON.stringify(item)) as Item);
    this.pasteCount = 0;
    return this.clipboard.length;
  }

  /** Paste the clipboard offset by the paste count; symbol tags are re-suggested under the scheme. */
  paste(): string[] {
    if (!this.clipboard.length) return [];
    this.pasteCount += 1;
    const grid = this.stateValue.grid;
    const offset = { x: grid * 4 * this.pasteCount, y: grid * 4 * this.pasteCount };
    const idMap = new Map<string, string>();
    for (const item of this.clipboard) idMap.set(item.id, this.makeId());
    let working = this.store.doc;
    const items: Item[] = [];
    for (const original of this.clipboard) {
      const copy = translateItem(original, offset);
      copy.id = idMap.get(original.id) ?? this.makeId();
      if (copy.kind === "symbol") {
        copy.componentId = undefined;
        const definition = this.registry.resolve(copy.symbol);
        copy.tag = copy.tag ? nextTag(working, this.tagScheme, parseLetters(copy.tag) ?? definition.tagPrefix ?? "X", this.stateValue.tagContext) : undefined;
      }
      items.push(copy);
      working = applyCommand(working, { type: "add", items: [copy] });
    }
    this.store.dispatch({ type: "add", items });
    this.setState({ selection: items.map((item) => item.id) });
    return items.map((item) => item.id);
  }

  /** Select items whose tag, label, line number, or name contains `query`. */
  findTag(query: string): string[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const matches = this.store.doc.items
      .filter((item) => {
        const haystack =
          item.kind === "symbol" ? `${item.tag ?? ""} ${item.label ?? ""}` :
          item.kind === "line" ? `${item.lineNumber ?? ""} ${item.service ?? ""}` :
          item.kind === "equipment" ? `${item.tag ?? ""} ${item.name}` :
          item.kind === "label" ? item.text : "";
        return haystack.toLowerCase().includes(needle);
      })
      .map((item) => item.id);
    this.setState({ selection: matches });
    return matches;
  }

  /** Add an annotation to a line at a fraction of its length. */
  addLineAnnotation(lineId: string, annotation: Omit<LineAnnotation, "id">): void {
    const line = this.itemById(lineId);
    if (!line || line.kind !== "line") return;
    const annotations = [...(line.annotations ?? []), { id: this.makeId(), ...annotation }];
    this.store.dispatch({ type: "update", id: lineId, patch: { annotations } });
  }

  removeLineAnnotation(lineId: string, annotationId: string): void {
    const line = this.itemById(lineId);
    if (!line || line.kind !== "line") return;
    this.store.dispatch({ type: "update", id: lineId, patch: { annotations: (line.annotations ?? []).filter((entry) => entry.id !== annotationId) } });
  }

  startPlacing(symbol: SymbolRef): void {
    this.setState({ tool: "place", place: { symbol, rotation: 0, mirror: false }, wire: null, drag: null, selection: [] });
  }

  setLineType(lineType: LineType): void {
    const selectedLines = this.selectedItems().filter((item): item is LineItem => item.kind === "line");
    if (selectedLines.length) {
      this.store.dispatch({
        type: "batch",
        label: "Line type",
        commands: selectedLines.map((line) => ({
          type: "update",
          id: line.id,
          patch: { lineType, layer: lineType === "process" ? "process" : "signal" }
        }))
      });
    }
    this.setState({ lineType });
  }

  setGrid(grid: number): void {
    this.setState({ grid });
  }

  setTagScheme(scheme: TagScheme): void {
    this.tagScheme = scheme;
    this.emit();
  }

  setTagContext(context: TagContext): void {
    this.setState({ tagContext: { ...this.stateValue.tagContext, ...context } });
  }

  /** Suggested tag for a symbol definition under the project scheme. */
  suggestTagFor(tagPrefix: string | undefined): string | undefined {
    if (!tagPrefix) return undefined;
    return nextTag(this.store.doc, this.tagScheme, tagPrefix, this.stateValue.tagContext);
  }

  /** Re-sequence the selected symbols' tags per letter group in reading order. */
  renumberSelection(startAt = 1): void {
    if (!this.stateValue.selection.length) return;
    this.store.dispatch(renumberCommand(this.store.doc, this.tagScheme, this.stateValue.selection, this.stateValue.tagContext, startAt));
  }

  /** Escape: cancel the in-progress action, else drop back to select. */
  cancel(): void {
    const { wire, drag, tool, place, measure } = this.stateValue;
    if (wire) {
      this.setState({ wire: null });
      return;
    }
    if (measure) {
      this.setState({ measure: null });
      return;
    }
    if (drag?.kind === "segment" || drag?.kind === "move") {
      this.store.endCoalescing();
      this.setState({ drag: null });
      return;
    }
    if (tool !== "select" || place) {
      this.setState({ tool: "select", place: null, drag: null, equipmentDraft: null });
      return;
    }
    this.setState({ selection: [] });
  }

  /* ---------- Selection commands ---------- */

  select(ids: string[]): void {
    this.setState({ selection: ids });
  }

  selectAll(): void {
    this.setState({ selection: this.store.doc.items.map((item) => item.id) });
  }

  deleteSelection(): void {
    if (!this.stateValue.selection.length) return;
    this.store.dispatch({ type: "remove", ids: this.stateValue.selection });
  }

  rotateSelection(by = 90): void {
    if (this.stateValue.tool === "place" && this.stateValue.place) {
      this.setState({ place: { ...this.stateValue.place, rotation: normalizeRotation(this.stateValue.place.rotation + by) } });
      return;
    }
    if (!this.stateValue.selection.length) return;
    this.store.dispatch(rotateItemsCommand(this.store.doc, this.registry, this.stateValue.selection, by));
  }

  mirrorSelection(): void {
    if (this.stateValue.tool === "place" && this.stateValue.place) {
      this.setState({ place: { ...this.stateValue.place, mirror: !this.stateValue.place.mirror } });
      return;
    }
    if (!this.stateValue.selection.length) return;
    this.store.dispatch(mirrorItemsCommand(this.store.doc, this.registry, this.stateValue.selection));
  }

  duplicateSelection(): void {
    if (!this.stateValue.selection.length) return;
    const grid = this.stateValue.grid;
    const copies = duplicateItems(this.store.doc, this.stateValue.selection, { x: grid * 4, y: grid * 4 }, this.makeId);
    this.store.dispatch({ type: "add", items: copies });
    this.setState({ selection: copies.map((item) => item.id) });
  }

  nudgeSelection(delta: Point): void {
    if (!this.stateValue.selection.length) return;
    this.store.dispatch(moveItemsCommand(this.store.doc, this.registry, this.stateValue.selection, delta));
  }

  updateItem(id: string, patch: Record<string, unknown>): void {
    this.store.dispatch({ type: "update", id, patch });
  }

  updateSelection(patch: Record<string, unknown>): void {
    const commands: Command[] = this.stateValue.selection.map((id) => ({ type: "update", id, patch }));
    this.store.dispatch({ type: "batch", commands, label: "Edit" });
  }

  /* ---------- Pointer events (sheet mm) ---------- */

  pointerMove(raw: Point, modifiers: Modifiers = {}): void {
    const grid = this.stateValue.grid;
    const state = this.stateValue;
    switch (state.tool) {
      case "wire": {
        const snap = snapCursor(this.store.doc, this.ports, raw, {
          grid,
          portRadius: this.tolerance * 1.5,
          segmentRadius: this.tolerance
        });
        this.setState({ cursor: snap.point, snap });
        return;
      }
      case "place":
      case "label":
      case "note": {
        this.setState({ cursor: snapPoint(raw, grid), snap: null });
        return;
      }
      case "measure": {
        const cursor = snapPoint(raw, grid);
        this.setState({ cursor, measure: state.measure && !state.measure.fixed ? { ...state.measure, to: cursor } : state.measure });
        return;
      }
      case "equipment": {
        const cursor = snapPoint(raw, grid);
        if (state.drag?.kind === "window") {
          this.setState({ cursor, drag: { ...state.drag, current: cursor }, equipmentDraft: rectFromPoints(state.drag.origin, cursor) });
        } else {
          this.setState({ cursor });
        }
        return;
      }
      default:
        this.selectToolMove(raw, modifiers);
    }
  }

  private selectToolMove(raw: Point, modifiers: Modifiers): void {
    const state = this.stateValue;
    const grid = state.grid;
    const drag = state.drag;
    if (!drag) {
      const hit = this.hitAt(raw);
      this.setState({ cursor: raw, hover: hit?.item.id ?? null });
      return;
    }
    if (drag.kind === "window") {
      this.setState({ cursor: raw, drag: { ...drag, current: raw } });
      return;
    }
    if (drag.kind === "segment") {
      const line = this.itemById(drag.lineId);
      if (!line || line.kind !== "line") return;
      const a = line.points[drag.index];
      const b = line.points[drag.index + 1];
      if (!a || !b) return;
      const horizontal = a.y === b.y;
      const coordinate = modifiers.alt ? (horizontal ? raw.y : raw.x) : (horizontal ? snapPoint(raw, grid).y : snapPoint(raw, grid).x);
      const points = dragSegment(line.points, drag.index, coordinate);
      this.store.dispatch({ type: "set-points", id: line.id, points }, { coalesceKey: drag.key });
      // Re-resolve the segment index after simplification: pick the segment at the new coordinate.
      const updated = this.itemById(drag.lineId);
      if (updated && updated.kind === "line") {
        const index = updated.points.findIndex((point, i) => {
          const next = updated.points[i + 1];
          return next && (horizontal ? point.y === coordinate && next.y === coordinate : point.x === coordinate && next.x === coordinate);
        });
        if (index >= 0 && index !== drag.index) this.setState({ drag: { ...drag, index }, cursor: raw });
        else this.setState({ cursor: raw });
      }
      return;
    }
    // Move drag: apply grid-multiple deltas incrementally so lines follow.
    const wanted = modifiers.alt ? subtract(raw, drag.origin) : snapPoint(subtract(raw, drag.origin), grid);
    const step = subtract(wanted, drag.applied);
    if (step.x === 0 && step.y === 0) {
      this.setState({ cursor: raw });
      return;
    }
    this.store.dispatch(moveItemsCommand(this.store.doc, this.registry, drag.ids, step), { coalesceKey: drag.key });
    this.setState({ cursor: raw, drag: { ...drag, applied: wanted, moved: true } });
  }

  pointerDown(raw: Point, modifiers: Modifiers = {}): void {
    const state = this.stateValue;
    switch (state.tool) {
      case "wire":
        this.wireClick(raw);
        return;
      case "place":
        this.placeClick(raw);
        return;
      case "label":
        this.addLabel(snapPoint(raw, state.grid));
        return;
      case "note":
        this.addNote(snapPoint(raw, state.grid));
        return;
      case "measure": {
        const point = snapPoint(raw, state.grid);
        if (!state.measure || state.measure.fixed) this.setState({ measure: { from: point, to: null, fixed: false } });
        else this.setState({ measure: { from: state.measure.from, to: point, fixed: true } });
        return;
      }
      case "equipment": {
        const origin = snapPoint(raw, state.grid);
        this.setState({ drag: { kind: "window", origin, current: origin }, equipmentDraft: null });
        return;
      }
      default:
        this.selectToolDown(raw, modifiers);
    }
  }

  private selectToolDown(raw: Point, modifiers: Modifiers): void {
    const state = this.stateValue;
    const hit = this.hitAt(raw);
    if (!hit) {
      if (!modifiers.shift) this.setState({ selection: [] });
      this.setState({ drag: { kind: "window", origin: raw, current: raw } });
      return;
    }
    const id = hit.item.id;
    const alreadySelected = state.selection.includes(id);
    let selection = state.selection;
    if (modifiers.shift) {
      selection = alreadySelected ? selection.filter((entry) => entry !== id) : [...selection, id];
      this.setState({ selection });
      return;
    }
    if (!alreadySelected) selection = [id];
    // Dragging a segment of a single selected line slides that segment.
    if (hit.item.kind === "line" && hit.part.type === "segment" && selection.length === 1 && selection[0] === id) {
      this.setState({ selection, drag: { kind: "segment", lineId: id, index: hit.part.index, key: `segment-${Date.now()}` } });
      return;
    }
    const ids = expandSelectionForEquipment(this.store.doc, this.registry, selection);
    this.setState({
      selection,
      drag: { kind: "move", ids, origin: raw, applied: { x: 0, y: 0 }, moved: false, key: `move-${Date.now()}` }
    });
  }

  pointerUp(raw: Point, modifiers: Modifiers = {}): void {
    const state = this.stateValue;
    const drag = state.drag;
    if (!drag) return;
    if (state.tool === "equipment" && drag.kind === "window") {
      const rect = rectFromPoints(drag.origin, snapPoint(raw, state.grid));
      this.setState({ drag: null, equipmentDraft: null });
      if (rect.width >= state.grid * 2 && rect.height >= state.grid * 2) this.addEquipment(rect);
      return;
    }
    if (drag.kind === "window") {
      const rect = rectFromPoints(drag.origin, raw);
      const crossing = raw.x < drag.origin.x;
      const picked = rect.width < 0.5 && rect.height < 0.5
        ? []
        : (crossing ? this.index.query(rect) : this.index.queryContained(rect)).map((item) => item.id);
      const selection = modifiers.shift ? [...new Set([...state.selection, ...picked])] : picked;
      this.setState({ drag: null, selection });
      return;
    }
    this.store.endCoalescing();
    if (drag.kind === "move" && !drag.moved) {
      // A plain click on an already-selected group narrows the selection to the clicked item.
      const hit = this.hitAt(raw);
      if (hit && state.selection.length > 1) this.setState({ drag: null, selection: [hit.item.id] });
      else this.setState({ drag: null });
      return;
    }
    this.setState({ drag: null });
  }

  doubleClick(raw: Point): void {
    if (this.stateValue.tool === "wire" && this.stateValue.wire) {
      this.finishWire(this.stateValue.wire.points.length >= 2 ? undefined : snapPoint(raw, this.stateValue.grid));
    }
  }

  /* ---------- Wire tool ---------- */

  private wireClick(raw: Point): void {
    const state = this.stateValue;
    const snap = snapCursor(this.store.doc, this.ports, raw, {
      grid: state.grid,
      portRadius: this.tolerance * 1.5,
      segmentRadius: this.tolerance
    });
    if (!state.wire) {
      this.setState({ cursor: snap.point, snap, wire: { points: [snap.point], verticalFirst: false, startSnap: snap } });
      return;
    }
    const preview = this.wirePreview();
    const points = simplifyPolyline(preview);
    const landed = snap.kind !== "grid";
    if (landed && points.length >= 2) {
      this.finishWire(undefined, points);
      return;
    }
    this.setState({ cursor: snap.point, snap, wire: { ...state.wire, points } });
  }

  toggleWireBend(): void {
    const { wire } = this.stateValue;
    if (wire) this.setState({ wire: { ...wire, verticalFirst: !wire.verticalFirst } });
  }

  /** Commit the wire in progress (Enter / double-click / landing on a port). */
  finishWire(extraPoint?: Point, pointsOverride?: Point[]): void {
    const state = this.stateValue;
    if (!state.wire) return;
    const raw = pointsOverride ?? (extraPoint ? [...state.wire.points, extraPoint] : state.wire.points);
    const points = simplifyPolyline(raw);
    if (points.length < 2) {
      this.setState({ wire: null });
      return;
    }
    const startPort = state.wire.startSnap?.kind === "port" ? this.portKind(state.wire.startSnap.itemId, state.wire.startSnap.portId) : null;
    const endSnap = state.snap;
    const endPort = endSnap?.kind === "port" ? this.portKind(endSnap.itemId, endSnap.portId) : null;
    const lineType: LineType = state.lineType === "process" && (startPort === "signal" || endPort === "signal") ? "signal_electric" : state.lineType;
    const line: LineItem = {
      id: this.makeId(),
      kind: "line",
      layer: lineType === "process" ? "process" : "signal",
      points,
      lineType,
      showArrow: false,
      fields: {}
    };
    this.store.dispatch({ type: "add", items: [line] });
    this.setState({ wire: null, selection: [line.id] });
  }

  private portKind(itemId: string, portId: string): "process" | "signal" | "nozzle" | null {
    const item = this.itemById(itemId);
    if (!item || item.kind !== "symbol") return null;
    const port = this.registry.portsOf(item).find((entry) => entry.id === portId);
    return port?.kind ?? null;
  }

  /* ---------- Place / label / note / equipment ---------- */

  private placeClick(raw: Point): void {
    const state = this.stateValue;
    if (!state.place) return;
    const position = snapPoint(raw, state.grid);
    const definition = this.registry.resolve(state.place.symbol);
    const item: SymbolItem = {
      id: this.makeId(),
      kind: "symbol",
      layer: "symbols",
      symbol: state.place.symbol,
      position,
      rotation: state.place.rotation,
      mirror: state.place.mirror || undefined,
      tag: this.suggestTagFor(definition.tagPrefix),
      fields: {}
    };
    this.store.dispatch({ type: "add", items: [item] });
    this.setState({ selection: [item.id], cursor: position });
  }

  addSymbolAt(symbol: SymbolRef, position: Point): SymbolItem {
    const definition = this.registry.resolve(symbol);
    const item: SymbolItem = {
      id: this.makeId(),
      kind: "symbol",
      layer: "symbols",
      symbol,
      position: snapPoint(position, this.stateValue.grid),
      rotation: 0,
      tag: this.suggestTagFor(definition.tagPrefix),
      fields: {}
    };
    this.store.dispatch({ type: "add", items: [item] });
    this.setState({ selection: [item.id] });
    return item;
  }

  private addLabel(position: Point): void {
    const item: LabelItem = {
      id: this.makeId(),
      kind: "label",
      layer: "annotation",
      position,
      text: "TEXT",
      fontSize: 2.5,
      rotation: 0,
      anchor: "start"
    };
    this.store.dispatch({ type: "add", items: [item] });
    this.setState({ selection: [item.id], tool: "select" });
  }

  private addNote(position: Point): void {
    const item: NoteItem = {
      id: this.makeId(),
      kind: "note",
      layer: "notes",
      position,
      text: "",
      author: this.options.author,
      createdAt: new Date().toISOString()
    };
    this.store.dispatch({ type: "add", items: [item] });
    this.setState({ selection: [item.id], tool: "select" });
  }

  private addEquipment(rect: Rect): void {
    const item: EquipmentItem = {
      id: this.makeId(),
      kind: "equipment",
      layer: "equipment",
      position: { x: rect.x, y: rect.y },
      size: { width: rect.width, height: rect.height },
      name: "EQUIPMENT",
      boundary: "dashed",
      fields: {}
    };
    // Equipment goes to the back so its contents stay clickable and draw on top.
    this.store.dispatch({ type: "add", items: [item], indices: [0] });
    this.setState({ selection: [item.id], tool: "select" });
  }

  /* ---------- Keyboard ---------- */

  /** Returns true when the key was consumed. */
  key(key: string, modifiers: Modifiers = {}): boolean {
    const grid = this.stateValue.grid;
    switch (key) {
      case "Escape":
        this.cancel();
        return true;
      case "Delete":
      case "Backspace":
        this.deleteSelection();
        return true;
      case "r":
      case "R":
        this.rotateSelection(modifiers.shift ? -90 : 90);
        return true;
      case "x":
      case "X":
        this.mirrorSelection();
        return true;
      case "w":
      case "W":
        this.setTool("wire");
        return true;
      case "v":
      case "V":
        if (modifiers.ctrl) {
          this.paste();
          return true;
        }
        this.setTool("select");
        return true;
      case "c":
      case "C":
        if (modifiers.ctrl) {
          this.copySelection();
          return true;
        }
        return false;
      case "m":
      case "M":
        this.setTool("measure");
        return true;
      case "s":
      case "S":
        this.setTool("select");
        return true;
      case "t":
      case "T":
        this.setTool("label");
        return true;
      case "e":
      case "E":
        this.setTool("equipment");
        return true;
      case "n":
      case "N":
        this.setTool("note");
        return true;
      case " ":
      case "Tab":
        if (this.stateValue.wire) {
          this.toggleWireBend();
          return true;
        }
        return false;
      case "Enter":
        if (this.stateValue.wire) {
          this.finishWire();
          return true;
        }
        return false;
      case "a":
      case "A":
        if (modifiers.ctrl) {
          this.selectAll();
          return true;
        }
        return false;
      case "d":
      case "D":
        if (modifiers.ctrl) {
          this.duplicateSelection();
          return true;
        }
        return false;
      case "ArrowLeft":
        this.nudgeSelection({ x: -grid, y: 0 });
        return true;
      case "ArrowRight":
        this.nudgeSelection({ x: grid, y: 0 });
        return true;
      case "ArrowUp":
        this.nudgeSelection({ x: 0, y: -grid });
        return true;
      case "ArrowDown":
        this.nudgeSelection({ x: 0, y: grid });
        return true;
      default:
        return false;
    }
  }
}
