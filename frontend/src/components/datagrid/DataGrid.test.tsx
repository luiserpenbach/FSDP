import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataGrid } from "./DataGrid";
import { columnPrefsStorageName } from "./hooks";
import type { DataGridColumn, DataGridEdit, DataGridProps } from "./types";

interface Item {
  id: string;
  tag: string;
  qty: number | null;
  status: string | null;
  active: boolean;
  note: string;
}

const ITEMS: Item[] = [
  { id: "1", tag: "HV-10", qty: 5, status: "draft", active: true, note: "a" },
  { id: "2", tag: "HV-2", qty: 1, status: "active", active: false, note: "b" },
  { id: "3", tag: "HV-1", qty: 3, status: "draft", active: false, note: "c" },
  { id: "4", tag: "PT-7", qty: null, status: "obsolete", active: true, note: "d" }
];

const COLUMNS: DataGridColumn<Item>[] = [
  { key: "tag", header: "Tag", mono: true },
  {
    key: "qty",
    header: "Qty",
    type: "number",
    editable: true,
    validate: (value) => (typeof value === "number" && value < 0 ? "Must be ≥ 0" : null)
  },
  { key: "status", header: "Status", type: "enum", options: ["draft", "active", "obsolete"], editable: true },
  { key: "active", header: "Active", type: "boolean", editable: true },
  { key: "note", header: "Note", editable: true }
];

function renderGrid(props: Partial<DataGridProps<Item>> = {}) {
  const result = render(<DataGrid ariaLabel="Items" columns={COLUMNS} getRowId={(row) => row.id} rows={ITEMS} {...props} />);
  const grid = screen.getByRole("grid", { name: "Items" });
  return { ...result, grid };
}

function bodyRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".dgBody [role='row']"));
}

function columnTexts(container: HTMLElement, c: number): string[] {
  return bodyRows(container).map((row) => row.querySelector(`[data-c='${c}']`)?.textContent ?? "");
}

function cell(container: HTMLElement, r: number, c: number): HTMLElement {
  const element = container.querySelector<HTMLElement>(`.dgBody [data-r='${r}'][data-c='${c}']`);
  if (!element) throw new Error(`cell ${r},${c} not rendered`);
  return element;
}

function focusGrid(grid: HTMLElement) {
  act(() => grid.focus());
}

function clickCell(container: HTMLElement, r: number, c: number, init: MouseEventInit = {}) {
  fireEvent.mouseDown(cell(container, r, c), { button: 0, ...init });
  fireEvent.mouseUp(cell(container, r, c), init);
}

function paste(grid: HTMLElement, text: string) {
  fireEvent.paste(grid, { clipboardData: { getData: () => text } });
}

function headerButton(name: string) {
  return within(screen.getAllByRole("columnheader").find((header) => header.textContent?.startsWith(name))!).getByRole("button");
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DataGrid sorting", () => {
  it("cycles asc / desc / none with natural tag order and aria-sort", () => {
    const { container } = renderGrid();
    fireEvent.click(headerButton("Tag"));
    expect(columnTexts(container, 0)).toEqual(["HV-1", "HV-2", "HV-10", "PT-7"]);
    expect(screen.getAllByRole("columnheader").find((h) => h.textContent?.startsWith("Tag"))).toHaveAttribute("aria-sort", "ascending");

    fireEvent.click(headerButton("Tag"));
    expect(columnTexts(container, 0)).toEqual(["PT-7", "HV-10", "HV-2", "HV-1"]);
    expect(screen.getAllByRole("columnheader").find((h) => h.textContent?.startsWith("Tag"))).toHaveAttribute("aria-sort", "descending");

    fireEvent.click(headerButton("Tag"));
    expect(columnTexts(container, 0)).toEqual(["HV-10", "HV-2", "HV-1", "PT-7"]);
    expect(screen.getAllByRole("columnheader").find((h) => h.textContent?.startsWith("Tag"))).not.toHaveAttribute("aria-sort");
  });

  it("shift-click adds a secondary sort; blanks stay last", () => {
    const { container } = renderGrid();
    fireEvent.click(headerButton("Status"));
    fireEvent.click(headerButton("Qty"), { shiftKey: true });
    expect(columnTexts(container, 0)).toEqual(["HV-2", "HV-1", "HV-10", "PT-7"]);
    expect(screen.getAllByRole("columnheader").find((h) => h.textContent?.startsWith("Qty"))?.querySelector("sup")).toHaveTextContent("2");

    // Plain click replaces the multi-sort; descending keeps the blank qty last.
    fireEvent.click(headerButton("Qty"));
    fireEvent.click(headerButton("Qty"));
    expect(columnTexts(container, 0)).toEqual(["HV-10", "HV-1", "HV-2", "PT-7"]);
  });
});

