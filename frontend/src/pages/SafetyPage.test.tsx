import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hazard, ProjectSheetItem } from "../types";

const apiMock = vi.hoisted(() => ({
  listProjectSheetItems: vi.fn(),
  createTraceLink: vi.fn(),
  deleteTraceLink: vi.fn()
}));
const hazardApi = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: apiMock, hazardApi };
});

const workspace = vi.hoisted(() => ({
  busy: false,
  canWrite: true,
  formErrors: {} as Record<string, string>,
  runAction: vi.fn(),
  selectedProjectId: "p1",
  selectedProject: { id: "p1", name: "Vehicle" },
  requirements: [{ id: "r1", project_id: "p1", key: "REQ-1", title: "Relief on every volume" }] as unknown[]
}));

vi.mock("../workspace/WorkspaceContext", () => ({ useWorkspace: () => workspace }));

import { RiskMatrix, SafetyPage, riskLevel } from "./SafetyPage";

function hazard(overrides: Partial<Hazard>): Hazard {
  return {
    id: "h1",
    project_id: "p1",
    key: "HAZ-001",
    title: "LN2 trapped between HV-101 and HV-102",
    description: null,
    category: "trapped_fluid",
    severity: 3,
    likelihood: 4,
    risk_score: 12,
    risk_level: "high",
    mitigation: null,
    status: "open",
    owner: null,
    links: [],
    created_at: "2026-11-17T10:00:00Z",
    updated_at: "2026-11-17T10:00:00Z",
    ...overrides
  };
}

const hazards: Hazard[] = [
  hazard({}),
  hazard({ id: "h2", key: "HAZ-002", title: "Backflow into the purge supply", category: "backflow", severity: 4, likelihood: 1, risk_score: 4, risk_level: "medium" }),
  hazard({ id: "h3", key: "HAZ-003", title: "Retired hazard", severity: 3, likelihood: 4, status: "closed" })
];

const sheetItems: ProjectSheetItem[] = [
  {
    id: "si1",
    sheet_id: "s1",
    item_id: "hv1",
    kind: "symbol",
    category: "valve",
    tag: "HV-101",
    label: null,
    symbol_name: "Hand valve",
    zone: "C-4",
    part_id: null,
    drawing_id: "d1",
    drawing_number: "DWG-0001",
    drawing_title: "LN2 fill panel",
    sheet_no: 1
  }
];

function renderPage() {
  render(
    <MemoryRouter>
      <SafetyPage />
    </MemoryRouter>
  );
}

function cellIn(gridElement: HTMLElement, rowText: string, columnIndex: number): HTMLElement {
  const row = within(gridElement).getByText(rowText).closest<HTMLElement>("[role='row']");
  const cell = row?.querySelector<HTMLElement>(`[data-c='${columnIndex}']`);
  if (!cell) throw new Error(`no cell ${columnIndex} in row ${rowText}`);
  return cell;
}

async function hazardsGrid(): Promise<HTMLElement> {
  const grid = screen.getByRole("grid", { name: "Hazards" });
  await within(grid).findByText("HAZ-001");
  return grid;
}

