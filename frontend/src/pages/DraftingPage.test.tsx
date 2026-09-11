import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagram, Drawing, DrawingSheet, FluidSystem, Part, User } from "../types";

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
  updateSymbol: vi.fn(),
  listLineClasses: vi.fn(),
  createLineClass: vi.fn(),
  importLineClasses: vi.fn(),
  getProjectList: vi.fn(),
  downloadList: vi.fn(),
  generateDrawingBom: vi.fn(),
  getBomReadiness: vi.fn(),
  getSheetDrc: vi.fn(),
  waiveFinding: vi.fn(),
  unwaiveFinding: vi.fn()
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

const parts: Part[] = [
  { id: "part-1", part_number: "AMB2-001", description: "Ball valve 1/4 in", part_type: "valve", source_type: "vendor", material: "316L", pressure_rating_bar: 200, qualification_status: "qualified", certification_status: "certified", lifecycle_status: "active", preferred: true },
  { id: "part-2", part_number: "AMB2-002", description: "Pressure transducer", part_type: "instrument", source_type: "vendor", material: null, pressure_rating_bar: 100, qualification_status: "unqualified", certification_status: "unreviewed", lifecycle_status: "draft", preferred: false },
  { id: "part-3", part_number: "AMB2-003", description: "Old valve", part_type: "valve", source_type: "vendor", material: "brass", pressure_rating_bar: 50, qualification_status: "qualified", certification_status: "certified", lifecycle_status: "obsolete", preferred: false }
];

