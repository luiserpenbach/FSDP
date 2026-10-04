import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrawingRead, DrawingRevisionRead, DrawingSheet, RevisionSnapshot, User } from "../types";

const apiMock = vi.hoisted(() => ({
  listDrawings: vi.fn(),
  getSheet: vi.fn(),
  updateSheet: vi.fn(),
  getTagScheme: vi.fn(),
  listLineClasses: vi.fn(),
  getSheetDrc: vi.fn(),
  updateDrawing: vi.fn()
}));
const workflowMock = vi.hoisted(() => ({
  submitDrawing: vi.fn(),
  withdrawDrawing: vi.fn(),
  releaseDrawing: vi.fn(),
  reviseDrawing: vi.fn(),
  getRevisionSnapshot: vi.fn()
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: apiMock, ...workflowMock };
});

import { WorkflowConflictError } from "../api";
import { DraftingPage } from "./DraftingPage";

const engineer = { id: "u1", email: "eng@fsdp.test", name: "Engineer", role: "engineer", is_active: true } as User;

const revA: DrawingRevisionRead = {
  id: "r1",
  drawing_id: "dw1",
  sequence: 1,
  label: "A",
  description: "Initial issue",
  status: "released",
  drawn_by: "Engineer",
  drawn_date: "2026-09-10",
  checked_by: null,
  checked_date: null,
  submitted_by: "eng@fsdp.test",
  submitted_at: "2026-09-11T09:00:00Z",
  approved_by: "lead@fsdp.test",
  approved_date: "2026-09-12",
  approved_at: "2026-09-12T10:00:00Z",
  created_at: "2026-09-10T10:00:00Z"
};
const revB: DrawingRevisionRead = {
  ...revA,
  id: "r2",
  sequence: 2,
  label: "B",
  description: "Add vent",
  status: "draft",
  submitted_by: null,
  submitted_at: null,
  approved_by: null,
  approved_date: null,
  approved_at: null
};

function makeDrawing(patch: Partial<DrawingRead> = {}): DrawingRead {
  return {
    id: "dw1",
    project_id: "p1",
    system_id: null,
    number: "AMB2-9003",
    title: "FILL TEST",
    size: "A3",
    units: "mm",
    discipline: "P&ID",
    status: "draft",
    frame_template: "basic",
    fields: {},
    notes: [],
    sheets: [
      { id: "sh1", sheet_no: 1, title: null, source_diagram_id: null, index_stale: false, indexed_at: null },
      { id: "sh2", sheet_no: 2, title: "Vent", source_diagram_id: null, index_stale: false, indexed_at: null }
    ],
    revisions: [revA, revB],
    current_revision: revB,
    created_at: "2026-09-10T10:00:00Z",
    updated_at: "2026-09-10T10:00:00Z",
    ...patch
  };
}

const releasedDrawing = () => makeDrawing({ status: "released", revisions: [revA], current_revision: revA });

function sheetDoc(items: unknown[]) {
  return {
    schemaVersion: 1,
    sheet: { size: "A3", orientation: "landscape", frame: { kind: "basic", columns: 4, rows: 3, margin: 10 } },
    layers: [],
    items,
    meta: { grid: 2.5 }
  };
}

const pt = { id: "pt", kind: "symbol", layer: "symbols", symbol: { library: "fsdp", key: "instrument", version: 1 }, position: { x: 100, y: 100 }, rotation: 0, tag: "PT-3222", fields: {} };
const hv = { id: "hv", kind: "symbol", layer: "symbols", symbol: { library: "fsdp", key: "hand_valve", version: 1 }, position: { x: 60, y: 140 }, rotation: 0, tag: "HV-3201", fields: {} };

function sheet(id: string, sheetNo: number, items: unknown[]): DrawingSheet {
  return { id, drawing_id: "dw1", sheet_no: sheetNo, title: null, source_diagram_id: null, document: sheetDoc(items), created_at: "", updated_at: "" };
}

const sheets: Record<string, DrawingSheet> = { sh1: sheet("sh1", 1, [pt]), sh2: sheet("sh2", 2, [hv]) };

function renderPage({ canWrite = true, notify = vi.fn() }: { canWrite?: boolean; notify?: (message: string, error?: boolean) => void } = {}) {
  return render(
    <MemoryRouter>
      <DraftingPage projectId="p1" projectName="AMB2" systems={[]} diagrams={[]} selectedSystemId="" customSymbols={[]} parts={[]} user={engineer} canWrite={canWrite} notify={notify} />
    </MemoryRouter>
  );
}

