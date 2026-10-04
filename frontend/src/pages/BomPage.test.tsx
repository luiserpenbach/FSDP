import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BomReadiness, BomSnapshot, Drawing, ProjectBom } from "../types";

const apiMock = vi.hoisted(() => ({
  listDrawings: vi.fn(),
  listDrawingBoms: vi.fn(),
  listProjectBoms: vi.fn(),
  getBomReadiness: vi.fn(),
  generateDrawingBom: vi.fn(),
  getBomDiff: vi.fn()
}));
const setBomStatusChecked = vi.hoisted(() => vi.fn());

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: apiMock, setBomStatusChecked };
});

const workspace = vi.hoisted(() => ({
  busy: false,
  canWrite: true,
  selectedProjectId: "p1",
  notify: vi.fn(),
  runAction: vi.fn()
}));

vi.mock("../workspace/WorkspaceContext", () => ({ useWorkspace: () => workspace }));

import { WorkflowConflictError } from "../api";
import { BomPage } from "./BomPage";

const drawing = {
  id: "dw1",
  project_id: "p1",
  system_id: null,
  number: "AMB2-9003",
  title: "FILL TEST",
  size: "A3",
  units: "mm",
  discipline: "P&ID",
  status: "released",
  frame_template: "basic",
  fields: {},
  notes: [],
  sheets: [
    { id: "sh1", sheet_no: 1, title: null, source_diagram_id: null, index_stale: false },
    { id: "sh2", sheet_no: 2, title: null, source_diagram_id: null, index_stale: true }
  ],
  revisions: [],
  current_revision: null,
  created_at: "",
  updated_at: ""
} as unknown as Drawing;

const rev2: BomSnapshot = {
  id: "b2",
  diagram_id: null,
  drawing_id: "dw1",
  source_kind: "drawing",
  revision: 2,
  status: "draft",
  drawing_revision: "B",
  stale_sheets: [{ sheet_id: "sh2", sheet_no: 2, drawing_id: "dw1", drawing_number: "AMB2-9003" }],
  rows: [
    { kind: "part", part_number: "AMB2-001", description: "Ball valve", quantity: 2, unit: "ea", component_tags: ["HV-3201", "HV-3202"], sheets: [1] },
    { kind: "unassigned", part_number: null, description: "Field instrument", quantity: 1, unit: "ea", component_tags: ["PT-3222"], sheets: [2] },
    { kind: "bulk", part_number: null, description: "Tube 1/4in 316L", quantity: 10.5, unit: "m", component_tags: [], sheets: [1, 2] }
  ],
  created_at: "2026-09-12T10:00:00Z"
};
const rev1: BomSnapshot = { ...rev2, id: "b1", revision: 1, status: "released", drawing_revision: "A", stale_sheets: [], released_by: "lead@fsdp.test", released_at: "2026-09-10T10:00:00Z", rows: rev2.rows.slice(0, 1) };

const readiness: BomReadiness = {
  snapshot_id: "b2",
  row_count: 3,
  issue_count: 2,
  blocking_count: 1,
  warning_count: 1,
  ready: false,
  issues: [
    { part_number: null, component_tags: ["PT-3222"], warnings: ["No catalog part is linked to this BoM row."], code: "no_part", severity: "blocking" },
    { part_number: "AMB2-001", component_tags: ["HV-3201", "HV-3202"], warnings: ["Part is not qualified."], code: "part_incomplete", severity: "warning" }
  ]
};

const legacy: ProjectBom = { ...rev1, id: "lb1", diagram_id: "d1", drawing_id: null, source_kind: "diagram", diagram_name: "Helium panel" };

function rowsOf(table: HTMLElement): string[] {
  return within(table).getAllByRole("row").slice(1).map((row) => row.textContent ?? "");
}

