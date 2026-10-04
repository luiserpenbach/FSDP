import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Requirement, VerificationMatrix } from "../types";

const apiMock = vi.hoisted(() => ({
  listDrawings: vi.fn(),
  getVerificationMatrix: vi.fn(),
  listProjectSheetItems: vi.fn(),
  listTraceLinks: vi.fn(),
  updateRequirement: vi.fn(),
  createRequirement: vi.fn(),
  deleteRequirement: vi.fn()
}));
const bulk = vi.hoisted(() => ({
  bulkUpdateRequirements: vi.fn(),
  bulkDeleteRequirements: vi.fn(),
  importRequirements: vi.fn(),
  downloadRequirementsImportTemplate: vi.fn()
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: apiMock, ...bulk };
});

const requirements: Array<Requirement & { owner?: string | null }> = [
  {
    id: "r1",
    project_id: "p1",
    key: "REQ-1",
    title: "Wetted materials",
    text: "All wetted parts shall be 316L.",
    requirement_type: "materials",
    verification_method: "inspection",
    status: "draft",
    owner: null,
    constraint: { kind: "material_in", values: ["316L"], scope: {} }
  },
  {
    id: "r2",
    project_id: "p1",
    key: "REQ-2",
    title: "Relief protection",
    text: "The regulated section shall have relief.",
    requirement_type: "safety",
    verification_method: "test",
    status: "approved",
    owner: "ana",
    constraint: null
  }
];

const workspace = vi.hoisted(() => ({
  busy: false,
  canWrite: true,
  formErrors: {} as Record<string, string>,
  runAction: vi.fn(),
  selectedProjectId: "p1",
  selectedProject: { id: "p1", name: "Vehicle" },
  requirements: [] as unknown[],
  refreshRequirements: vi.fn(),
  selectedRequirementId: "",
  setSelectedRequirementId: vi.fn()
}));

vi.mock("../workspace/WorkspaceContext", () => ({ useWorkspace: () => workspace }));

import { RequirementsPage } from "./RequirementsPage";

const matrix: VerificationMatrix = {
  project_id: "p1",
  rows: [
    {
      requirement_id: "r1",
      key: "REQ-1",
      title: "Wetted materials",
      status: "draft",
      constraint: { kind: "material_in", values: ["316L"], scope: {} },
      checked: 4,
      passed: 3,
      failed: 1,
      verdict: "fail",
      drawings: [{ drawing_id: "d1", drawing_number: "AMB-100", checked: 4, failed: 1, sheets: [1, 2] }],
      linked_components: 0,
      linked_drawings: 1,
      failures: [
        { id: "c1", sheet_id: "s1", requirement_id: "r1", item_id: "i1", subject: "HV-3", zone: "B2", status: "fail", message: "Brass" }
      ]
    },
    {
      requirement_id: "r2",
      key: "REQ-2",
      title: "Relief protection",
      status: "approved",
      constraint: null,
      checked: 0,
      passed: 0,
      failed: 0,
      verdict: "manual",
      drawings: [],
      linked_components: 0,
      linked_drawings: 0,
      failures: []
    }
  ]
};

function renderPage() {
  render(
    <MemoryRouter>
      <RequirementsPage />
    </MemoryRouter>
  );
}

function requirementsGrid() {
  return screen.getByRole("grid", { name: "Requirements" });
}

function cellIn(gridElement: HTMLElement, rowText: string, columnIndex: number): HTMLElement {
  const row = within(gridElement).getByText(rowText).closest<HTMLElement>("[role='row']");
  const cell = row?.querySelector<HTMLElement>(`[data-c='${columnIndex}']`);
  if (!cell) throw new Error(`no cell ${columnIndex} in row ${rowText}`);
  return cell;
}

