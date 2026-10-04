import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareSortValues, sortRows, SortableTable, type SortableColumn } from "./SortableTable";

type Row = { id: string; tag: string; qty: number | null };

const rows: Row[] = [
  { id: "1", tag: "HV-10", qty: 3 },
  { id: "2", tag: "HV-2", qty: null },
  { id: "3", tag: "hv-1", qty: 12 },
  { id: "4", tag: "", qty: 1 }
];

const columns: Array<SortableColumn<Row>> = [
  { key: "tag", header: "Tag", render: (row) => row.tag || "—", sortValue: (row) => row.tag },
  { key: "qty", header: "Qty", render: (row) => String(row.qty ?? "—"), sortValue: (row) => row.qty },
  { key: "note", header: "Note", render: () => "x" }
];

const tags = () => within(screen.getByRole("table")).getAllByRole("row").slice(1).map((row) => row.firstElementChild?.textContent);

describe("sorting", () => {
  afterEach(cleanup);

  it("compares numbers numerically, text naturally, and puts empty values last", () => {
    expect(compareSortValues(2, 10)).toBeLessThan(0);
    expect(compareSortValues("HV-2", "HV-10")).toBeLessThan(0);
    expect(compareSortValues("hv-1", "HV-1")).toBe(0);
    expect(compareSortValues(null, 1)).toBeGreaterThan(0);
    expect(compareSortValues("", "a")).toBeGreaterThan(0);
    expect(sortRows(rows, columns, { key: "qty", direction: "desc" }).map((row) => row.id)).toEqual(["3", "1", "4", "2"]);
    // An unknown or unsortable column leaves the order alone.
    expect(sortRows(rows, columns, { key: "note", direction: "asc" })).toBe(rows);
  });

  it("sorts by a header click, flips on the second click, and marks aria-sort", () => {
    const onSelect = vi.fn();
    render(<SortableTable rows={rows} columns={columns} getKey={(row) => row.id} onSelect={onSelect} label="Valves" />);
    expect(tags()).toEqual(["HV-10", "HV-2", "hv-1", "—"]);
    const tagHeader = screen.getByRole("columnheader", { name: /Tag/ });
    expect(tagHeader).toHaveAttribute("aria-sort", "none");
    // Columns without a sort value are plain headers.
    expect(within(screen.getByRole("columnheader", { name: "Note" })).queryByRole("button")).toBeNull();

    fireEvent.click(within(tagHeader).getByRole("button"));
    expect(tagHeader).toHaveAttribute("aria-sort", "ascending");
    expect(tags()).toEqual(["hv-1", "HV-2", "HV-10", "—"]);
    fireEvent.click(within(tagHeader).getByRole("button"));
    expect(tagHeader).toHaveAttribute("aria-sort", "descending");
    expect(tags()).toEqual(["HV-10", "HV-2", "hv-1", "—"]);

    fireEvent.click(within(screen.getByRole("columnheader", { name: /Qty/ })).getByRole("button"));
    expect(tagHeader).toHaveAttribute("aria-sort", "none");
    expect(tags()).toEqual(["—", "HV-10", "hv-1", "HV-2"]);

    fireEvent.click(screen.getByText("HV-10"));
    expect(onSelect).toHaveBeenCalledWith(rows[0]);
  });

  it("shows the empty text and honours an initial sort", () => {
    const { unmount } = render(<SortableTable rows={[]} columns={columns} getKey={(row) => row.id} emptyText="Nothing here." />);
    expect(screen.getByText("Nothing here.")).toBeInTheDocument();
    unmount();
    render(<SortableTable rows={rows} columns={columns} getKey={(row) => row.id} initialSort={{ key: "qty", direction: "asc" }} />);
    expect(tags()).toEqual(["—", "HV-10", "hv-1", "HV-2"]);
  });
});
