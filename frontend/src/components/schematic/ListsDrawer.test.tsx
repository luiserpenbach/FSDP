import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "../../engine/editor";
import { lineThrough, symbolAt } from "../../engine/fixtures";
import { SymbolRegistry } from "../../engine/library";
import { DocumentStore } from "../../engine/store";
import { DEFAULT_TAG_SCHEME } from "../../engine/tags";
import { createEmptyDocument, type LineItem, type SchematicDocument, type SymbolItem } from "../../engine/types";
import type { Drawing, Part } from "../../types";
import { ListsDrawer, type DrawerTab } from "./ListsDrawer";
import { commitSheetEdits, type SheetEditContext, type SheetFieldEdit } from "./sheetEdits";

vi.mock("../../api", () => ({ api: { getProjectList: vi.fn() } }));

const registry = SymbolRegistry.withBuiltins();

const parts: Part[] = [
  { id: "part-1", part_number: "AMB2-001", description: "Ball valve", part_type: "valve", source_type: "vendor", material: "316L", pressure_rating_bar: 200, qualification_status: "qualified", certification_status: "certified", lifecycle_status: "active", preferred: true },
  { id: "part-2", part_number: "AMB2-002", description: "Needle valve", part_type: "valve", source_type: "vendor", material: "316L", pressure_rating_bar: 100, qualification_status: "qualified", certification_status: "certified", lifecycle_status: "active", preferred: true },
  { id: "part-3", part_number: "AMB2-003", description: "Old valve", part_type: "valve", source_type: "vendor", material: "brass", pressure_rating_bar: 50, qualification_status: "qualified", certification_status: "certified", lifecycle_status: "obsolete", preferred: false }
];

const drawing = {
  id: "dw1",
  number: "AMB2-9003",
  sheets: [{ id: "sh1", sheet_no: 1, title: null, source_diagram_id: null }],
  status: "draft"
} as unknown as Drawing;

function panel(): SchematicDocument {
  const doc = createEmptyDocument();
  doc.items = [
    symbolAt("hv1", "hand_valve", { x: 60, y: 60 }, { tag: "HV-1" }),
    symbolAt("hv2", "hand_valve", { x: 120, y: 60 }, { tag: "HV-2" }),
    symbolAt("hv10", "hand_valve", { x: 180, y: 60 }, { tag: "HV-10" }),
    // 3000 psig line into HV-1: AMB2-002 (100 bar) is under-rated there.
    lineThrough("l1", [{ x: 20, y: 60 }, { x: 50, y: 60 }], { lineNumber: "1001", designPressure: "3000 psig" }),
    lineThrough("l2", [{ x: 20, y: 120 }, { x: 80, y: 120 }], { lineNumber: "1002" })
  ];
  return doc;
}

function setup({ tab = "valve" as DrawerTab, editable = true, locked = false } = {}) {
  const editor = new Editor(new DocumentStore(panel()), registry, { tagScheme: DEFAULT_TAG_SCHEME });
  const context: SheetEditContext = {
    drawing: { id: "dw1", number: "AMB2-9003", sheets: [{ id: "sh1", sheet_no: 1 }] },
    locked,
    canWrite: true,
    editor,
    openSheetId: "sh1",
    otherSheets: [],
    registry,
    tagScheme: DEFAULT_TAG_SCHEME,
    lineClasses: [{ name: "SS316", material: "316L", wall: "0.035" }, { name: "CS150", material: "A106" }],
    parts: new Map(parts.map((part) => [part.id, part])),
    loadSheet: vi.fn(),
    loadWaivers: vi.fn(),
    saveSheet: vi.fn()
  };
  const onCommitEdits = vi.fn((edits: SheetFieldEdit[]) => commitSheetEdits(context, edits));
  const onLocate = vi.fn();
  render(
    <ListsDrawer
      editor={editor}
      sheetId="sh1"
      sheetNo={1}
      otherSheets={[]}
      parts={parts}
      projectId="p1"
      drawing={drawing}
      canWrite
      editable={editable}
      readOnlyReason={editable ? null : "AMB2-9003 is released: its lists are read-only."}
      tagScheme={DEFAULT_TAG_SCHEME}
      lineClasses={context.lineClasses}
      onCommitEdits={onCommitEdits}
      tab={tab}
      onTab={vi.fn()}
      onLocate={onLocate}
      onExport={vi.fn()}
      onGenerateBom={vi.fn()}
      bom={null}
      readiness={null}
      busy={false}
      onClose={vi.fn()}
    />
  );
  return { editor, onCommitEdits, onLocate, grid: screen.getByRole("grid") };
}