describe("DataGrid filtering", () => {
  it("applies quick filter, column text filters and enum multi-select, with N of M", () => {
    const { container } = renderGrid();
    expect(screen.getByText("4 of 4 rows")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search rows"), { target: { value: "hv" } });
    expect(screen.getByText("3 of 4 rows")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(screen.getByLabelText("Filter Qty"), { target: { value: ">2" } });
    expect(columnTexts(container, 0)).toEqual(["HV-10", "HV-1"]);
    expect(screen.getByText("2 of 4 rows")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
    expect(screen.getByText("4 of 4 rows")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Filter Status" }));
    const popover = screen.getByRole("dialog", { name: "Filter Status" });
    fireEvent.click(within(popover).getByLabelText("draft"));
    expect(columnTexts(container, 0)).toEqual(["HV-2", "PT-7"]);
    expect(screen.getByRole("button", { name: "Filter Status" })).toHaveTextContent("3 of 4");
  });

  it("shows a filtered-empty state with a reset", () => {
    renderGrid();
    fireEvent.change(screen.getByLabelText("Search rows"), { target: { value: "zzz" } });
    expect(screen.getByText("No rows match the current filters.")).toBeInTheDocument();
  });

  it("shows empty and loading states", () => {
    const { rerender } = render(
      <DataGrid columns={COLUMNS} emptyMessage="Nothing here" getRowId={(row) => row.id} rows={[]} />
    );
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    rerender(<DataGrid columns={COLUMNS} getRowId={(row) => row.id} loading rows={[]} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.getByRole("grid")).toHaveAttribute("aria-busy", "true");
  });
});

describe("DataGrid selection", () => {
  it("supports click, shift-click range and ctrl-click toggle with a bulk toolbar", () => {
    const onSelectionChange = vi.fn();
    const { container } = renderGrid({
      onSelectionChange,
      bulkActions: (rows, clear) => (
        <button onClick={clear} type="button">
          Retire {rows.length}
        </button>
      )
    });
    fireEvent.click(screen.getByLabelText("Select row 1"));
    fireEvent.click(screen.getByLabelText("Select row 3"), { shiftKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith(["1", "2", "3"]);
    expect(screen.getByRole("region", { name: "Bulk actions" })).toHaveTextContent("3 selected");
    expect(bodyRows(container).map((row) => row.getAttribute("aria-selected"))).toEqual(["true", "true", "true", "false"]);

    clickCell(container, 1, 0, { ctrlKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith(["1", "3"]);

    fireEvent.click(screen.getByRole("button", { name: "Retire 2" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
    expect(screen.queryByRole("region", { name: "Bulk actions" })).not.toBeInTheDocument();
  });

  it("select-all applies to the filtered rows only (controlled)", () => {
    const onSelectionChange = vi.fn();
    const { rerender } = renderGrid({ selectedIds: [], onSelectionChange });
    fireEvent.change(screen.getByLabelText("Search rows"), { target: { value: "PT" } });
    fireEvent.click(screen.getByLabelText("Select all rows"));
    expect(onSelectionChange).toHaveBeenLastCalledWith(["4"]);

    rerender(<DataGrid ariaLabel="Items" columns={COLUMNS} getRowId={(row) => row.id} onSelectionChange={onSelectionChange} rows={ITEMS} selectedIds={["4", "1"]} />);
    // "1" is hidden by the quick filter.
    expect(screen.getByRole("region", { name: "Bulk actions" })).toHaveTextContent("2 selected(1 hidden by filters)");
    expect(screen.getByLabelText("Select all rows")).toBeChecked();
  });
});

describe("DataGrid keyboard and editing", () => {
  it("navigates with the keyboard and commits an edit started by typing", async () => {
    const onCommit = vi.fn(async (edits: DataGridEdit[]) => {
      void edits;
    });
    const { container, grid } = renderGrid({ onCommit });
    focusGrid(grid);
    expect(grid).toHaveAttribute("aria-activedescendant", cell(container, 0, 0).id);

    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(grid).toHaveAttribute("aria-activedescendant", cell(container, 0, 1).id);
    fireEvent.keyDown(grid, { key: "End" });
    expect(grid).toHaveAttribute("aria-activedescendant", cell(container, 0, 4).id);
    fireEvent.keyDown(grid, { key: "Home" });
    fireEvent.keyDown(grid, { key: "Tab" });
    expect(grid).toHaveAttribute("aria-activedescendant", cell(container, 0, 1).id);
    fireEvent.keyDown(grid, { key: "PageDown" });
    expect(grid).toHaveAttribute("aria-activedescendant", cell(container, 3, 1).id);
    fireEvent.keyDown(grid, { key: "ArrowUp", ctrlKey: true });

    fireEvent.keyDown(grid, { key: "7" });
    const editor = screen.getByRole("textbox", { name: "Edit Qty" });
    expect(editor).toHaveValue("7");
    fireEvent.change(editor, { target: { value: "12" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith([{ rowId: "1", key: "qty", value: 12 }]);
    expect(screen.queryByRole("textbox", { name: "Edit Qty" })).not.toBeInTheDocument();
    expect(cell(container, 0, 1)).toHaveTextContent("12");
    expect(grid).toHaveAttribute("aria-activedescendant", cell(container, 1, 1).id);
    await waitFor(() => expect(cell(container, 0, 1)).not.toHaveAttribute("aria-busy"));
    expect(cell(container, 0, 1)).toHaveTextContent("12");
  });

  it("Escape cancels, validation blocks the commit, Enter on read-only activates, Space selects", () => {
    const onCommit = vi.fn(async () => undefined);
    const onRowActivate = vi.fn();
    const onSelectionChange = vi.fn();
    const { container, grid } = renderGrid({ onCommit, onRowActivate, onSelectionChange });
    focusGrid(grid);

    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onRowActivate).toHaveBeenCalledWith(ITEMS[0]);

    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "F2" });
    const editor = screen.getByRole("textbox", { name: "Edit Qty" });
    expect(editor).toHaveValue("5");
    fireEvent.change(editor, { target: { value: "99" } });
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Edit Qty" })).not.toBeInTheDocument();
    expect(cell(container, 0, 1)).toHaveTextContent("5");

    fireEvent.keyDown(grid, { key: "Enter" });
    const again = screen.getByRole("textbox", { name: "Edit Qty" });
    fireEvent.change(again, { target: { value: "-1" } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent("Must be ≥ 0");
    fireEvent.change(again, { target: { value: "abc" } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent('"abc" is not a number');
    fireEvent.keyDown(again, { key: "Escape" });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.keyDown(grid, { key: " " });
    expect(onSelectionChange).toHaveBeenLastCalledWith(["1"]);
  });

  it("edits enum and boolean cells and clears a range with Delete", () => {
    const onCommit = vi.fn(async () => undefined);
    const { container, grid } = renderGrid({ onCommit });
    focusGrid(grid);
    clickCell(container, 1, 2);
    fireEvent.keyDown(grid, { key: "o" });
    const select = screen.getByRole("combobox", { name: "Edit Status" });
    expect(select).toHaveValue("obsolete");
    fireEvent.keyDown(select, { key: "Tab" });
    expect(onCommit).toHaveBeenLastCalledWith([{ rowId: "2", key: "status", value: "obsolete" }]);

    fireEvent.click(within(cell(container, 1, 3)).getByRole("checkbox"));
    expect(onCommit).toHaveBeenLastCalledWith([{ rowId: "2", key: "active", value: true }]);

    clickCell(container, 0, 1);
    clickCell(container, 1, 4, { shiftKey: true });
    fireEvent.keyDown(grid, { key: "Delete" });
    expect(onCommit).toHaveBeenLastCalledWith([
      { rowId: "1", key: "qty", value: null },
      { rowId: "1", key: "status", value: null },
      { rowId: "1", key: "active", value: false },
      { rowId: "1", key: "note", value: "" },
      { rowId: "2", key: "qty", value: null },
      { rowId: "2", key: "status", value: null },
      { rowId: "2", key: "active", value: false },
      { rowId: "2", key: "note", value: "" }
    ]);
  });

  it("rolls back an optimistic edit and shows the error when the commit fails", async () => {
    let reject: (error: Error) => void = () => {};
    const onCommit = vi.fn(
      () =>
        new Promise<void>((_, rej) => {
          reject = rej;
        })
    );
    const { container, grid } = renderGrid({ onCommit });
    focusGrid(grid);
    clickCell(container, 0, 4);
    fireEvent.keyDown(grid, { key: "z" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit Note" }), { key: "Enter" });

    expect(cell(container, 0, 4)).toHaveTextContent("z");
    expect(cell(container, 0, 4)).toHaveAttribute("aria-busy", "true");

    await act(async () => reject(new Error("Server says no")));
    expect(cell(container, 0, 4)).toHaveTextContent("a");
    expect(cell(container, 0, 4)).not.toHaveAttribute("aria-busy");
    expect(cell(container, 0, 4)).toHaveAttribute("aria-invalid", "true");
    expect(cell(container, 0, 4)).toHaveAttribute("title", "Server says no");
  });

  it("rolls back only the cells a commit result reports as errors", async () => {
    const onCommit = vi.fn(async () => ({ errors: { "2": { note: "Too long" } } }));
    const { container, grid } = renderGrid({ onCommit });
    focusGrid(grid);
    clickCell(container, 0, 4);
    paste(grid, "x\ny\n");
    await waitFor(() => expect(cell(container, 1, 4)).toHaveAttribute("aria-invalid", "true"));
    expect(cell(container, 0, 4)).toHaveTextContent("x");
    expect(cell(container, 1, 4)).toHaveTextContent("b");
    expect(cell(container, 1, 4)).toHaveAttribute("title", "Too long");
  });
});

describe("DataGrid clipboard", () => {
  it("pastes a multi-row TSV block (quoted cells, CRLF) into the right cells as one batch", () => {
    const onCommit = vi.fn(async () => undefined);
    const { container, grid } = renderGrid({ onCommit });
    focusGrid(grid);
    clickCell(container, 1, 1);
    paste(grid, '4\tactive\tyes\t"multi\tline\nnote"\r\n9\tObsolete\tno\tplain\r\n');
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith([
      { rowId: "2", key: "qty", value: 4 },
      { rowId: "2", key: "active", value: true },
      { rowId: "2", key: "note", value: "multi\tline\nnote" },
      { rowId: "3", key: "qty", value: 9 },
      { rowId: "3", key: "status", value: "obsolete" },
      { rowId: "3", key: "note", value: "plain" }
    ]);
    // The pasted block becomes the selected range.
    expect(cell(container, 2, 4)).toHaveAttribute("aria-selected", "true");
  });

  it("skips read-only columns, flags unparseable cells and sends overflow to onPasteNewRows", () => {
    const onCommit = vi.fn(async () => undefined);
    const onPasteNewRows = vi.fn();
    const { container, grid } = renderGrid({ onCommit, onPasteNewRows });
    focusGrid(grid);
    clickCell(container, 3, 0);
    paste(grid, "NEW-1\tabc\nNEW-2\t8\tdraft\nNEW-3\t\t\tTRUE\n");
    expect(onCommit).not.toHaveBeenCalled(); // tag is read-only, qty "abc" is invalid
    expect(cell(container, 3, 1)).toHaveAttribute("aria-invalid", "true");
    expect(cell(container, 3, 1)).toHaveAttribute("title", '"abc" is not a number');
    expect(onPasteNewRows).toHaveBeenCalledWith([
      { tag: "NEW-2", qty: "8", status: "draft" },
      { tag: "NEW-3", qty: "", status: "", active: "TRUE" }
    ]);
  });

  it("fills a selected range with a single pasted value", () => {
    const onCommit = vi.fn(async () => undefined);
    const { container, grid } = renderGrid({ onCommit });
    focusGrid(grid);
    clickCell(container, 0, 1);
    clickCell(container, 2, 1, { shiftKey: true });
    paste(grid, "0\r\n");
    expect(onCommit).toHaveBeenCalledWith([
      { rowId: "1", key: "qty", value: 0 },
      { rowId: "2", key: "qty", value: 0 },
      { rowId: "3", key: "qty", value: 0 }
    ]);
  });

  it("copies a cell range as TSV and selected rows with a header", () => {
    const { container, grid } = renderGrid();
    focusGrid(grid);
    clickCell(container, 0, 0);
    clickCell(container, 1, 1, { shiftKey: true });
    const setData = vi.fn();
    fireEvent.copy(grid, { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", "HV-10\t5\nHV-2\t1");

    fireEvent.click(screen.getByLabelText("Select row 4"));
    fireEvent.copy(grid, { clipboardData: { setData } });
    expect(setData).toHaveBeenLastCalledWith("text/plain", "Tag\tQty\tStatus\tActive\tNote\nPT-7\t\tobsolete\tTRUE\td");
  });

  it("selects a range by mouse drag", () => {
    const { container, grid } = renderGrid();
    focusGrid(grid);
    fireEvent.mouseDown(cell(container, 0, 0), { button: 0 });
    fireEvent.mouseOver(cell(container, 2, 1));
    fireEvent.mouseUp(window);
    fireEvent.mouseOver(cell(container, 3, 3));
    expect(cell(container, 2, 1)).toHaveAttribute("aria-selected", "true");
    expect(cell(container, 3, 3)).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText("Count: 6")).toBeInTheDocument();
    expect(screen.getByText("Sum: 9")).toBeInTheDocument();
  });
});

describe("DataGrid export", () => {
  it("exports the visible rows and columns as escaped CSV", async () => {
    const blobs: Blob[] = [];
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return "blob:test";
      })
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const rows: Item[] = [
      { id: "a", tag: "=HYPERLINK(\"x\")", qty: -3, status: "draft", active: true, note: "@SUM(A1)" },
      { id: "b", tag: "HV-1", qty: 2, status: null, active: false, note: "a, b" }
    ];
    const onExportXlsx = vi.fn();
    render(<DataGrid columns={COLUMNS} exportFileName="items" getRowId={(row) => row.id} onExportXlsx={onExportXlsx} rows={rows} />);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(click).toHaveBeenCalled();
    const text = await blobs[0].text();
    expect(text.replace(/^\uFEFF/, "")).toBe(
      ['Tag,Qty,Status,Active,Note', `"'=HYPERLINK(""x"")",-3,draft,TRUE,'@SUM(A1)`, 'HV-1,2,,FALSE,"a, b"', ""].join("\r\n")
    );

    fireEvent.click(screen.getByRole("button", { name: "Export XLSX" }));
    expect(onExportXlsx).toHaveBeenCalledWith(rows, COLUMNS);
  });
});

describe("DataGrid virtualization and columns", () => {
  it("renders only a window of rows for 5,000 rows", () => {
    const many: Item[] = Array.from({ length: 5000 }, (_, index) => ({
      id: String(index),
      tag: `HV-${index}`,
      qty: index,
      status: "draft",
      active: false,
      note: ""
    }));
    const { container, grid } = renderGrid({ rows: many, height: 400 });
    expect(grid).toHaveAttribute("aria-rowcount", "5001");
    const initial = bodyRows(container).length;
    expect(initial).toBeGreaterThan(5);
    expect(initial).toBeLessThan(40);

    act(() => {
      grid.scrollTop = 32 * 2500;
      fireEvent.scroll(grid);
    });
    const tags = columnTexts(container, 0);
    expect(tags).toContain("HV-2505");
    expect(tags).not.toContain("HV-0");
    expect(bodyRows(container).length).toBeLessThan(40);
    const row = bodyRows(container).find((element) => element.textContent?.startsWith("HV-2505"));
    expect(row).toHaveAttribute("aria-rowindex", String(2505 + 2));

    // Keyboard navigation scrolls the window along.
    focusGrid(grid);
    fireEvent.keyDown(grid, { key: "ArrowDown", ctrlKey: true });
    expect(columnTexts(container, 0)).toContain("HV-4999");
  });

  it("hides columns from the chooser and persists the choice", () => {
    const { unmount } = renderGrid({ storageKey: "grid-test" });
    fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Choose columns" })).getByLabelText("Note"));
    expect(screen.queryByRole("columnheader", { name: /Note/ })).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(columnPrefsStorageName("grid-test")) ?? "{}")).toMatchObject({
      visibility: { note: false }
    });
    unmount();

    renderGrid({ storageKey: "grid-test" });
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["", "Tag", "Qty", "Status", "Active"]);
  });

  it("survives blocked storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderGrid({ storageKey: "grid-test" });
    fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Choose columns" })).getByLabelText("Note"));
    expect(screen.getAllByRole("columnheader")).toHaveLength(5);
  });
});