function renderPage(notify = vi.fn()) {
  return render(
    <MemoryRouter>
      <DraftingPage
        projectId="p1"
        projectName="AMB2"
        systems={systems}
        diagrams={[legacyDiagram]}
        selectedSystemId="s1"
        customSymbols={[]}
        parts={parts}
        user={user}
        canWrite
        notify={notify}
      />
    </MemoryRouter>
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
    apiMock.listLineClasses.mockResolvedValue([]);
    apiMock.getSheetDrc.mockResolvedValue({ sheet_id: "sh1", sheet_no: 1, counts: { error: 0, warning: 0, info: 0, waived: 0 }, findings: [], waivers: [], checks: [] });
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
    // The engine's index rows travel with the document.
    const index = (body as unknown as { index: { items: Array<{ item_id: string; tag: string | null; category: string | null; zone: string | null }>; lines: unknown[] } }).index;
    expect(index.items).toHaveLength(1);
    expect(index.items[0]).toMatchObject({ item_id: "pt", tag: "PT-3223", category: "instrument" });
    expect(index.items[0].zone).toMatch(/^[A-Z]-\d$/);
    expect(index.lines).toEqual([]);
    // The DRC runs on save: the lone PT has an open process port.
    const drc = (body as unknown as { drc: { findings: Array<{ key: string; severity: string }>; checks: unknown[] } }).drc;
    expect(drc.findings.map((finding) => finding.key)).toEqual(["open_port:pt:process"]);
    expect(drc.checks).toEqual([]);
    expect(notify).toHaveBeenCalledWith("Saved AMB2-9003 sheet 1 (1 items, 0 lines indexed; DRC: 0 error(s), 1 warning(s)).");
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

  it("fills line specs from a project line class and resolves connector references across sheets", async () => {
    apiMock.listLineClasses.mockResolvedValue([
      { id: "lc1", project_id: "p1", name: "A1A", material: "316L SS", rating: "3000 psig", wall: '.035"', sizes: ['1/4"', '1/2"'], insulation: "foam", description: null, notes: null, created_at: "", updated_at: "" }
    ]);
    const sheet1Doc = {
      ...sheet.document,
      items: [
        { id: "line1", kind: "line", layer: "process", points: [{ x: 50, y: 100 }, { x: 150, y: 100 }], lineType: "process", lineNumber: "3101", fields: {} },
        { id: "conn", kind: "symbol", layer: "symbols", symbol: { library: "fsdp", key: "off_page_connector", version: 1 }, position: { x: 200, y: 100 }, rotation: 0, label: "TO VENT", fields: { ref: "A" } }
      ]
    };
    const sheet2Doc = {
      ...sheet.document,
      items: [{ id: "back", kind: "symbol", layer: "symbols", symbol: { library: "fsdp", key: "terminator_in", version: 1 }, position: { x: 40, y: 250 }, rotation: 0, fields: { ref: "A" } }]
    };
    apiMock.getSheet.mockImplementation(async (id: string) => (id === "sh2" ? { ...sheet, id: "sh2", sheet_no: 2, document: sheet2Doc } : { ...sheet, document: sheet1Doc }));
    renderPage();
    const canvas = await screen.findByTestId("schematic-canvas");
    await waitFor(() => expect(canvas.querySelector('[data-id="conn"]')).not.toBeNull());
    // The connector caption resolves to the paired connector's sheet and zone.
    await waitFor(() => expect(canvas.textContent).toContain("SHT 2 / A-4"));

    // Find the line by number, then pick the class: spec, insulation, and size follow.
    const find = screen.getByLabelText("Find") as HTMLInputElement;
    fireEvent.change(find, { target: { value: "3101" } });
    fireEvent.keyDown(find, { key: "Enter" });
    const classSelect = (await screen.findByLabelText("Line class")) as HTMLSelectElement;
    fireEvent.change(classSelect, { target: { value: "A1A" } });
    await waitFor(() => expect((screen.getByLabelText("Spec") as HTMLInputElement).value).toBe('316L SS x .035" WALL'));
    const sizeInput = screen.getAllByLabelText("Size").find((element) => element.tagName === "INPUT") as HTMLInputElement;
    expect(sizeInput.value).toBe('1/4"');
    expect((screen.getByLabelText("Insulation") as HTMLInputElement).value).toBe("foam");
    await waitFor(() => expect(canvas.textContent).toContain('1/4" 316L SS x .035" WALL'));
    expect(screen.getByText(/paired connector/)).toBeInTheDocument();
  });

  it("shows live engineering lists in the drawer and locates rows on the sheet", async () => {
    const richSheet: DrawingSheet = {
      ...sheet,
      document: {
        ...sheet.document,
        items: [
          ...(sheet.document as { items: unknown[] }).items,
          { id: "hv", kind: "symbol", layer: "symbols", symbol: { library: "fsdp", key: "hand_valve", version: 1 }, position: { x: 60, y: 100 }, rotation: 0, tag: "HV-3201", partId: "part-1", dnp: true, fields: {} },
          { id: "l1", kind: "line", layer: "process", lineType: "process", lineNumber: "3101", size: '1/4"', service: "GHe", points: [{ x: 70, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 105 }], fields: {} }
        ]
      }
    };
    apiMock.getSheet.mockResolvedValue(richSheet);
    apiMock.getProjectList.mockResolvedValue({
      kind: "valve",
      title: "Valve list",
      scope: "project",
      header: { project: "AMB2" },
      columns: [{ key: "drawing_number", label: "Drawing" }, { key: "tag", label: "Tag" }, { key: "sheet_no", label: "Sheet" }, { key: "zone", label: "Zone" }],
      rows: [{ drawing_id: "dw1", drawing_number: "AMB2-9003", sheet_id: "sh1", item_id: "hv", tag: "HV-3201", sheet_no: 1, zone: "C-3" }]
    });
    renderPage();
    const canvas = await screen.findByTestId("schematic-canvas");
    await waitFor(() => expect(canvas.querySelector('[data-id="hv"]')).not.toBeNull());
    // Canvas badge for the assigned part, DNP marker printed.
    expect(canvas.querySelector('[data-id="hv"] .part-badge')?.textContent).toBe("AMB2-001");
    expect(canvas.querySelector('[data-id="hv"]')?.textContent).toContain("DNP");

    fireEvent.click(screen.getByRole("button", { name: "Lists" }));
    const drawer = screen.getByRole("region", { name: "Engineering lists" });
    expect(screen.getByRole("tab", { name: /Instruments/ })).toHaveAttribute("aria-selected", "true");
    expect(drawer.textContent).toContain("PT-3222");
    fireEvent.click(screen.getByRole("tab", { name: /Valves/ }));
    expect(drawer.textContent).toContain("HV-3201");
    expect(drawer.textContent).toContain("AMB2-001");
    expect(drawer.textContent).toContain("DNP");
    fireEvent.click(screen.getByRole("tab", { name: /Lines/ }));
    expect(drawer.textContent).toContain("3101");
    expect(drawer.textContent).toContain("PT-3222 (process)");

    // Click-to-locate selects the row's item.
    fireEvent.click(screen.getByRole("tab", { name: /Valves/ }));
    fireEvent.click(within(drawer).getAllByText("HV-3201")[0]);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Symbol" })).toBeInTheDocument());
    expect((screen.getByLabelText("Tag") as HTMLInputElement).value).toBe("HV-3201");

    // Project scope reads the saved index through the API.
    fireEvent.click(screen.getByLabelText("Project"));
    await waitFor(() => expect(apiMock.getProjectList).toHaveBeenCalledWith("p1", "valve"));
    await waitFor(() => expect(drawer.textContent).toContain("C-3"));
  });

  it("assigns a part from the modal with warnings and blocks obsolete parts", async () => {
    renderPage();
    const canvas = await screen.findByTestId("schematic-canvas");
    await waitFor(() => expect(canvas.querySelector('[data-id="pt"]')).not.toBeNull());
    fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    await screen.findByLabelText("Tag");
    expect(screen.getByText("no part assigned")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Assign part…" }));
    const dialog = screen.getByRole("dialog", { name: "Assign part" });
    // The instrument category suggests the instrument type chip, narrowing the list.
    expect(within(dialog).getByRole("option", { name: /AMB2-002/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole("option", { name: /AMB2-001/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /^instrument/ }));
    expect(within(dialog).getByRole("option", { name: /AMB2-001/ })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("option", { name: /AMB2-003/ }));
    expect(within(dialog).getByRole("button", { name: "Assign part" })).toBeDisabled();
    expect(dialog.textContent).toContain("Obsolete parts cannot be assigned");
    fireEvent.click(within(dialog).getByRole("option", { name: /AMB2-002/ }));
    expect(dialog.textContent).toContain("Part is still a draft.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Assign part" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("link", { name: "AMB2-002" })).toHaveAttribute("href", "/parts?part=part-2");
    expect(screen.getByText("Part is not qualified or preferred.")).toBeInTheDocument();
    await waitFor(() => expect(canvas.querySelector('[data-id="pt"] .part-badge')?.textContent).toBe("AMB2-002"));
    fireEvent.click(screen.getByLabelText("Do not populate (DNP)"));
    await waitFor(() => expect(canvas.querySelector('[data-id="pt"]')?.textContent).toContain("DNP"));
  });

  it("generates the drawing BoM from the saved index", async () => {
    apiMock.generateDrawingBom.mockResolvedValue({ id: "bom1", drawing_id: "dw1", diagram_id: null, source_kind: "drawing", revision: 1, status: "draft", rows: [{ kind: "unassigned", part_number: null, description: "Field instrument", quantity: 1, unit: "ea", spare_quantity: 0, component_tags: ["PT-3222"], dnp_tags: [], sheets: [1] }], created_at: "2026-09-10T10:00:00Z" });
    apiMock.getBomReadiness.mockResolvedValue({ snapshot_id: "bom1", row_count: 1, issue_count: 1, blocking_count: 1, warning_count: 0, ready: false, issues: [{ part_number: null, component_tags: ["PT-3222"], warnings: ["No catalog part is linked to this BoM row."], code: "no_part", severity: "blocking" }] });
    const notify = vi.fn();
    renderPage(notify);
    const canvas = await screen.findByTestId("schematic-canvas");
    await waitFor(() => expect(canvas.querySelector('[data-id="pt"]')).not.toBeNull());
    fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    fireEvent.keyDown(canvas, { key: "ArrowRight" }); // dirty the sheet
    fireEvent.click(screen.getByRole("button", { name: "Lists" }));
    fireEvent.click(screen.getByRole("tab", { name: "BoM" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate BoM from drawing" }));
    // A dirty sheet is saved first so the BoM reads the current index.
    await waitFor(() => expect(apiMock.updateSheet).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(apiMock.generateDrawingBom).toHaveBeenCalledWith("dw1"));
    const drawer = screen.getByRole("region", { name: "Engineering lists" });
    await waitFor(() => expect(drawer.textContent).toContain("Field instrument"));
    expect(drawer.textContent).toContain("1 blocking");
    expect(drawer.textContent).toContain("no_part");
    expect(notify).toHaveBeenCalledWith("Generated BoM rev 1 for AMB2-9003 (1 rows).");
  });

  it("lists design rule findings with jump, waive, and requirement checks, and appends a findings page to the PDF", async () => {
    const brokenSheet: DrawingSheet = {
      ...sheet,
      document: {
        ...sheet.document,
        items: [
          ...(sheet.document as { items: unknown[] }).items,
          { id: "hv", kind: "symbol", layer: "symbols", symbol: { library: "fsdp", key: "hand_valve", version: 1 }, position: { x: 60, y: 100 }, rotation: 0, tag: "PT-3222", partId: "part-3", fields: {} },
          { id: "l1", kind: "line", layer: "process", lineType: "process", size: '1/4"', service: "GHe", points: [{ x: 70, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 105 }], fields: {} }
        ]
      }
    };
    apiMock.getSheet.mockResolvedValue(brokenSheet);
    apiMock.getSheetDrc.mockResolvedValue({ sheet_id: "sh1", sheet_no: 1, counts: { error: 0, warning: 0, info: 0, waived: 1 }, findings: [], waivers: [{ id: "w1", sheet_id: "sh1", key: "open_port:hv:in", reason: "Bottle valve, capped", waived_by: "eng@fsdp.test", created_at: "2026-09-11T08:00:00Z" }], checks: [] });
    apiMock.waiveFinding.mockResolvedValue({ id: "w2", sheet_id: "sh1", key: "line_unnumbered:l1", reason: "Stub", waived_by: "eng@fsdp.test", created_at: "2026-09-11T08:00:00Z" });
    apiMock.exportSheet.mockResolvedValue({ blob: new Blob(["%PDF"], { type: "application/pdf" }), filename: "AMB2-9003-01-rev0.pdf" });
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: vi.fn() });
    const requirements = [
      { id: "r1", project_id: "p1", key: "REQ-7", title: "316L wetted", text: "", requirement_type: "materials", status: "draft", constraint: { kind: "material_in" as const, values: ["316L"] } },
      { id: "r2", project_id: "p1", key: "REQ-9", title: "Manual", text: "", requirement_type: "process", status: "draft", constraint: null }
    ];
    render(
      <MemoryRouter>
        <DraftingPage projectId="p1" projectName="AMB2" systems={systems} diagrams={[]} selectedSystemId="s1" customSymbols={[]} parts={parts} requirements={requirements} user={user} canWrite notify={vi.fn()} />
      </MemoryRouter>
    );
    const canvas = await screen.findByTestId("schematic-canvas");
    await waitFor(() => expect(canvas.querySelector('[data-id="hv"]')).not.toBeNull());
    const panel = await screen.findByRole("article", { name: "Design rule check" });
    await waitFor(() => expect(panel.textContent).toContain("3 error(s)"));
    expect(panel.textContent).toContain("Duplicate tag");
    expect(panel.textContent).toContain("PT-3222: Duplicate of PT-3222");
    expect(panel.textContent).toContain("REQ-7 (316L wetted): AMB2-003 material brass is not one of 316L");
    expect(panel.textContent).toContain("Part status");
    expect(panel.textContent).toContain("Unnumbered line");
    // The stored waiver hides the bottle-side open port.
    expect(panel.textContent).toContain("1 waived");
    expect(panel.textContent).not.toContain("port in has no line");
    expect(screen.getByTitle("Design rule check").textContent).toBe("DRC 3 / 2");
    expect(panel.textContent).toContain("Relief coverage");

    // Jump to the duplicate tag's item.
    const duplicate = within(panel).getByText("PT-3222: Duplicate of PT-3222").closest("li")!;
    fireEvent.click(within(duplicate).getByRole("button", { name: "Go" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Symbol" })).toBeInTheDocument());

    // Waive the unnumbered line with a reason.
    vi.spyOn(window, "prompt").mockReturnValue("Stub");
    const unnumbered = within(panel).getByText(/has no line number/).closest("li")!;
    fireEvent.click(within(unnumbered).getByRole("button", { name: "Waive…" }));
    await waitFor(() => expect(apiMock.waiveFinding).toHaveBeenCalledWith("sh1", "line_unnumbered:l1", "Stub"));

    // Export with the findings page appended.
    fireEvent.click(screen.getByLabelText("DRC page"));
    fireEvent.click(screen.getByRole("button", { name: "PDF" }));
    await waitFor(() => expect(apiMock.exportSheet).toHaveBeenCalledTimes(1));
    const [, exportBody] = apiMock.exportSheet.mock.calls[0] as [string, { format: string; pages: string[] }];
    expect(exportBody.format).toBe("pdf");
    expect(exportBody.pages).toHaveLength(1);
    expect(exportBody.pages[0]).toContain("DESIGN RULE CHECK");
    expect(exportBody.pages[0]).toContain("Duplicate of PT-3222");

    // Saving stores open and waived findings and the requirement checks.
    fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    fireEvent.keyDown(canvas, { key: "ArrowRight" }); // dirty the sheet
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiMock.updateSheet).toHaveBeenCalledTimes(1));
    const [, body] = apiMock.updateSheet.mock.calls[0] as [string, { drc: { findings: Array<{ key: string; requirementId?: string }>; checks: Array<{ requirementId: string; status: string; subject: string | null }> } }];
    expect(body.drc.findings.map((finding) => finding.key)).toContain("open_port:hv:in");
    expect(body.drc.findings.find((finding) => finding.key === "requirement:r1:hv")?.requirementId).toBe("r1");
    expect(body.drc.checks).toEqual([{ requirementId: "r1", itemId: "hv", subject: "PT-3222", zone: expect.any(String), status: "fail", message: "AMB2-003 material brass is not one of 316L" }]);
  });
});
