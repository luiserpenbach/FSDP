import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagram, Drawing, DrawingSheet, FluidSystem, User } from "../types";

const apiMock = vi.hoisted(() => ({
  listDrawings: vi.fn(),
  createDrawing: vi.fn(),
  updateDrawing: vi.fn(),
  deleteDrawing: vi.fn(),
  getSheet: vi.fn(),
  updateSheet: vi.fn(),
  createSheet: vi.fn(),
  deleteSheet: vi.fn(),
  createRevision: vi.fn(),
  updateRevision: vi.fn(),
  exportSheet: vi.fn(),
  getSchematic: vi.fn(),
  getDiagram: vi.fn(),
  getTagScheme: vi.fn(),
  updateTagScheme: vi.fn(),
  updateSymbol: vi.fn()
}));

vi.mock("../api", () => ({ api: apiMock }));

import { DraftingPage } from "./DraftingPage";

const user: User = { id: "u1", email: "eng@fsdp.test", name: "Engineer", role: "engineer", is_active: true } as User;
const systems: FluidSystem[] = [{ id: "s1", project_id: "p1", name: "Helium fill", fluid: "GHe", description: "" } as FluidSystem];

const legacyDiagram: Diagram = {
  id: "d1",
  system_id: "s1",
  name: "Helium panel",
  diagram_type: "pid",
  revision: 3,
  graph: {
    nodes: [
      { id: "v1", type: "pidSymbol", position: { x: 40, y: 40 }, style: { width: 56, height: 50 }, data: { symbolType: "valve", label: "v1", tag: "HV-1", rotation: 0 } },
      { id: "s1", type: "pidSymbol", position: { x: 200, y: 40 }, style: { width: 56, height: 50 }, data: { symbolType: "sensor", label: "PT", tag: "PT-2" } }
    ],
    edges: [{ id: "e1", source: "v1", sourceHandle: "out", target: "s1", targetHandle: "process", data: { fluid: "GHe" } }]
  }
};

const drawing: Drawing = {
  id: "dw1",
  project_id: "p1",
  system_id: "s1",
  number: "AMB2-9003",
  title: "BROAD AREA COOLING\nP&ID\nFILL TEST",
  size: "A3",
  units: "mm",
  discipline: "P&ID",
  status: "working",
  frame_template: "fsdp-standard",
  fields: { company: "Sierra Lobo" },
  notes: ["ALL LINES 1/4 IN"],
  sheets: [
    { id: "sh1", sheet_no: 1, title: null, source_diagram_id: null },
    { id: "sh2", sheet_no: 2, title: "Vent", source_diagram_id: null }
  ],
  revisions: [
    {
      id: "r1",
      drawing_id: "dw1",
      sequence: 1,
      label: "-",
      description: "Initial issue",
      status: "working",
      drawn_by: "Engineer",
      drawn_date: "2026-09-10",
      checked_by: null,
      checked_date: null,
      approved_by: null,
      approved_date: null,
      created_at: "2026-09-10T10:00:00Z"
    }
  ],
  created_at: "2026-09-10T10:00:00Z",
  updated_at: "2026-09-10T10:00:00Z"
};

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
    items: [
      {
        id: "pt",
        kind: "symbol",
        layer: "symbols",
        symbol: { library: "fsdp", key: "instrument", version: 1 },
        position: { x: 100, y: 100 },
        rotation: 0,
        tag: "PT-3222",
        fields: {}
      }
    ],
    meta: { grid: 2.5 }
  },
  created_at: "2026-09-10T10:00:00Z",
  updated_at: "2026-09-10T10:00:00Z"
};

function renderPage(notify = vi.fn()) {
  return render(
    <DraftingPage
      projectId="p1"
      projectName="AMB2"
      systems={systems}
      diagrams={[legacyDiagram]}
      selectedSystemId="s1"
      customSymbols={[]}
      user={user}
      canWrite
      notify={notify}
    />
  );
}