async function openCanvas() {
  const canvas = await screen.findByTestId("schematic-canvas");
  await waitFor(() => expect(canvas.querySelector('[data-id="pt"]')).not.toBeNull());
  return canvas;
}

describe("DraftingPage release workflow", () => {
  afterEach(cleanup);

  beforeEach(() => {
    Object.values(apiMock).forEach((fn) => fn.mockReset());
    Object.values(workflowMock).forEach((fn) => fn.mockReset());
    localStorage.clear();
    apiMock.listDrawings.mockResolvedValue([makeDrawing()]);
    apiMock.getSheet.mockImplementation(async (id: string) => sheets[id]);
    apiMock.getTagScheme.mockResolvedValue({ project_id: "p1", scheme: null });
    apiMock.listLineClasses.mockResolvedValue([]);
    apiMock.getSheetDrc.mockImplementation(async (id: string) => ({ sheet_id: id, sheet_no: 1, counts: { error: 0, warning: 0, info: 0, waived: 0 }, findings: [], waivers: [], checks: [] }));
    apiMock.updateSheet.mockImplementation(async (id: string, body: { document?: unknown }) => ({ ...sheets[id], document: body.document ?? sheets[id].document }));
  });

  it("offers submit and release on a draft, and withdraw on a drawing in review", async () => {
    workflowMock.submitDrawing.mockResolvedValue(makeDrawing({ status: "in_review", current_revision: { ...revB, status: "in_review" } }));
    workflowMock.withdrawDrawing.mockResolvedValue(makeDrawing());
    const notify = vi.fn();
    renderPage({ notify });
    await openCanvas();
    const workflow = screen.getByRole("region", { name: "Release workflow" });
    expect(workflow.textContent).toContain("draft");
    expect(within(workflow).queryByRole("button", { name: "Withdraw" })).toBeNull();
    // The old free-form status select is gone.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("combobox", { name: "Status" })).toBeNull();

    fireEvent.click(within(workflow).getByRole("button", { name: "Submit for review" }));
    await waitFor(() => expect(workflowMock.submitDrawing).toHaveBeenCalledWith("dw1"));
    await waitFor(() => expect(workflow.textContent).toContain("in review"));
    expect(notify).toHaveBeenCalledWith("Submitted AMB2-9003 rev B for review.");
    expect(within(workflow).getByRole("button", { name: "Release…" })).toBeEnabled();

    fireEvent.click(within(workflow).getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(workflowMock.withdrawDrawing).toHaveBeenCalledWith("dw1"));
    await waitFor(() => expect(within(workflow).getByRole("button", { name: "Submit for review" })).toBeInTheDocument());
  });

  it("confirms a release, then lists the refusal reasons with jump-to-sheet and re-index", async () => {
    workflowMock.releaseDrawing.mockRejectedValue(
      new WorkflowConflictError(409, "Drawing AMB2-9003 cannot be released yet.", [
        { code: "index_stale", sheet_id: "sh1", sheet_no: 1, message: "Sheet 1: index and design rule checks are out of date; open and save the sheet." },
        { code: "drc_errors", sheet_id: "sh2", sheet_no: 2, count: 2, message: "Sheet 2: 2 open design rule error(s); fix or waive them." }
      ])
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    const notify = vi.fn();
    renderPage({ notify });
    await openCanvas();
    const workflow = screen.getByRole("region", { name: "Release workflow" });

    // Cancelling the confirmation sends nothing.
    fireEvent.click(within(workflow).getByRole("button", { name: "Release…" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Release AMB2-9003 rev B?"));
    expect(workflowMock.releaseDrawing).not.toHaveBeenCalled();

    fireEvent.click(within(workflow).getByRole("button", { name: "Release…" }));
    const alert = await within(workflow).findByRole("alert");
    expect(workflowMock.releaseDrawing).toHaveBeenCalledWith("dw1");
    expect(alert.textContent).toContain("Release refused");
    expect(notify).toHaveBeenCalledWith("Drawing AMB2-9003 cannot be released yet.", true);

    // "Re-index now" re-derives the stale sheet from its stored document.
    fireEvent.click(within(alert).getByRole("button", { name: "Re-index now" }));
    await waitFor(() => expect(apiMock.updateSheet).toHaveBeenCalledTimes(1));
    const [savedId, body] = apiMock.updateSheet.mock.calls[0] as [string, { document: { items: Array<{ id: string }> }; index: { items: unknown[] }; drc: { findings: unknown[]; checks: unknown[] } }];
    expect(savedId).toBe("sh1");
    expect(body.document.items.map((item) => item.id)).toEqual(["pt"]);
    expect(body.index.items).toHaveLength(1);
    expect(Array.isArray(body.drc.findings)).toBe(true);
    // The re-indexed sheet's reason goes away.
    await waitFor(() => expect(alert.textContent).not.toContain("Sheet 1: index"));

    // A DRC reason opens its sheet.
    fireEvent.click(within(alert).getByRole("button", { name: /Sheet 2: 2 open design rule error/ }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "2" })).toHaveAttribute("aria-selected", "true"));
    confirm.mockRestore();
  });

  it("re-indexes stale sheets in the background but never the open sheet with unsaved edits", async () => {
    apiMock.listDrawings.mockResolvedValue([
      makeDrawing({
        sheets: [
          { id: "sh1", sheet_no: 1, title: null, source_diagram_id: null, index_stale: true, indexed_at: null },
          { id: "sh2", sheet_no: 2, title: "Vent", source_diagram_id: null, index_stale: true, indexed_at: null }
        ]
      })
    ]);
    // Hold the tag scheme: the re-index waits for it, which leaves time to edit sheet 1.
    let resolveScheme!: (value: unknown) => void;
    apiMock.getTagScheme.mockReturnValue(new Promise((resolve) => (resolveScheme = resolve)));
    renderPage();
    const canvas = await openCanvas();
    expect(screen.getByRole("tab", { name: "1" }).className).toContain("stale");
    fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(await screen.findByRole("button", { name: "Save" })).toBeEnabled();
    expect(apiMock.updateSheet).not.toHaveBeenCalled();

    resolveScheme({ project_id: "p1", scheme: null });
    await waitFor(() => expect(apiMock.updateSheet).toHaveBeenCalledTimes(1));
    const [indexedId, body] = apiMock.updateSheet.mock.calls[0] as [string, { document: unknown; index: unknown; drc: unknown }];
    expect(indexedId).toBe("sh2");
    expect(body.document).toBeTruthy();
    expect(body.index).toBeTruthy();
    expect(body.drc).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Sheet 1 out of date")).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "2" }).className).not.toContain("stale");

    // Saving indexes the open sheet; then everything is current.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiMock.updateSheet).toHaveBeenCalledTimes(2));
    expect(apiMock.updateSheet.mock.calls[1][0]).toBe("sh1");
    await waitFor(() => expect(screen.getByText("Index up to date")).toBeInTheDocument());
  });

  it("keeps edits made while a save is in flight unsaved", async () => {
    let resolveSave!: (value: DrawingSheet) => void;
    apiMock.updateSheet.mockReturnValue(new Promise<DrawingSheet>((resolve) => (resolveSave = resolve)));
    renderPage();
    const canvas = await openCanvas();
    fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiMock.updateSheet).toHaveBeenCalledTimes(1));
    const sent = (apiMock.updateSheet.mock.calls[0][1] as { document: { items: Array<{ position: { x: number } }> } }).document.items[0].position.x;
    // Another edit lands before the response.
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    resolveSave(sheets.sh1);
    await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(sent).toBe(102.5);
  });

  it("locks a released drawing: read-only canvas and inspector, banner, and a new revision unlocks it", async () => {
    apiMock.listDrawings.mockResolvedValue([releasedDrawing()]);
    workflowMock.reviseDrawing.mockResolvedValue(makeDrawing({ status: "draft" }));
    const notify = vi.fn();
    renderPage({ notify });
    const canvas = await openCanvas();
    await waitFor(() => expect(canvas).toHaveAttribute("data-readonly", "true"));
    expect(screen.getByText(/start a new revision to edit/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Wire/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Measure/ })).toBeEnabled();
    expect(screen.getByTitle("Released: start a new revision to add sheets")).toBeDisabled();

    // Selecting works, editing does not.
    fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    const tag = (await screen.findByLabelText("Tag")) as HTMLInputElement;
    expect(tag).toBeDisabled();
    fireEvent.keyDown(canvas, { key: "Delete" });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(canvas.querySelector('[data-id="pt"]')).not.toBeNull();
    expect(screen.getByText("Saved", { selector: ".draftingStatus span" })).toBeInTheDocument();
    expect(apiMock.updateSheet).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Start new revision" }));
    await waitFor(() => expect(workflowMock.reviseDrawing).toHaveBeenCalledWith("dw1", undefined));
    await waitFor(() => expect(canvas).not.toHaveAttribute("data-readonly"));
    expect(screen.queryByText(/start a new revision to edit/)).toBeNull();
    expect(screen.getByLabelText("Tag")).toBeEnabled();
    expect(notify).toHaveBeenCalledWith("Started revision B of AMB2-9003; the drawing is editable again.");
  });

  it("starts a revision with a label and description from the workflow panel", async () => {
    apiMock.listDrawings.mockResolvedValue([releasedDrawing()]);
    workflowMock.reviseDrawing.mockResolvedValue(makeDrawing());
    renderPage();
    await openCanvas();
    const workflow = screen.getByRole("region", { name: "Release workflow" });
    fireEvent.click(within(workflow).getByRole("button", { name: "Start new revision…" }));
    fireEvent.change(within(workflow).getByLabelText("New revision label"), { target: { value: "B" } });
    fireEvent.change(within(workflow).getByLabelText("New revision description"), { target: { value: "Add vent" } });
    fireEvent.click(within(workflow).getByRole("button", { name: "Start revision" }));
    await waitFor(() => expect(workflowMock.reviseDrawing).toHaveBeenCalledWith("dw1", { label: "B", description: "Add vent" }));
  });

  it("is read-only for viewers, with no workflow actions and no background re-index", async () => {
    apiMock.listDrawings.mockResolvedValue([makeDrawing({ sheets: [{ id: "sh1", sheet_no: 1, title: null, source_diagram_id: null, index_stale: true, indexed_at: null }] })]);
    renderPage({ canWrite: false });
    const canvas = await openCanvas();
    await waitFor(() => expect(canvas).toHaveAttribute("data-readonly", "true"));
    expect(screen.getByText(/View only/)).toBeInTheDocument();
    const workflow = screen.getByRole("region", { name: "Release workflow" });
    expect(within(workflow).queryAllByRole("button")).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(apiMock.updateSheet).not.toHaveBeenCalled();
  });

  it("shows server-stamped signatures and opens a released revision's snapshot read-only", async () => {
    const snapshot: RevisionSnapshot = {
      revision_id: "r1",
      drawing_id: "dw1",
      label: "A",
      sequence: 1,
      status: "released",
      approved_by: "lead@fsdp.test",
      approved_at: "2026-09-12T10:00:00Z",
      snapshot: {
        schema_version: 1,
        released_at: "2026-09-12T10:00:00Z",
        released_by: "lead@fsdp.test",
        drawing: { id: "dw1", number: "AMB2-9003", title: "FILL TEST" },
        revision: { id: "r1", label: "A", sequence: 1 },
        sheets: [
          { id: "sh1", sheet_no: 1, title: "Main", document: sheetDoc([pt]), items: [{ item_id: "pt" }], lines: [], drc: { findings: [{ id: "f1", sheet_id: "sh1", key: "open_port:pt:process", rule: "open_port", severity: "error", message: "open", item_id: "pt", subject: "PT-3222", zone: null, requirement_id: null }], waivers: [] } },
          { id: "sh2", sheet_no: 2, title: "Vent", document: sheetDoc([hv]), items: [], lines: [], drc: { findings: [], waivers: [] } }
        ]
      }
    };
    workflowMock.getRevisionSnapshot.mockResolvedValue(snapshot);
    renderPage();
    await openCanvas();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const table = document.querySelector(".drawingPanel .revisionTable") as HTMLTableElement;
    expect(table.textContent).toContain("D: Engineer · 2026-09-10");
    expect(table.textContent).toContain("S: eng@fsdp.test · 2026-09-11");
    expect(table.textContent).toContain("A: lead@fsdp.test · 2026-09-12");
    // No hand-typed approvals any more.
    expect(table.querySelector("input")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add revision" })).toBeNull();
    // Only the released revision has a snapshot.
    expect(within(table).getAllByRole("button")).toHaveLength(1);

    fireEvent.click(within(table).getByRole("button", { name: "View released snapshot of revision A" }));
    const dialog = await screen.findByRole("dialog", { name: "Released revision A" });
    expect(workflowMock.getRevisionSnapshot).toHaveBeenCalledWith("r1");
    await waitFor(() => expect(dialog.textContent).toContain("Released by lead@fsdp.test"));
    expect(dialog.textContent).toContain("Main");
    expect(dialog.textContent).toContain("Vent");
    const preview = within(dialog).getByRole("img", { name: "Sheet 1 as released" }) as HTMLImageElement;
    expect(decodeURIComponent(preview.src)).toContain(">3222<");
    fireEvent.click(within(dialog).getByText("Vent"));
    expect(within(dialog).getByRole("img", { name: "Sheet 2 as released" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Download SVG" })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
