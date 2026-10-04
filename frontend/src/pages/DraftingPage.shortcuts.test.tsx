import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Drawing, DrawingSheet, User } from "../types";

const apiMock = vi.hoisted(() => ({
  listDrawings: vi.fn(),
  getSheet: vi.fn(),
  updateSheet: vi.fn(),
  getTagScheme: vi.fn(),
  listLineClasses: vi.fn(),
  getSheetDrc: vi.fn()
}));

vi.mock("../api", () => ({ api: apiMock }));

import { DraftingPage } from "./DraftingPage";

const user = { id: "u1", email: "eng@fsdp.test", name: "Engineer", role: "engineer", is_active: true } as User;

const drawing = {
  id: "dw1",
  project_id: "p1",
  system_id: null,
  number: "AMB2-9003",
  title: "FILL TEST",
  size: "A3",
  units: "mm",
  discipline: "P&ID",
  status: "working",
  frame_template: "basic",
  fields: {},
  notes: [],
  sheets: [
    { id: "sh1", sheet_no: 1, title: null, source_diagram_id: null },
    { id: "sh2", sheet_no: 2, title: null, source_diagram_id: null }
  ],
  revisions: [],
  created_at: "2026-09-10T10:00:00Z",
  updated_at: "2026-09-10T10:00:00Z"
} as unknown as Drawing;

function sheetWith(id: string, sheetNo: number, tag: string): DrawingSheet {
  return {
    id,
    drawing_id: "dw1",
    sheet_no: sheetNo,
    title: null,
    source_diagram_id: null,
    document: {
      schemaVersion: 1,
      sheet: { size: "A3", orientation: "landscape", frame: { kind: "basic", columns: 4, rows: 3, margin: 10 } },
      layers: [],
      items: [{ id: `hv-${id}`, kind: "symbol", layer: "symbols", symbol: { library: "fsdp", key: "hand_valve", version: 1 }, position: { x: 100, y: 100 }, rotation: 0, tag, fields: {} }],
      meta: { grid: 2.5 }
    },
    created_at: "2026-09-10T10:00:00Z",
    updated_at: "2026-09-10T10:00:00Z"
  } as DrawingSheet;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <DraftingPage projectId="p1" projectName="AMB2" systems={[]} diagrams={[]} selectedSystemId="" customSymbols={[]} user={user} canWrite notify={vi.fn()} />
    </MemoryRouter>
  );
}

describe("DraftingPage shortcuts and cross-sheet tags", () => {
  afterEach(cleanup);

  beforeEach(() => {
    Object.values(apiMock).forEach((fn) => fn.mockReset());
    localStorage.clear();
    apiMock.listDrawings.mockResolvedValue([drawing]);
    apiMock.getSheet.mockImplementation(async (id: string) => (id === "sh2" ? sheetWith("sh2", 2, "HV-1") : sheetWith("sh1", 1, "HV-1")));
    apiMock.getTagScheme.mockResolvedValue({ project_id: "p1", scheme: null });
    apiMock.listLineClasses.mockResolvedValue([]);
    apiMock.getSheetDrc.mockResolvedValue({ sheet_id: "sh1", sheet_no: 1, counts: { error: 0, warning: 0, info: 0, waived: 0 }, findings: [], waivers: [], checks: [] });
    apiMock.updateSheet.mockImplementation(async (_id: string, body: { document: unknown }) => ({ ...sheetWith("sh1", 1, "HV-1"), document: body.document }));
  });

  it("saves with Ctrl+S instead of switching tools, and flags a tag used on another sheet", async () => {
    renderPage();
    const canvas = await screen.findByTestId("schematic-canvas");
    await waitFor(() => expect(canvas.querySelector('[data-id="hv-sh1"]')).not.toBeNull());
    const panel = await screen.findByRole("article", { name: "Design rule check" });
    await waitFor(() => expect(panel.textContent).toContain("HV-1: Duplicate of HV-1 on another sheet"));

    // Not dirty: Ctrl+S is swallowed (no browser dialog) but does not save.
    const clean = fireEvent.keyDown(canvas, { key: "s", ctrlKey: true });
    expect(clean).toBe(false);
    expect(apiMock.updateSheet).not.toHaveBeenCalled();

    fireEvent.keyDown(canvas, { key: "w" });
    fireEvent.keyDown(canvas, { key: "Escape" });
    fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    fireEvent.keyDown(canvas, { key: "ArrowRight" }); // dirty the sheet
    fireEvent.keyDown(canvas, { key: "s", metaKey: true });
    await waitFor(() => expect(apiMock.updateSheet).toHaveBeenCalledTimes(1));
    const [, body] = apiMock.updateSheet.mock.calls[0] as [string, { drc: { findings: Array<{ key: string; message: string }> } }];
    expect(body.drc.findings.find((finding) => finding.key === "duplicate_tag:hv-sh1")?.message).toBe("HV-1: Duplicate of HV-1 on another sheet");
  });
});