function cellOf(grid: HTMLElement, r: number, c: number): HTMLElement {
  const element = grid.querySelector<HTMLElement>(`.dgBody [data-r='${r}'][data-c='${c}']`);
  if (!element) throw new Error(`cell ${r},${c} not rendered`);
  return element;
}

function columnIndex(name: string): number {
  const headers = screen.getAllByRole("columnheader").filter((header) => header.querySelector("button"));
  const index = headers.findIndex((header) => header.textContent?.startsWith(name));
  if (index < 0) throw new Error(`no column ${name}`);
  return index;
}

function clickCell(grid: HTMLElement, r: number, c: number) {
  fireEvent.mouseDown(cellOf(grid, r, c), { button: 0 });
  fireEvent.mouseUp(cellOf(grid, r, c));
}

function typeInto(grid: HTMLElement, r: number, c: number, text: string, editorName: string) {
  act(() => grid.focus());
  clickCell(grid, r, c);
  fireEvent.keyDown(grid, { key: text[0] });
  const input = screen.getByRole("textbox", { name: editorName });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
}

function item<T>(editor: Editor, id: string): T {
  return editor.store.doc.items.find((entry) => entry.id === id) as T;
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("ListsDrawer editing", () => {
  it("edits a tag on the open sheet through the editor (undoable) and refuses duplicates", async () => {
    const { editor, grid } = setup();
    // Natural tag order: HV-1, HV-2, HV-10.
    const tag = columnIndex("Tag");
    expect([0, 1, 2].map((r) => cellOf(grid, r, tag).textContent)).toEqual(["⌖HV-1", "⌖HV-2", "⌖HV-10"]);

    typeInto(grid, 1, tag, "HV-20", "Edit Tag");
    await waitFor(() => expect(item<SymbolItem>(editor, "hv2").tag).toBe("HV-20"));
    expect(editor.store.dirty).toBe(true);
    act(() => {
      editor.undo();
    });
    expect(item<SymbolItem>(editor, "hv2").tag).toBe("HV-2");
    expect(editor.store.canUndo).toBe(false);

    // A tag already on the sheet comes back as a cell error and is not written.
    typeInto(grid, 0, tag, "HV-10", "Edit Tag");
    await waitFor(() => expect(cellOf(grid, 0, tag)).toHaveAttribute("aria-invalid", "true"));
    expect(cellOf(grid, 0, tag)).toHaveAttribute("title", expect.stringContaining("already used on this sheet"));
    expect(item<SymbolItem>(editor, "hv1").tag).toBe("HV-1");
  });

  it("pastes a column of part numbers from Excel as one undo step, flagging unknown and obsolete parts", async () => {
    const { editor, grid, onCommitEdits } = setup();
    const part = columnIndex("Part");
    act(() => grid.focus());
    clickCell(grid, 0, part);
    fireEvent.paste(grid, { clipboardData: { getData: () => "amb2-001\r\nAMB2-002\r\nAMB2-003\r\n" } });
    await waitFor(() => expect(item<SymbolItem>(editor, "hv2").partId).toBe("part-2"));
    expect(item<SymbolItem>(editor, "hv1").partId).toBe("part-1");
    // The obsolete part is refused in the grid and never reaches the drawing.
    expect(onCommitEdits).toHaveBeenCalledTimes(1);
    expect(onCommitEdits.mock.calls[0][0]).toHaveLength(2);
    expect(item<SymbolItem>(editor, "hv10").partId).toBeUndefined();
    act(() => {
      editor.undo();
    });
    expect(item<SymbolItem>(editor, "hv1").partId).toBeUndefined();
    expect(item<SymbolItem>(editor, "hv2").partId).toBeUndefined();
  });

  it("assigns one part to N selected valves with combined warnings", async () => {
    const { editor } = setup();
    fireEvent.click(screen.getByLabelText("Select all rows"));
    const bulk = screen.getByRole("region", { name: "Bulk actions" });
    expect(bulk).toHaveTextContent("3 selected");
    fireEvent.click(within(bulk).getByRole("button", { name: "Assign part…" }));
    const dialog = screen.getByRole("dialog", { name: "Assign part" });
    expect(dialog).toHaveTextContent("One part for 3 items");
    // HV-1 sits on a 3000 psig line: the 100 bar part warns for the whole selection.
    fireEvent.click(within(dialog).getByRole("option", { name: /AMB2-002/ }));
    expect(dialog.textContent).toContain("below the connected line design pressure");
    fireEvent.click(within(dialog).getByRole("button", { name: "Assign to 3" }));
    await waitFor(() => expect(["hv1", "hv2", "hv10"].map((id) => item<SymbolItem>(editor, id).partId)).toEqual(["part-2", "part-2", "part-2"]));
    expect(screen.getByRole("status")).toHaveTextContent("Assigned AMB2-002 on 3 row(s).");
    act(() => {
      editor.undo();
    });
    expect(["hv1", "hv2", "hv10"].map((id) => item<SymbolItem>(editor, id).partId)).toEqual([undefined, undefined, undefined]);

    // Clear part on a selection.
    act(() => {
      editor.redo();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear part" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Clear part" }));
    await waitFor(() => expect(item<SymbolItem>(editor, "hv1").partId).toBeNull());
  });

  it("sets the line class on selected lines and edits line cells", async () => {
    const { editor, grid } = setup({ tab: "line" });
    fireEvent.click(screen.getByLabelText("Select all rows"));
    fireEvent.change(screen.getByRole("combobox", { name: "Set line class" }), { target: { value: "SS316" } });
    await waitFor(() => expect(item<LineItem>(editor, "l1").lineClass).toBe("SS316"));
    expect(item<LineItem>(editor, "l2")).toMatchObject({ lineClass: "SS316", spec: "316L x 0.035 WALL" });

    fireEvent.click(screen.getByRole("button", { name: "Set service…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Set service" }), { target: { value: "GN2" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(item<LineItem>(editor, "l2").service).toBe("GN2"));

    // Paste a column of line classes; an unknown class is refused in the grid.
    const cls = columnIndex("Class");
    act(() => grid.focus());
    clickCell(grid, 0, cls);
    fireEvent.paste(grid, { clipboardData: { getData: () => "CS150\nXX9\n" } });
    await waitFor(() => expect(item<LineItem>(editor, "l1").lineClass).toBe("CS150"));
    expect(item<LineItem>(editor, "l2").lineClass).toBe("SS316");

    typeInto(grid, 0, columnIndex("Design P"), "200 bar", "Edit Design P");
    await waitFor(() => expect(item<LineItem>(editor, "l1").designPressure).toBe("200 bar"));
  });

  it("is read-only when the drawing cannot be edited, and still locates rows", () => {
    const { grid, onLocate, onCommitEdits } = setup({ editable: false });
    expect(screen.getByText("AMB2-9003 is released: its lists are read-only.")).toBeInTheDocument();
    act(() => grid.focus());
    clickCell(grid, 0, columnIndex("Tag"));
    fireEvent.keyDown(grid, { key: "H" });
    expect(screen.queryByRole("textbox", { name: "Edit Tag" })).toBeNull();
    fireEvent.click(screen.getByLabelText("Select row 1"));
    expect(screen.queryByRole("button", { name: "Assign part…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Locate HV-2" }));
    expect(onLocate).toHaveBeenCalledWith({ drawingId: "dw1", sheetId: "sh1", itemId: "hv2" });
    expect(onCommitEdits).not.toHaveBeenCalled();
  });
});
