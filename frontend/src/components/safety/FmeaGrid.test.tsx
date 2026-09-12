import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FmeaRow, Hazard, SafetySettings } from "../../types";
import { FmeaGrid } from "./FmeaGrid";
import type { RowPatch } from "./useFmeaRows";

const settings = {
  severity_scale: [],
  likelihood_scale: [],
  risk_classes: [],
  risk_matrix: {},
  fault_tolerance: {},
  rpn_threshold: 100,
  fmea_scale_max: 10,
  operating_modes: ["fast_fill", "hold"],
  hazard_categories: [],
  auto_hazard: false,
  default_hazard_severity: "I",
  default_hazard_likelihood: "C",
  approvers: []
} as unknown as SafetySettings;

function row(overrides: Partial<FmeaRow>): FmeaRow {
  return {
    id: "r1",
    worksheet_id: "w1",
    sheet_id: "s1",
    item_id: "fv201",
    subject_text: null,
    item_tag: "FV-201",
    item_category: "valve",
    item_symbol: "Pneumatic valve",
    item_zone: "C-4",
    item_exists: true,
    part_id: null,
    part_number: "AMPH-VL-022",
    sheet_no: 1,
    drawing_id: "d1",
    drawing_number: "GSE-LOX-001",
    failure_mode_id: "m1",
    failure_mode_text: null,
    failure_mode_name: "fails_closed",
    failure_mode_title: "Fails closed / fails to open",
    operating_modes: ["fast_fill"],
    cause: "",
    local_effect: "FV-201 blocks LOX; no flow downstream",
    next_effect: "",
    end_effect: "",
    detected_by_item_id: "pt205",
    detected_by_tag: "PT-205",
    detection_kind: "instrument",
    detection_reason: null,
    severity: 6,
    occurrence: null,
    detection: null,
    rpn: null,
    hazard_id: null,
    hazard_key: null,
    recommended_action: null,
    action_owner: null,
    action_due: null,
    action_status: "not_required",
    severity_residual: null,
    occurrence_residual: null,
    detection_residual: null,
    rpn_residual: null,
    notes: null,
    not_applicable: false,
    stale_reason: null,
    stale_detail: null,
    position: 1,
    controls: [],
    comment_count: 0,
    open_comment_count: 0,
    created_at: "2026-09-12T00:00:00Z",
    updated_at: "2026-09-12T00:00:00Z",
    ...overrides
  };
}

const hazards: Hazard[] = [{ id: "h9", key: "HZ-009", title: "Fast-fill overpressure" } as Hazard];

function renderGrid(rows: FmeaRow[], onPatch = vi.fn<(patches: RowPatch[]) => Promise<void>>(async () => undefined), filter: "all" | "stale" = "all") {
  render(
    <FmeaGrid projectId="p1" drawingId="d1" rows={rows} settings={settings} hazards={hazards} canWrite filter={filter} onPatch={onPatch} onUndo={async () => undefined} onRedo={async () => undefined} onRowAction={() => undefined} onOpenRow={() => undefined} />
  );
  return onPatch;
}

describe("FmeaGrid", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders rows with item, effect, detection, and RPN, and filters stale rows", () => {
    const rows = [row({}), row({ id: "r2", item_tag: "CV-203", failure_mode_title: "Reverse flow", local_effect: "LOX flows backwards through CV-203", detected_by_tag: "FT-204", stale_reason: "retagged", stale_detail: "CV-203 was retagged", severity: 7, occurrence: 4, detection: 5, rpn: 140 })];
    renderGrid(rows);
    const grid = screen.getByRole("grid", { name: "FMEA worksheet" });
    expect(within(grid).getByText("FV-201")).toBeInTheDocument();
    expect(within(grid).getByText("FV-201 blocks LOX; no flow downstream")).toBeInTheDocument();
    expect(within(grid).getByText("PT-205")).toBeInTheDocument();
    expect(within(grid).getByText("140")).toHaveClass("overThreshold");
    expect(within(grid).getAllByTitle("CV-203 was retagged").length).toBeGreaterThan(0);
    cleanup();
    renderGrid(rows, undefined, "stale");
    const filtered = screen.getByRole("grid", { name: "FMEA worksheet" });
    expect(within(filtered).queryByText("FV-201")).not.toBeInTheDocument();
    expect(within(filtered).getByText("CV-203")).toBeInTheDocument();
  });

  it("types a rating with the number keys and edits text on Enter", async () => {
    const onPatch = renderGrid([row({})]);
    const grid = screen.getByRole("grid", { name: "FMEA worksheet" });
    // Column 11 (index 10) is S, 12 is O.
    fireEvent.click(grid.querySelector('[data-cell="0:11"]')!);
    fireEvent.keyDown(grid, { key: "3" });
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith([{ id: "r1", occurrence: 3 }]));
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "0" });
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith([{ id: "r1", detection: 10 }]));

    fireEvent.click(grid.querySelector('[data-cell="0:4"]')!);
    fireEvent.keyDown(grid, { key: "Enter" });
    const input = await screen.findByLabelText("Cause");
    fireEvent.change(input, { target: { value: "Loss of actuator supply" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith([{ id: "r1", cause: "Loss of actuator supply" }]));
  });

  it("fills the active cell down the selected rows and pastes TSV, rejecting unknown hazards", async () => {
    const rows = [row({ severity: 8 }), row({ id: "r2", severity: null }), row({ id: "r3", severity: null })];
    const onPatch = renderGrid(rows);
    const grid = screen.getByRole("grid", { name: "FMEA worksheet" });
    // Clicking a cell makes it active and clears the row selection; then pick rows 2 and 3.
    fireEvent.click(grid.querySelector('[data-cell="0:10"]')!);
    const boxes = within(grid).getAllByRole("checkbox");
    fireEvent.click(boxes[1]);
    fireEvent.click(boxes[2]);
    fireEvent.keyDown(grid, { key: "d", ctrlKey: true });
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith([{ id: "r2", severity: 8 }, { id: "r3", severity: 8 }]));

    fireEvent.click(grid.querySelector('[data-cell="0:4"]')!);
    fireEvent.paste(grid, { clipboardData: { getData: () => "seat wear\tLOX passes\n\tno flow" } });
    await waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith([
        { id: "r1", cause: "seat wear", local_effect: "LOX passes" },
        { id: "r2", cause: "", local_effect: "no flow" }
      ])
    );
    fireEvent.click(grid.querySelector('[data-cell="0:15"]')!);
    fireEvent.paste(grid, { clipboardData: { getData: () => "HZ-009\nHZ-404" } });
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith([{ id: "r1", hazard_id: "h9" }]));
    expect(await screen.findByText(/Rejected: Hazard "HZ-404"/)).toBeInTheDocument();
  });

  it("opens a picker for the hazard cell and patches the pick", async () => {
    const onPatch = renderGrid([row({})]);
    const grid = screen.getByRole("grid", { name: "FMEA worksheet" });
    fireEvent.click(grid.querySelector('[data-cell="0:15"]')!);
    fireEvent.keyDown(grid, { key: "Enter" });
    const picker = await screen.findByRole("dialog", { name: "Hazard" });
    fireEvent.click(await within(picker).findByRole("option", { name: /HZ-009/ }));
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith([{ id: "r1", hazard_id: "h9" }]));
  });
});
