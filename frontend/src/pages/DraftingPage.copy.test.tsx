import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrawingRead, DrawingSheet, Project, User } from "../types";
import type { DraftingTarget } from "./draftingLinks";

const apiMock = vi.hoisted(() => ({
  listDrawings: vi.fn(),
  getSheet: vi.fn(),
  updateSheet: vi.fn(),
  getTagScheme: vi.fn(),
  listLineClasses: vi.fn(),
  getSheetDrc: vi.fn(),
  listProjectDiagrams: vi.fn(),
  getLineage: vi.fn(),
  copyDrawing: vi.fn()
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: apiMock };
});

import { DraftingPage } from "./DraftingPage";

const engineer = { id: "u1", email: "eng@fsdp.test", name: "Engineer", role: "engineer", is_active: true } as User;
const projects = [
  { id: "p1", name: "Ship 30" },
  { id: "p2", name: "Ship 31" }
] as Project[];

function makeDrawing(patch: Partial<DrawingRead> = {}): DrawingRead {
  return {
    id: "dw1",
    project_id: "p1",
    system_id: null,
    number: "S30-0001",
    title: "LOX FEED\nAFT",
    size: "A3",
    units: "mm",
    discipline: "P&ID",
    status: "released",
    frame_template: "basic",
    fields: {},
    notes: [],
    sheets: [{ id: "sh1", sheet_no: 1, title: null, source_diagram_id: null, index_stale: false, indexed_at: null }],
    revisions: [],
    current_revision: null,
    created_at: "2026-09-10T10:00:00Z",
    updated_at: "2026-09-10T10:00:00Z",
    ...patch
  } as DrawingRead;
}

const pt = { id: "pt", kind: "symbol", layer: "symbols", symbol: { library: "fsdp", key: "instrument", version: 1 }, position: { x: 100, y: 100 }, rotation: 0, tag: "PT-3222", fields: {} };
const sheet: DrawingSheet = {
  id: "sh1",
  drawing_id: "dw1",
  sheet_no: 1,
  title: null,
  source_diagram_id: null,
  document: {
    schemaVersion: 1,
    sheet: { size: "A3", orientation: "landscape", frame: { kind: "basic", columns: 4, rows: 3, margin: 10 } },
    layers: [],
    items: [pt],
    meta: { grid: 2.5 }
  },
  created_at: "",
  updated_at: ""
} as DrawingSheet;

function renderPage(options: { canWrite?: boolean; notify?: (message: string, error?: boolean) => void; onOpenTarget?: (target: DraftingTarget) => void } = {}) {
  return render(
    <MemoryRouter>
      <DraftingPage
        projectId="p1"
        projectName="Ship 30"
        systems={[]}
        selectedSystemId=""
        customSymbols={[]}
        parts={[]}
        user={engineer}
        canWrite={options.canWrite ?? true}
        notify={options.notify ?? vi.fn()}
        projects={projects}
        onOpenTarget={options.onOpenTarget}
      />
    </MemoryRouter>
  );
}

async function openDialog() {
  const canvas = await screen.findByTestId("schematic-canvas");
  await waitFor(() => expect(canvas.querySelector('[data-id="pt"]')).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  fireEvent.click(screen.getByRole("button", { name: "Duplicate…" }));
  return screen.getByRole("dialog", { name: "Duplicate S30-0001" });
}

describe("DraftingPage duplicate drawing", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    Object.values(apiMock).forEach((fn) => fn.mockReset());
    localStorage.clear();
    apiMock.listDrawings.mockResolvedValue([makeDrawing()]);
    apiMock.getSheet.mockResolvedValue(sheet);
    apiMock.getTagScheme.mockResolvedValue({ project_id: "p1", scheme: null });
    apiMock.listLineClasses.mockResolvedValue([]);
    apiMock.listProjectDiagrams.mockResolvedValue([]);
    apiMock.getLineage.mockImplementation(async (id: string) => ({ drawing_id: id, source: null, copied_from_number: null, copied_from_revision: null, source_revision_changed: false, copies: [] }));
    apiMock.getSheetDrc.mockResolvedValue({ sheet_id: "sh1", sheet_no: 1, counts: { error: 0, warning: 0, info: 0, waived: 0 }, findings: [], waivers: [], checks: [] });
  });

  it("copies a released drawing within the project and opens the copy", async () => {
    const copy = makeDrawing({ id: "dw2", number: "S30-0002", title: "LOX FEED B\nAFT", status: "draft" });
    apiMock.copyDrawing.mockResolvedValue(copy);
    const notify = vi.fn();
    renderPage({ notify });
    const dialog = await openDialog();

    const title = within(dialog).getByLabelText("Title") as HTMLInputElement;
    expect(title.value).toBe("LOX FEED (copy)");
    fireEvent.change(title, { target: { value: "LOX FEED B" } });
    apiMock.listDrawings.mockResolvedValue([makeDrawing(), copy]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }));

    // The remaining title lines of the source are kept under the new first line.
    await waitFor(() => expect(apiMock.copyDrawing).toHaveBeenCalledWith("dw1", { project_id: "p1", number: undefined, title: "LOX FEED B\nAFT" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Created S30-0002 as a copy of S30-0001."));
    expect(screen.queryByRole("dialog", { name: "Duplicate S30-0001" })).toBeNull();
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Drawing" }) as HTMLSelectElement).value).toBe("dw2"));
  });

  it("copies into another project and offers to open it there", async () => {
    apiMock.copyDrawing.mockResolvedValue(makeDrawing({ id: "dw9", project_id: "p2", number: "S31-0001", status: "draft" }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const notify = vi.fn();
    const onOpenTarget = vi.fn();
    renderPage({ notify, onOpenTarget });
    const dialog = await openDialog();

    fireEvent.change(within(dialog).getByLabelText("Into project"), { target: { value: "p2" } });
    fireEvent.change(within(dialog).getByLabelText("Drawing number"), { target: { value: " S31-0001 " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }));

    await waitFor(() => expect(apiMock.copyDrawing).toHaveBeenCalledWith("dw1", { project_id: "p2", number: "S31-0001", title: "LOX FEED (copy)\nAFT" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Copied S30-0001 to Ship 31 as S31-0001."));
    expect(onOpenTarget).toHaveBeenCalledWith({ projectId: "p2", drawingId: "dw9" });
    // The open drawing of this project stays as it was.
    expect((screen.getByRole("combobox", { name: "Drawing" }) as HTMLSelectElement).value).toBe("dw1");
  });

  it("keeps the dialog open and reports a refused copy", async () => {
    apiMock.copyDrawing.mockRejectedValue(new Error("Drawing number already exists in project"));
    const notify = vi.fn();
    renderPage({ notify });
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Drawing number already exists in project", true));
    expect(screen.getByRole("dialog", { name: "Duplicate S30-0001" })).toBeInTheDocument();
  });

  it("does not offer duplication to viewers", async () => {
    renderPage({ canWrite: false });
    const canvas = await screen.findByTestId("schematic-canvas");
    await waitFor(() => expect(canvas.querySelector('[data-id="pt"]')).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.queryByRole("button", { name: "Duplicate…" })).toBeNull();
  });
});
