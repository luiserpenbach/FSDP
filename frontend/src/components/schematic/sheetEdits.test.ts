import { describe, expect, it, vi } from "vitest";
import { Editor } from "../../engine/editor";
import { lineThrough, smallPanelDocument, symbolAt } from "../../engine/fixtures";
import type { SheetIndex } from "../../engine/index";
import { SymbolRegistry } from "../../engine/library";
import type { PartLike } from "../../engine/parts";
import { DocumentStore } from "../../engine/store";
import { DEFAULT_TAG_SCHEME } from "../../engine/tags";
import { createEmptyDocument, type SchematicDocument, type SymbolItem } from "../../engine/types";
import { commitSheetEdits, SheetEditRefused, type SheetEditContext } from "./sheetEdits";

const registry = SymbolRegistry.withBuiltins();
const parts = new Map<string, PartLike>([["p1", { id: "p1", part_number: "AMB2-001", lifecycle_status: "active", qualification_status: "qualified", pressure_rating_bar: 200, material: "316L" }]]);

function otherDoc(): SchematicDocument {
  const doc = createEmptyDocument();
  doc.items = [
    symbolAt("hv9", "hand_valve", { x: 80, y: 80 }, { tag: "HV-9" }),
    symbolAt("hv10", "hand_valve", { x: 140, y: 80 }, { tag: "HV-10" }),
    lineThrough("l9", [
      { x: 90, y: 80 },
      { x: 130, y: 80 }
    ])
  ];
  return doc;
}

function setup(patch: Partial<SheetEditContext> = {}) {
  const editor = new Editor(new DocumentStore(smallPanelDocument()), registry, { tagScheme: DEFAULT_TAG_SCHEME });
  const stored = otherDoc();
  const saveSheet = vi.fn(async () => undefined);
  const onSheetSaved = vi.fn();
  const onBeforeSave = vi.fn();
  const context: SheetEditContext = {
    drawing: {
      id: "dw1",
      number: "AMB2-9003",
      sheets: [
        { id: "sh1", sheet_no: 1 },
        { id: "sh2", sheet_no: 2 }
      ]
    },
    locked: false,
    canWrite: true,
    editor,
    openSheetId: "sh1",
    otherSheets: [{ sheetId: "sh2", sheetNo: 2, doc: stored }],
    registry,
    tagScheme: DEFAULT_TAG_SCHEME,
    lineClasses: [{ name: "SS316", material: "316L", wall: "0.035" }],
    parts,
    loadSheet: vi.fn(async () => ({ sheet_no: 2, document: stored })),
    loadWaivers: vi.fn(async () => [{ key: "x", reason: "y" }]),
    saveSheet,
    onBeforeSave,
    onSheetSaved,
    ...patch
  };
  return { editor, context, saveSheet, onSheetSaved, onBeforeSave, stored };
}

