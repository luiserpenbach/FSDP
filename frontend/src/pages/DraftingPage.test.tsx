import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagram, User } from "../types";

const apiMock = vi.hoisted(() => ({
  getSchematic: vi.fn(),
  getDiagram: vi.fn(),
  saveSchematic: vi.fn()
}));

vi.mock("../api", () => ({ api: apiMock }));

import { DraftingPage } from "./DraftingPage";

const user: User = { id: "u1", email: "eng@fsdp.test", name: "Engineer", role: "engineer", is_active: true } as User;

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

describe("DraftingPage", () => {
  afterEach(cleanup);

  beforeEach(() => {
    apiMock.getSchematic.mockReset();
    apiMock.getDiagram.mockReset();
    apiMock.saveSchematic.mockReset();
  });

  it("converts a legacy diagram on first open and saves the schematic document", async () => {
    apiMock.getSchematic.mockResolvedValue({ diagram_id: "d1", revision: 3, document: null });
    apiMock.getDiagram.mockResolvedValue(legacyDiagram);
    apiMock.saveSchematic.mockImplementation(async (_id: string, document: unknown) => ({ diagram_id: "d1", revision: 4, document }));
    const notify = vi.fn();

    render(
      <DraftingPage diagrams={[legacyDiagram]} initialDiagramId="d1" customSymbols={[]} user={user} canWrite notify={notify} />
    );

    const canvas = await screen.findByTestId("schematic-canvas");
    expect(screen.getByText(/Converted from the classic canvas/)).toBeInTheDocument();
    expect(canvas.querySelector('[data-id="v1"]')).not.toBeNull();
    expect(canvas.querySelector('[data-id="e1"]')).not.toBeNull();
    expect(canvas.textContent).toContain("HV-1");

    // A converted document is unsaved work; saving persists it and clears the notice.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiMock.saveSchematic).toHaveBeenCalledTimes(1));
    const [, document] = apiMock.saveSchematic.mock.calls[0] as [string, { schemaVersion: number; items: unknown[] }];
    expect(document.schemaVersion).toBe(1);
    expect(document.items).toHaveLength(3);
    await waitFor(() => expect(screen.queryByText(/Converted from the classic canvas/)).toBeNull());
    expect(notify).toHaveBeenCalledWith("Saved Helium panel.");
  });

  it("opens a stored schematic document and edits a symbol tag from the inspector", async () => {
    apiMock.getSchematic.mockResolvedValue({
      diagram_id: "d1",
      revision: 5,
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
      }
    });
    render(
      <DraftingPage diagrams={[legacyDiagram]} initialDiagramId="d1" customSymbols={[]} user={user} canWrite notify={vi.fn()} />
    );
    const canvas = await screen.findByTestId("schematic-canvas");
    expect(apiMock.getDiagram).not.toHaveBeenCalled();
    expect(screen.queryByText(/Converted from the classic canvas/)).toBeNull();

    // Keyboard: select all, then the inspector shows the single symbol.
    act(() => {
      fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    });
    const tagInput = (await screen.findByLabelText("Tag")) as HTMLInputElement;
    expect(tagInput.value).toBe("PT-3222");
    fireEvent.change(tagInput, { target: { value: "PT-3223" } });
    await waitFor(() => expect(canvas.textContent).toContain("3223"));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });
});
