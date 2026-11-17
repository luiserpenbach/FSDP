import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import type { Drawing, Lineage, LineageDiff, LineageDrawing } from "../../types";
import { DrawingLineage } from "./DrawingLineage";

const drawing = {
  id: "copy",
  project_id: "p2",
  number: "S31-0001",
  title: "LOX FEED",
  sheets: [{ id: "sh1", sheet_no: 1 }]
} as unknown as Drawing;

function entry(patch: Partial<LineageDrawing>): LineageDrawing {
  return { id: "src", number: "S30-0001", title: "LOX FEED", status: "released", revision: "C", project_id: "p1", project_name: "Ship 30", created_at: "2026-11-01T00:00:00Z", ...patch };
}

function lineage(patch: Partial<Lineage>): Lineage {
  return { drawing_id: "copy", source: null, copied_from_number: null, copied_from_revision: null, source_revision_changed: false, copies: [], ...patch };
}

function renderLineage() {
  return render(
    <MemoryRouter>
      <DrawingLineage drawing={drawing} />
    </MemoryRouter>
  );
}

describe("DrawingLineage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows nothing for a drawing that is neither a copy nor copied", async () => {
    const get = vi.spyOn(api, "getLineage").mockResolvedValue(lineage({}));
    const { container } = renderLineage();
    await waitFor(() => expect(get).toHaveBeenCalledWith("copy"));
    expect(container.textContent).toBe("");
  });

  it("links to the source, flags a newer source revision, and compares", async () => {
    vi.spyOn(api, "getLineage").mockResolvedValue(
      lineage({ source: entry({}), copied_from_number: "S30-0001", copied_from_revision: "B", source_revision_changed: true })
    );
    const diff: LineageDiff = {
      drawing_id: "copy",
      source_id: "src",
      source_number: "S30-0001",
      counts: { added: 1, removed: 1, changed: 1 },
      rows: [
        { kind: "item", change: "changed", sheet_no: 1, item_id: "a", label: "HV-101", description: "Ball valve", changes: [{ field: "tag", source: "HV-1", copy: "HV-101" }, { field: "part", source: null, copy: "VLV-9" }] },
        { kind: "item", change: "removed", sheet_no: 1, item_id: "c", label: "PT-1", description: "", changes: [] },
        { kind: "line", change: "added", sheet_no: 1, item_id: "l2", label: "LOX-02", description: "", changes: [] }
      ],
      sheets_added: [2],
      sheets_removed: [],
      stale: ["S31-0001 sheet 1"]
    };
    const getDiff = vi.spyOn(api, "getLineageDiff").mockResolvedValue(diff);
    renderLineage();

    const source = await screen.findByRole("link", { name: "S30-0001 rev B" });
    expect(source.getAttribute("href")).toBe("/drafting?project=p1&drawing=src");
    const note = source.closest("p")!;
    expect(note.textContent).toContain("in Ship 30");
    expect(note.textContent).toContain("The source is now at rev C");

    fireEvent.click(screen.getByRole("button", { name: "Compare with source" }));
    const dialog = await screen.findByRole("dialog", { name: "S31-0001 compared with S30-0001" });
    await waitFor(() => expect(getDiff).toHaveBeenCalledWith("copy"));
    expect(await within(dialog).findByText(/1 changed, 1 added here, 1 removed here/)).toBeInTheDocument();
    expect(within(dialog).getByRole("status").textContent).toContain("S31-0001 sheet 1");
    expect(dialog.textContent).toContain("Sheets only in this drawing: 2");
    // Rows still on this drawing link to the item; a removed one cannot.
    expect(within(dialog).getByRole("link", { name: "HV-101" }).getAttribute("href")).toBe("/drafting?project=p2&drawing=copy&sheet=sh1&item=a");
    expect(within(dialog).queryByRole("link", { name: "PT-1" })).toBeNull();
    expect(dialog.textContent).toContain("Tag: HV-1 → HV-101");
    expect(dialog.textContent).toContain("Part: none → VLV-9");

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the recorded origin when the source is gone or hidden", async () => {
    vi.spyOn(api, "getLineage").mockResolvedValue(lineage({ copied_from_number: "S30-0001", copied_from_revision: "B" }));
    renderLineage();
    expect(await screen.findByText("S30-0001 rev B")).toBeInTheDocument();
    expect(screen.getByLabelText("Lineage").textContent).toContain("no longer available");
    expect(screen.queryByRole("button", { name: "Compare with source" })).toBeNull();
  });

  it("lists the copies taken of a drawing and reports a failed comparison", async () => {
    vi.spyOn(api, "getLineage").mockResolvedValue(
      lineage({
        source: entry({}),
        copied_from_number: "S30-0001",
        copies: [entry({ id: "c1", number: "S31-0007", revision: "-", status: "in_review", project_id: "p2", project_name: "Ship 31" }), entry({ id: "c2", number: "S32-0001", revision: null, status: "draft", project_id: "p3", project_name: "Ship 32" })]
      })
    );
    vi.spyOn(api, "getLineageDiff").mockRejectedValue(new Error("This drawing has no source drawing to compare with."));
    renderLineage();
    expect(await screen.findByRole("link", { name: "S31-0007 rev -" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "S32-0001 · Ship 32" }).getAttribute("href")).toBe("/drafting?project=p3&drawing=c2");
    expect(screen.getByText("in review")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Compare with source" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no source drawing");
  });
});