describe("commitSheetEdits", () => {
  it("edits the open sheet through the editor as one undo step", async () => {
    const { editor, context, saveSheet } = setup();
    const result = await commitSheetEdits(context, [
      { sheetId: "sh1", itemId: "hv", field: "partId", value: "p1" },
      { sheetId: "sh1", itemId: "pcv", field: "partId", value: "p1" },
      { sheetId: "sh1", itemId: "l2", field: "lineClass", value: "ss316" }
    ]);
    expect(result).toEqual({ errors: [], applied: 3, savedSheetIds: [] });
    expect(saveSheet).not.toHaveBeenCalled();
    expect(editor.store.dirty).toBe(true);
    const item = (id: string) => editor.store.doc.items.find((entry) => entry.id === id) as SymbolItem & { lineClass?: string; spec?: string };
    expect(item("hv").partId).toBe("p1");
    expect(item("l2").lineClass).toBe("SS316");
    expect(item("l2").spec).toBe("316L x 0.035 WALL");
    editor.undo();
    expect(item("hv").partId).toBeUndefined();
    expect(item("pcv").partId).toBeUndefined();
    expect(item("l2").lineClass).toBeUndefined();
    expect(editor.store.canUndo).toBe(false);
  });

  it("loads, edits, re-derives, and stores another sheet with its index and DRC", async () => {
    const { context, saveSheet, onSheetSaved, onBeforeSave, editor } = setup();
    const result = await commitSheetEdits(context, [
      { sheetId: "sh2", itemId: "hv9", field: "partId", value: "p1" },
      { sheetId: "sh2", itemId: "l9", field: "service", value: "GHe" },
      // Already used on the open sheet: refused, the rest of the sheet is still written.
      { sheetId: "sh2", itemId: "hv10", field: "tag", value: "HV-3201" }
    ]);
    expect(result.applied).toBe(2);
    expect(result.savedSheetIds).toEqual(["sh2"]);
    expect(result.errors).toEqual([{ sheetId: "sh2", itemId: "hv10", field: "tag", message: expect.stringContaining("already used on another sheet") }]);
    expect(context.loadSheet).toHaveBeenCalledWith("sh2");
    expect(context.loadWaivers).toHaveBeenCalledWith("sh2");
    expect(onBeforeSave).toHaveBeenCalledWith("sh2");
    expect(saveSheet).toHaveBeenCalledTimes(1);
    const [id, body] = saveSheet.mock.calls[0] as unknown as [string, { document: SchematicDocument; index: SheetIndex; drc: { findings: unknown[]; checks: unknown[] } }];
    expect(id).toBe("sh2");
    expect((body.document.items.find((entry) => entry.id === "hv9") as SymbolItem).partId).toBe("p1");
    expect((body.document.items.find((entry) => entry.id === "hv10") as SymbolItem).tag).toBe("HV-10");
    // The derived index reflects the edit.
    expect(body.index.items.find((entry) => entry.item_id === "hv9")?.part_id).toBe("p1");
    expect(body.index.lines.find((entry) => entry.line_id === "l9")?.service).toBe("GHe");
    expect(Array.isArray(body.drc.findings)).toBe(true);
    expect(Array.isArray(body.drc.checks)).toBe(true);
    expect(onSheetSaved).toHaveBeenCalledWith("sh2", 2, body.document, expect.any(Number));
    // The open sheet is untouched.
    expect(editor.store.dirty).toBe(false);
  });

  it("refuses every edit on a released drawing and for viewers", async () => {
    const released = setup({ locked: true });
    await expect(commitSheetEdits(released.context, [{ sheetId: "sh2", itemId: "hv9", field: "partId", value: "p1" }])).rejects.toThrow(SheetEditRefused);
    await expect(commitSheetEdits(released.context, [{ sheetId: "sh1", itemId: "hv", field: "partId", value: "p1" }])).rejects.toThrow("AMB2-9003 is released");
    expect(released.saveSheet).not.toHaveBeenCalled();
    expect(released.editor.store.dirty).toBe(false);

    const viewer = setup({ canWrite: false });
    await expect(commitSheetEdits(viewer.context, [{ sheetId: "sh1", itemId: "hv", field: "partId", value: "p1" }])).rejects.toThrow("not edit it");
  });

  it("reports a failed sheet save on that sheet's edits only", async () => {
    const { context, editor } = setup({ saveSheet: vi.fn(async () => Promise.reject(new Error("Drawing is released"))) });
    const result = await commitSheetEdits(context, [
      { sheetId: "sh1", itemId: "hv", field: "notes", value: "capped" },
      { sheetId: "sh2", itemId: "hv9", field: "notes", value: "capped" }
    ]);
    expect(result.errors).toEqual([{ sheetId: "sh2", itemId: "hv9", field: "notes", message: "Sheet 2: Drawing is released" }]);
    expect((editor.store.doc.items.find((entry) => entry.id === "hv") as SymbolItem).fields.notes).toBe("capped");
  });

  it("reserves tags written to the open sheet for the other sheets in the same commit", async () => {
    const { context, saveSheet } = setup();
    const result = await commitSheetEdits(context, [
      { sheetId: "sh2", itemId: "hv9", field: "tag", value: "HV-77" },
      { sheetId: "sh1", itemId: "hv", field: "tag", value: "HV-77" }
    ]);
    // The open sheet goes first and claims the tag.
    expect(result.errors.map((error) => error.sheetId)).toEqual(["sh2"]);
    expect(saveSheet).not.toHaveBeenCalled();
  });

  it("routes through the live open editor when the user switches sheets mid-commit", async () => {
    const { context, saveSheet, stored } = setup();
    const switched = new Editor(new DocumentStore(structuredClone(stored)), registry, { tagScheme: DEFAULT_TAG_SCHEME });
    let open: { sheetId: string; editor: Editor } | null = { sheetId: "sh1", editor: context.editor! };
    context.getOpenSession = () => open;
    context.loadSheet = vi.fn(async () => {
      // Locate / sheet tab opened sheet 2 while the other-sheet load was in flight.
      open = { sheetId: "sh2", editor: switched };
      return { sheet_no: 2, document: stored };
    });

    const result = await commitSheetEdits(context, [{ sheetId: "sh2", itemId: "hv9", field: "partId", value: "p1" }]);
    expect(result).toEqual({ errors: [], applied: 1, savedSheetIds: [] });
    expect(saveSheet).not.toHaveBeenCalled();
    expect((switched.store.doc.items.find((entry) => entry.id === "hv9") as SymbolItem).partId).toBe("p1");
    expect(switched.store.dirty).toBe(true);
  });

  it("hydrates a clean editor that opened onto a sheet after the other-sheet PUT", async () => {
    const { context, stored } = setup();
    // Editor still holds the pre-edit document (GET raced ahead of the list PUT).
    const stale = new Editor(new DocumentStore(structuredClone(stored)), registry, { tagScheme: DEFAULT_TAG_SCHEME });
    let open: { sheetId: string; editor: Editor } | null = { sheetId: "sh1", editor: context.editor! };
    context.getOpenSession = () => open;
    const saveSheet = vi.fn(async () => {
      // Sheet load finished with the pre-edit doc while this PUT was in flight.
      open = { sheetId: "sh2", editor: stale };
    });
    context.saveSheet = saveSheet;

    const result = await commitSheetEdits(context, [{ sheetId: "sh2", itemId: "hv9", field: "partId", value: "p1" }]);
    expect(result.savedSheetIds).toEqual(["sh2"]);
    expect(saveSheet).toHaveBeenCalledTimes(1);
    expect((stale.store.doc.items.find((entry) => entry.id === "hv9") as SymbolItem).partId).toBe("p1");
    // load() marks the written doc clean so a later canvas edit starts from it.
    expect(stale.store.dirty).toBe(false);
  });

  it("re-applies list field edits onto a dirty editor after the other-sheet PUT", async () => {
    const { context, stored } = setup();
    const dirty = new Editor(new DocumentStore(structuredClone(stored)), registry, { tagScheme: DEFAULT_TAG_SCHEME });
    dirty.dispatch({ type: "update", id: "hv9", patch: { position: { x: 99, y: 80 } } });
    expect(dirty.store.dirty).toBe(true);
    let open: { sheetId: string; editor: Editor } | null = { sheetId: "sh1", editor: context.editor! };
    context.getOpenSession = () => open;
    const saveSheet = vi.fn(async () => {
      open = { sheetId: "sh2", editor: dirty };
    });
    context.saveSheet = saveSheet;

    const result = await commitSheetEdits(context, [{ sheetId: "sh2", itemId: "hv9", field: "partId", value: "p1" }]);
    expect(result.savedSheetIds).toEqual(["sh2"]);
    expect(saveSheet).toHaveBeenCalledTimes(1);
    const item = dirty.store.doc.items.find((entry) => entry.id === "hv9") as SymbolItem;
    expect(item.partId).toBe("p1");
    expect(item.position).toEqual({ x: 99, y: 80 });
    expect(dirty.store.dirty).toBe(true);
  });
});