beforeEach(() => {
  workspace.canWrite = true;
  workspace.runAction.mockImplementation(async (_message: string, action: () => Promise<void>) => {
    await action();
  });
  hazardApi.list.mockResolvedValue(hazards);
  apiMock.listProjectSheetItems.mockResolvedValue(sheetItems);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("risk matrix", () => {
  it("applies the same level rule as the server", () => {
    expect(riskLevel(1, 4)).toBe("low");
    expect(riskLevel(1, 5)).toBe("medium");
    expect(riskLevel(4, 1)).toBe("medium");
    expect(riskLevel(2, 5)).toBe("high");
    expect(riskLevel(3, 3)).toBe("medium");
  });

  it("counts hazards per severity and likelihood, leaving closed ones out", () => {
    render(<RiskMatrix hazards={hazards} />);
    const matrix = screen.getByRole("table", { name: "Risk matrix" });
    expect(within(matrix).getByLabelText("Severity 3, likelihood 4: 1 hazard")).toHaveTextContent("1");
    expect(within(matrix).getByLabelText("Severity 4, likelihood 1: 1 hazard")).toHaveTextContent("1");
    expect(within(matrix).getByLabelText("Severity 1, likelihood 1: 0 hazards")).toHaveTextContent("");
    expect(within(matrix).getByLabelText("Severity 3, likelihood 4: 1 hazard")).toHaveClass("risk-high");
    expect(screen.getByText("1 high")).toBeInTheDocument();
    expect(screen.getByText("1 medium")).toBeInTheDocument();
    expect(screen.getByText("0 low")).toBeInTheDocument();
    expect(screen.getByText(/2 of 3 hazards not closed/)).toBeInTheDocument();
  });
});

describe("SafetyPage", () => {
  it("lists the project's hazards with their derived risk", async () => {
    renderPage();
    const grid = await hazardsGrid();

    expect(hazardApi.list).toHaveBeenCalledWith("p1");
    // Columns: Key 0, Title 1, Category 2, Severity 3, Likelihood 4, Risk 5, Status 6.
    expect(cellIn(grid, "HAZ-001", 2)).toHaveTextContent("Trapped fluid");
    expect(cellIn(grid, "HAZ-001", 5)).toHaveTextContent("12 · high");
    expect(cellIn(grid, "HAZ-002", 5)).toHaveTextContent("4 · medium");
    expect(cellIn(grid, "HAZ-003", 6)).toHaveTextContent("closed");
  });

  it("edits a hazard's status inline and reloads the register", async () => {
    hazardApi.update.mockResolvedValue({ ...hazards[0], status: "mitigated" });
    renderPage();
    const grid = await hazardsGrid();

    fireEvent.doubleClick(cellIn(grid, "HAZ-001", 6));
    const editor = within(grid).getByLabelText("Edit Status");
    fireEvent.change(editor, { target: { value: "mitigated" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(hazardApi.update).toHaveBeenCalledWith("h1", { status: "mitigated" }));
    await waitFor(() => expect(hazardApi.list).toHaveBeenCalledTimes(2));
  });

  it("refuses a severity outside 1 to 4 without calling the server", async () => {
    renderPage();
    const grid = await hazardsGrid();

    fireEvent.doubleClick(cellIn(grid, "HAZ-001", 3));
    const editor = within(grid).getByLabelText("Edit Severity");
    fireEvent.change(editor, { target: { value: "7" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    // The editor stays open with the reason.
    expect(await within(grid).findByRole("alert")).toHaveTextContent("Severity is a whole number from 1 to 4");
    expect(hazardApi.update).not.toHaveBeenCalled();
  });

  it("creates a hazard from the editor with a generated key", async () => {
    const created = hazard({ id: "h9", key: "HAZ-004", title: "Ignition of vented hydrogen", category: "ignition", severity: 4, likelihood: 2, risk_score: 8, risk_level: "medium" });
    hazardApi.create.mockResolvedValue(created);
    hazardApi.list.mockResolvedValueOnce(hazards).mockResolvedValue([...hazards, created]);
    renderPage();
    await hazardsGrid();

    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: " Ignition of vented hydrogen " } });
    fireEvent.change(screen.getByRole("combobox", { name: "Category" }), { target: { value: "ignition" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Severity" }), { target: { value: "4" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Likelihood" }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Create hazard" }));

    await waitFor(() =>
      expect(hazardApi.create).toHaveBeenCalledWith("p1", {
        key: null,
        title: "Ignition of vented hydrogen",
        description: null,
        category: "ignition",
        severity: 4,
        likelihood: 2,
        mitigation: null,
        status: "open",
        owner: null
      })
    );
    expect(await screen.findByRole("heading", { name: "Hazard HAZ-004" })).toBeInTheDocument();
  });

  it("saves and deletes the open hazard", async () => {
    hazardApi.update.mockResolvedValue({ ...hazards[0], mitigation: "Thermal relief PSV-103" });
    hazardApi.remove.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    const grid = await hazardsGrid();

    fireEvent.click(within(grid).getByRole("button", { name: "HAZ-001" }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("LN2 trapped between HV-101 and HV-102");
    fireEvent.change(screen.getByRole("textbox", { name: "Mitigation" }), { target: { value: "Thermal relief PSV-103" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(hazardApi.update).toHaveBeenCalledWith("h1", expect.objectContaining({ key: "HAZ-001", mitigation: "Thermal relief PSV-103", severity: 3 })));

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(hazardApi.remove).toHaveBeenCalledWith("h1"));
    expect(window.confirm).toHaveBeenCalledWith("Delete hazard HAZ-001 and the links to drawing items and requirements?");
    expect(await screen.findByRole("heading", { name: "New hazard" })).toBeInTheDocument();
  });

  it("links the open hazard to a tagged drawing item and a requirement", async () => {
    apiMock.createTraceLink.mockResolvedValue({ id: "t1" });
    renderPage();
    const grid = await hazardsGrid();

    expect(screen.getByText("Open a hazard from the table to link it to tagged drawing items and requirements.")).toBeInTheDocument();
    fireEvent.click(within(grid).getByRole("button", { name: "HAZ-001" }));
    fireEvent.change(screen.getByRole("combobox", { name: /^Drawing item/ }), { target: { value: "si1" } });
    fireEvent.click(screen.getByRole("button", { name: "Link hazard to item" }));
    await waitFor(() =>
      expect(apiMock.createTraceLink).toHaveBeenCalledWith({ source_type: "hazard", source_id: "h1", target_type: "sheet_item", target_id: "si1", link_type: "applies_to" })
    );

    fireEvent.change(screen.getByRole("combobox", { name: /^Requirement/ }), { target: { value: "r1" } });
    fireEvent.click(screen.getByRole("button", { name: "Link hazard to requirement" }));
    await waitFor(() =>
      expect(apiMock.createTraceLink).toHaveBeenCalledWith({ source_type: "hazard", source_id: "h1", target_type: "requirement", target_id: "r1", link_type: "mitigated_by" })
    );
  });

  it("shows links with a Drafting deep link and removes them", async () => {
    const linked = hazard({
      links: [
        { id: "t1", source_type: "hazard", source_id: "h1", target_type: "sheet_item", target_id: "si1", link_type: "applies_to" },
        { id: "t2", source_type: "hazard", source_id: "h1", target_type: "requirement", target_id: "r1", link_type: "mitigated_by" }
      ]
    });
    hazardApi.list.mockResolvedValue([linked]);
    apiMock.deleteTraceLink.mockResolvedValue(undefined);
    renderPage();
    const grid = await hazardsGrid();
    // Columns: … Owner 7, Mitigation 8, Links 9.
    expect(cellIn(grid, "HAZ-001", 9)).toHaveTextContent("2");

    fireEvent.click(within(grid).getByRole("button", { name: "HAZ-001" }));
    const link = await screen.findByRole("link", { name: "HV-101 · DWG-0001 sheet 1 @ C-4" });
    expect(link).toHaveAttribute("href", "/drafting?project=p1&drawing=d1&sheet=s1&item=hv1");
    expect(screen.getByText("REQ-1 · Relief on every volume")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    await waitFor(() => expect(apiMock.deleteTraceLink).toHaveBeenCalledWith("t1"));
  });

  it("is read-only for viewers", async () => {
    workspace.canWrite = false;
    renderPage();
    const grid = await hazardsGrid();

    fireEvent.doubleClick(cellIn(grid, "HAZ-001", 6));
    expect(within(grid).queryByLabelText("Edit Status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create hazard" })).not.toBeInTheDocument();
    fireEvent.click(within(grid).getByRole("button", { name: "HAZ-001" }));
    expect(screen.queryByRole("button", { name: "Link hazard to item" })).not.toBeInTheDocument();
    expect(screen.getByText("This account is read-only.")).toBeInTheDocument();
  });

  it("reports a failed load", async () => {
    hazardApi.list.mockRejectedValue(new Error("Project not found"));
    renderPage();
    expect(await screen.findByText("Project not found")).toBeInTheDocument();
  });
});