beforeEach(() => {
  workspace.requirements = requirements;
  workspace.canWrite = true;
  workspace.selectedRequirementId = "";
  workspace.runAction.mockImplementation(async (_message: string, action: () => Promise<void>) => {
    await action();
  });
  workspace.refreshRequirements.mockResolvedValue(requirements);
  apiMock.listDrawings.mockResolvedValue([]);
  apiMock.getVerificationMatrix.mockResolvedValue(matrix);
  apiMock.listProjectSheetItems.mockResolvedValue([]);
  apiMock.listTraceLinks.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("RequirementsPage grid", () => {
  it("changes a requirement's status inline", async () => {
    apiMock.updateRequirement.mockResolvedValue({ ...requirements[0], status: "approved" });
    renderPage();
    const grid = requirementsGrid();

    // Columns: Key 0, Title 1, Type 2, Verification 3, Status 4.
    const status = cellIn(grid, "REQ-1", 4);
    expect(status).toHaveTextContent("draft");
    fireEvent.doubleClick(status);
    const editor = within(grid).getByLabelText("Edit Status");
    fireEvent.change(editor, { target: { value: "approved" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(apiMock.updateRequirement).toHaveBeenCalledWith("r1", { status: "approved" }));
    await waitFor(() => expect(workspace.refreshRequirements).toHaveBeenCalledWith("p1"));
    expect(cellIn(grid, "REQ-1", 4)).toHaveTextContent("approved");
  });

  it("rolls the status back when the server refuses it", async () => {
    apiMock.updateRequirement.mockRejectedValue(new Error("Requirement is locked by a release"));
    renderPage();
    const grid = requirementsGrid();

    fireEvent.doubleClick(cellIn(grid, "REQ-2", 4));
    const editor = within(grid).getByLabelText("Edit Status");
    fireEvent.change(editor, { target: { value: "rejected" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(cellIn(grid, "REQ-2", 4)).toHaveAttribute("aria-invalid", "true"));
    expect(cellIn(grid, "REQ-2", 4)).toHaveTextContent("approved");
    expect(cellIn(grid, "REQ-2", 4)).toHaveAttribute("title", "Requirement is locked by a release");
    expect(workspace.refreshRequirements).not.toHaveBeenCalled();
  });

  it("sets the status of the selected requirements in one bulk edit", async () => {
    bulk.bulkUpdateRequirements.mockResolvedValue({ updated: 1, unchanged: 1, items: requirements });
    renderPage();

    fireEvent.click(within(requirementsGrid()).getByLabelText("Select all rows"));
    const actions = screen.getByRole("region", { name: "Bulk actions" });
    fireEvent.change(within(actions).getByLabelText("Set status"), { target: { value: "verified" } });

    expect(await screen.findByText("Status: updated 1 requirement, 1 already set.")).toBeInTheDocument();
    expect(bulk.bulkUpdateRequirements).toHaveBeenCalledWith("p1", ["r1", "r2"], { status: "verified" });
    expect(workspace.refreshRequirements).toHaveBeenCalledWith("p1");
  });

  it("sets verification method and owner in bulk", async () => {
    bulk.bulkUpdateRequirements.mockResolvedValue({ updated: 2, unchanged: 0, items: requirements });
    renderPage();

    fireEvent.click(within(requirementsGrid()).getByLabelText("Select all rows"));
    const actions = screen.getByRole("region", { name: "Bulk actions" });
    fireEvent.change(within(actions).getByLabelText("Set verification method"), { target: { value: "analysis" } });
    await waitFor(() => expect(bulk.bulkUpdateRequirements).toHaveBeenCalledWith("p1", ["r1", "r2"], { verification_method: "analysis" }));

    fireEvent.change(within(actions).getByLabelText("Owner for selected"), { target: { value: " bo " } });
    fireEvent.click(within(actions).getByRole("button", { name: "Set owner" }));
    await waitFor(() => expect(bulk.bulkUpdateRequirements).toHaveBeenLastCalledWith("p1", ["r1", "r2"], { owner: "bo" }));
  });

  it("bulk deletes and lists refusals", async () => {
    bulk.bulkDeleteRequirements.mockResolvedValue({
      deleted: 1,
      refused: 1,
      results: [
        { id: "r1", deleted: true, reason: null },
        { id: "r2", deleted: false, reason: "Requirement not found in this project" }
      ]
    });
    workspace.refreshRequirements.mockResolvedValue([requirements[1]]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();

    fireEvent.click(within(requirementsGrid()).getByLabelText("Select all rows"));
    fireEvent.click(within(screen.getByRole("region", { name: "Bulk actions" })).getByRole("button", { name: "Delete…" }));

    expect(await screen.findByRole("list", { name: "Refused" })).toHaveTextContent("REQ-2: Requirement not found in this project");
    expect(bulk.bulkDeleteRequirements).toHaveBeenCalledWith("p1", ["r1", "r2"]);
    expect(screen.getByText("Deleted 1 requirement; 1 refused.")).toBeInTheDocument();
  });

  it("opens a requirement in the editor from its key", async () => {
    renderPage();
    fireEvent.click(within(requirementsGrid()).getByText("REQ-2"));
    expect(workspace.setSelectedRequirementId).toHaveBeenCalledWith("r2");
  });

  it("imports pasted rows past the end through the wizard", async () => {
    bulk.importRequirements.mockResolvedValue({
      entity: "requirement",
      mode: "create_only",
      dry_run: true,
      committed: false,
      mapping: { key: "key", title: "title" },
      warnings: [],
      rows: [{ row: 1, action: "create", key: "REQ-3", id: null, errors: [], changes: { key: [null, "REQ-3"] } }],
      summary: { create: 1, update: 0, unchanged: 0, error: 0 }
    });
    renderPage();
    const grid = requirementsGrid();

    fireEvent.mouseDown(cellIn(grid, "REQ-2", 0), { button: 0 });
    fireEvent.paste(grid, { clipboardData: { getData: () => "REQ-2\tRelief protection\nREQ-3\tLeak rate\n" } });

    const dialog = await screen.findByRole("dialog", { name: "Import requirements" });
    await waitFor(() =>
      expect(bulk.importRequirements).toHaveBeenCalledWith(
        "p1",
        { headers: ["key", "title"], rows: [["REQ-3", "Leak rate"]] },
        { dryRun: true, mode: "create_only" }
      )
    );
    expect(await within(dialog).findByText("1 create")).toBeInTheDocument();
  });

  it("is read-only for viewers", async () => {
    workspace.canWrite = false;
    renderPage();
    const grid = requirementsGrid();
    fireEvent.doubleClick(cellIn(grid, "REQ-1", 4));
    expect(within(grid).queryByLabelText("Edit Status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import…" })).not.toBeInTheDocument();
  });
});

describe("RequirementsPage editor", () => {
  it("saves the status chosen in the editor form", async () => {
    workspace.selectedRequirementId = "r1";
    apiMock.updateRequirement.mockResolvedValue(requirements[0]);
    renderPage();

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "verified" } });
    fireEvent.click(screen.getByRole("button", { name: "Update selected" }));

    await waitFor(() =>
      expect(apiMock.updateRequirement).toHaveBeenCalledWith("r1", expect.objectContaining({ key: "REQ-1", status: "verified" }))
    );
  });
});

describe("Verification matrix grid", () => {
  it("shows verdicts with the requirement's method and filters by verdict", async () => {
    renderPage();
    const matrixGrid = await screen.findByRole("grid", { name: "Verification matrix" });

    // Columns: Key 0, Title 1, Verdict 2, Method 3, Checked 4.
    expect(cellIn(matrixGrid, "REQ-1", 2)).toHaveTextContent("fail");
    expect(cellIn(matrixGrid, "REQ-1", 3)).toHaveTextContent("inspection");
    expect(cellIn(matrixGrid, "REQ-1", 4)).toHaveTextContent("4");
    expect(cellIn(matrixGrid, "REQ-2", 2)).toHaveTextContent("manual");

    const matrixRoot = matrixGrid.closest<HTMLElement>(".dataGrid")!;
    fireEvent.click(within(matrixRoot).getByRole("button", { name: "Filters" }));
    fireEvent.click(within(matrixRoot).getByRole("button", { name: "Filter Verdict" }));
    const filter = screen.getByRole("dialog", { name: "Filter Verdict" });
    fireEvent.click(within(filter).getByRole("button", { name: "None" }));
    fireEvent.click(within(filter).getByLabelText("fail"));

    expect(within(matrixRoot).getByText("1 of 2 rows")).toBeInTheDocument();
    expect(within(matrixGrid).queryByText("REQ-2")).not.toBeInTheDocument();
    expect(within(matrixRoot).getByRole("button", { name: "Export XLSX" })).toBeEnabled();
    // Read-only: no editors.
    fireEvent.doubleClick(cellIn(matrixGrid, "REQ-1", 2));
    expect(workspace.setSelectedRequirementId).toHaveBeenCalledWith("r1");
  });
});