describe("DraftingPage", () => {
  afterEach(cleanup);

  beforeEach(() => {
    Object.values(apiMock).forEach((fn) => fn.mockReset());
    localStorage.clear();
    apiMock.listDrawings.mockResolvedValue([drawing]);
    apiMock.getSheet.mockResolvedValue(sheet);
    apiMock.getTagScheme.mockResolvedValue({ project_id: "p1", scheme: null });
    apiMock.updateSheet.mockImplementation(async (_id: string, body: { document: unknown }) => ({ ...sheet, document: body.document }));
  });

  it("opens the first sheet of the first drawing with a bound title block and saves it", async () => {
    const notify = vi.fn();
    renderPage(notify);
    const canvas = await screen.findByTestId("schematic-canvas");
    await waitFor(() => expect(canvas.querySelector('[data-id="pt"]')).not.toBeNull());
    expect(apiMock.getSheet).toHaveBeenCalledWith("sh1");
    // Title block bound from the drawing and revision rows.
    expect(canvas.textContent).toContain("AMB2-9003");
    expect(canvas.textContent).toContain("BROAD AREA COOLING");
    expect(canvas.textContent).toContain("1 OF 2");
    expect(canvas.textContent).toContain("Initial issue");
    expect(canvas.textContent).toContain("GENERAL NOTES:");
    expect(canvas.textContent).toContain("Sierra Lobo");
    expect(screen.getByRole("tab", { name: "1" })).toHaveAttribute("aria-selected", "true");

    // Edit, then save to the sheet endpoint.
    fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    const tagInput = (await screen.findByLabelText("Tag")) as HTMLInputElement;
    fireEvent.change(tagInput, { target: { value: "PT-3223" } });
    await waitFor(() => expect(canvas.textContent).toContain("3223"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiMock.updateSheet).toHaveBeenCalledTimes(1));
    const [savedId, body] = apiMock.updateSheet.mock.calls[0] as [string, { document: { items: Array<{ tag?: string }>; sheet: { frame: { template?: string } } } }];
    expect(savedId).toBe("sh1");
    expect(body.document.items[0].tag).toBe("PT-3223");
    expect(body.document.sheet.frame.template).toBe("fsdp-standard");
    expect(notify).toHaveBeenCalledWith("Saved AMB2-9003 sheet 1.");
  });

  it("converts a legacy diagram into a new drawing", async () => {
    apiMock.getSchematic.mockResolvedValue({ diagram_id: "d1", revision: 3, document: null });
    apiMock.getDiagram.mockResolvedValue(legacyDiagram);
    apiMock.createDrawing.mockResolvedValue({ ...drawing, id: "dw2", number: "AMB2-0002", title: "Helium panel" });
    renderPage();
    await screen.findByTestId("schematic-canvas");

    fireEvent.click(screen.getByRole("button", { name: "Convert diagram…" }));
    fireEvent.click(screen.getByRole("button", { name: "Convert" }));
    await waitFor(() => expect(apiMock.createDrawing).toHaveBeenCalledTimes(1));
    const [projectId, body] = apiMock.createDrawing.mock.calls[0] as [
      string,
      { title: string; system_id: string | null; first_sheet: { document: { items: Array<{ id: string }> }; source_diagram_id: string } }
    ];
    expect(projectId).toBe("p1");
    expect(body.title).toBe("Helium panel");
    expect(body.system_id).toBe("s1");
    expect(body.first_sheet.source_diagram_id).toBe("d1");
    expect(body.first_sheet.document.items.map((item) => item.id).sort()).toEqual(["e1", "s1", "v1"]);
    await waitFor(() => expect(apiMock.listDrawings).toHaveBeenCalledTimes(2));
  });

  it("exports the sheet through the server with the rendered SVG", async () => {
    apiMock.exportSheet.mockResolvedValue({ blob: new Blob(["%PDF"], { type: "application/pdf" }), filename: "AMB2-9003-01-rev0.pdf" });
    const createObjectURL = vi.fn(() => "blob:fake");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const notify = vi.fn();
    renderPage(notify);
    const canvas = await screen.findByTestId("schematic-canvas");
    await waitFor(() => expect(canvas.querySelector('[data-id="pt"]')).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "PDF" }));
    await waitFor(() => expect(apiMock.exportSheet).toHaveBeenCalledTimes(1));
    const [sheetId, body] = apiMock.exportSheet.mock.calls[0] as [string, { svg: string; format: string; dpi: number }];
    expect(sheetId).toBe("sh1");
    expect(body.format).toBe("pdf");
    expect(body.svg).toContain('width="420mm"');
    expect(body.svg).toContain(">AMB2-9003<");
    expect(body.svg).toContain("PROPRIETARY");
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(notify).toHaveBeenCalledWith("Exported AMB2-9003-01-rev0.pdf.");
  });

  it("validates tags against a structured project scheme and assigns actuators from the inspector", async () => {
    apiMock.getTagScheme.mockResolvedValue({
      project_id: "p1",
      scheme: {
        kind: "structured",
        separator: " ",
        systems: [{ digit: "3", name: "Helium" }, { digit: "4", name: "Nitrogen" }],
        classes: [{ digit: "2", name: "Test hardware" }],
        sequenceLength: 2
      }
    });
    apiMock.getSheet.mockResolvedValue({
      ...sheet,
      document: {
        ...sheet.document,
        items: [
          { id: "hv", kind: "symbol", layer: "symbols", symbol: { library: "fsdp", key: "ball_valve", version: 1 }, position: { x: 100, y: 100 }, rotation: 0, tag: "HV-3201", fields: {} }
        ]
      }
    });
    renderPage();
    const canvas = await screen.findByTestId("schematic-canvas");
    await waitFor(() => expect(canvas.querySelector('[data-id="hv"]')).not.toBeNull());
    // The scheme's system/class pickers appear and the tag check flags the hyphenated tag.
    await screen.findByLabelText("Tag system");
    await waitFor(() => expect(screen.getByText(/1 tag issue/)).toBeInTheDocument());

    fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    const tagInput = (await screen.findByLabelText("Tag")) as HTMLInputElement;
    expect(screen.getAllByText(/separator/).length).toBeGreaterThan(0);
    fireEvent.change(tagInput, { target: { value: "HV 3201" } });
    await waitFor(() => expect(screen.queryByText(/1 tag issue/)).toBeNull());

    const actuatorSelect = screen.getByLabelText("Actuator") as HTMLSelectElement;
    fireEvent.change(actuatorSelect, { target: { value: "fsdp/act_diaphragm" } });
    await waitFor(() => expect(document.querySelector(".portList")?.textContent).toContain("signal"));
  });

  it("adds generated legends to the export when the drawing asks for them", async () => {
    apiMock.listDrawings.mockResolvedValue([{ ...drawing, fields: { ...drawing.fields, legends: "symbols,letters" } }]);
    apiMock.exportSheet.mockResolvedValue({ blob: new Blob(["<svg/>"], { type: "image/svg+xml" }), filename: "AMB2-9003-01-rev0.svg" });
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: vi.fn() });
    renderPage();
    const canvas = await screen.findByTestId("schematic-canvas");
    await waitFor(() => expect(canvas.querySelector('[data-id="pt"]')).not.toBeNull());
    expect(canvas.textContent).toContain("SYMBOL LEGEND");
    expect(canvas.textContent).toContain("INSTRUMENT LETTER DESIGNATIONS");
    fireEvent.click(screen.getByRole("button", { name: "SVG" }));
    await waitFor(() => expect(apiMock.exportSheet).toHaveBeenCalledTimes(1));
    const [, body] = apiMock.exportSheet.mock.calls[0] as [string, { svg: string }];
    expect(body.svg).toContain("FIELD MOUNTED INSTRUMENT");
    expect(body.svg).toContain("SUCCEEDING LETTERS");
  });
});