describe("BomPage", () => {
  afterEach(cleanup);

  beforeEach(() => {
    Object.values(apiMock).forEach((fn) => fn.mockReset());
    setBomStatusChecked.mockReset();
    workspace.notify.mockReset();
    workspace.canWrite = true;
    workspace.runAction.mockImplementation(async (message: string, action: () => Promise<void>) => {
      await action();
      workspace.notify(message);
    });
    localStorage.clear();
    apiMock.listDrawings.mockResolvedValue([drawing]);
    apiMock.listDrawingBoms.mockResolvedValue([rev2, rev1]);
    apiMock.listProjectBoms.mockResolvedValue([rev2, rev1]);
    apiMock.getBomReadiness.mockResolvedValue(readiness);
  });

  it("lists a drawing's BoM snapshots with readiness, sortable rows, stale warnings, and exports", async () => {
    render(<BomPage />);
    await waitFor(() => expect(apiMock.listDrawingBoms).toHaveBeenCalledWith("dw1"));
    const snapshots = await screen.findByRole("table", { name: "BoM snapshots" });
    await waitFor(() => expect(rowsOf(snapshots)).toHaveLength(2));
    expect(rowsOf(snapshots)[0]).toContain("B");
    expect(rowsOf(snapshots)[0]).toContain("stale");
    expect(rowsOf(snapshots)[1]).toContain("lead@fsdp.test");

    // The newest snapshot is selected: its rows, readiness split, and exports.
    const rows = await screen.findByRole("table", { name: "BoM rows" });
    expect(rowsOf(rows)).toHaveLength(3);
    await waitFor(() => expect(within(rows).getByText("no_part")).toBeInTheDocument());
    expect(within(screen.getByRole("table", { name: "blocking" })).getByText("PT-3222")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "warnings" })).getByText("Part is not qualified.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "CSV" })).toHaveAttribute("href", expect.stringContaining("/bom/b2/csv"));
    expect(screen.getByRole("link", { name: "XLSX" })).toHaveAttribute("href", expect.stringContaining("/bom/b2/xlsx"));
    expect(screen.getAllByText(/cannot be released/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/AMB2-9003 sheet 2/, { selector: ".staleWarning" }).length).toBeGreaterThan(0);

    // Sort the rows by quantity, then descending.
    const qty = within(rows).getByRole("columnheader", { name: /Qty/ });
    fireEvent.click(within(qty).getByRole("button"));
    expect(rowsOf(rows).map((text) => text.includes("Field instrument") ? 1 : text.includes("Ball valve") ? 2 : 10.5)).toEqual([1, 2, 10.5]);
    fireEvent.click(within(qty).getByRole("button"));
    expect(qty).toHaveAttribute("aria-sort", "descending");
    expect(rowsOf(rows)[0]).toContain("Tube 1/4in 316L");

    // A released snapshot offers no release and explains it is immutable.
    fireEvent.click(within(snapshots).getByText("lead@fsdp.test", { exact: false }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "BoM rev 1" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Release…" })).toBeNull();
    expect(screen.getByText(/immutable baselines/)).toBeInTheDocument();
  });

  it("shows why a release was refused, and releases once the server accepts", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setBomStatusChecked.mockRejectedValueOnce(new WorkflowConflictError(409, "BoM revision 2 has 1 blocking issue(s) and cannot be released.", [], [readiness.issues[0]]));
    setBomStatusChecked.mockResolvedValueOnce({ ...rev2, status: "released", released_by: "eng@fsdp.test", released_at: "2026-09-13T10:00:00Z" });
    render(<BomPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Release…" }));
    const alert = await screen.findByRole("alert");
    expect(setBomStatusChecked).toHaveBeenCalledWith("b2", "released");
    expect(alert.textContent).toContain("Release refused: 1 blocking issue(s)");
    expect(alert.textContent).toContain("No catalog part is linked");
    expect(workspace.notify).toHaveBeenCalledWith("BoM revision 2 has 1 blocking issue(s) and cannot be released.", true);

    fireEvent.click(screen.getByRole("button", { name: "Release…" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Release…" })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("eng@fsdp.test")).toBeInTheDocument();
    expect(workspace.notify).toHaveBeenCalledWith("Released BoM rev 2 of AMB2-9003.");
  });

  it("generates a new snapshot and compares it with another of the same drawing", async () => {
    const rev3: BomSnapshot = { ...rev2, id: "b3", revision: 3, stale_sheets: [] };
    apiMock.generateDrawingBom.mockResolvedValue(rev3);
    apiMock.getBomDiff.mockResolvedValue({ snapshot_id: "b3", against_id: "b1", added: [rev2.rows[1]], removed: [], changed: [{ part_number: "AMB2-001", description: "Ball valve", from_quantity: 1, to_quantity: 2 }] });
    render(<BomPage />);
    await screen.findByRole("table", { name: "BoM rows" });
    apiMock.listDrawingBoms.mockResolvedValue([rev3, rev2, rev1]);
    fireEvent.click(screen.getByRole("button", { name: "Generate BoM" }));
    await waitFor(() => expect(apiMock.generateDrawingBom).toHaveBeenCalledWith("dw1"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "BoM rev 3" })).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Compare against"), { target: { value: "b1" } });
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await waitFor(() => expect(apiMock.getBomDiff).toHaveBeenCalledWith("b3", "b1"));
    expect(await screen.findByText("1 added")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Added rows" })).getByText("Field instrument")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Changed quantities" })).getByText("1 → 2")).toBeInTheDocument();
  });

  it("keeps legacy diagram BoMs as collapsed read-only history", async () => {
    apiMock.listProjectBoms.mockResolvedValue([rev2, legacy]);
    workspace.canWrite = false;
    render(<BomPage />);
    const summary = await screen.findByText(/Legacy diagram BoMs \(1\)/);
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const table = within(details).getByRole("table", { name: "Legacy diagram BoMs" });
    expect(within(table).getByText("Helium panel")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "CSV" })).toHaveAttribute("href", expect.stringContaining("/bom/lb1/csv"));
    expect(within(details).queryByRole("button", { name: "Generate BoM" })).toBeNull();
    expect(within(details).queryByRole("button", { name: "Release…" })).toBeNull();
    fireEvent.click(within(table).getByText("Helium panel"));
    expect(within(details).getByRole("table", { name: "Legacy BoM rows" })).toBeInTheDocument();
    // Viewers cannot generate or release drawing BoMs either.
    expect(screen.getByRole("button", { name: "Generate BoM" })).toBeDisabled();
  });

  it("shows no legacy section when there is no legacy history", async () => {
    render(<BomPage />);
    await screen.findByRole("table", { name: "BoM rows" });
    expect(screen.queryByText(/Legacy diagram BoMs/)).toBeNull();
  });
});
