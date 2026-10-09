import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineClass, Project } from "../types";

const apiMock = vi.hoisted(() => ({
  listLineClasses: vi.fn(),
  createLineClass: vi.fn(),
  updateLineClass: vi.fn(),
  deleteLineClass: vi.fn(),
  importLineClasses: vi.fn()
}));
const importLineClassesFile = vi.hoisted(() => vi.fn());

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: apiMock, importLineClassesFile };
});

import { LineClassPanel } from "./LineClassPanel";

const project = { id: "p1", name: "AMB2" } as Project;

function lineClass(id: string, name: string, extra: Partial<LineClass> = {}): LineClass {
  return {
    id,
    project_id: "p1",
    name,
    description: null,
    material: "316L SS tube",
    rating: "3000 psig",
    wall: '.035"',
    sizes: ['1/4"', '1/2"'],
    insulation: null,
    notes: null,
    created_at: "",
    updated_at: "",
    ...extra
  };
}

const A1A = lineClass("lc1", "A1A");
const B2B = lineClass("lc2", "B2B", { material: "Carbon steel", sizes: ['1"'] });

function grid(): HTMLElement {
  return screen.getByRole("grid", { name: "Line classes" });
}

function cell(r: number, c: number): HTMLElement {
  const element = grid().querySelector<HTMLElement>(`.dgBody [data-r='${r}'][data-c='${c}']`);
  if (!element) throw new Error(`cell ${r},${c} not rendered`);
  return element;
}

function bodyRows(): string[] {
  return Array.from(grid().querySelectorAll<HTMLElement>(".dgBody [role='row']")).map((row) => row.textContent ?? "");
}

function editCell(r: number, c: number, header: string, text: string) {
  fireEvent.doubleClick(cell(r, c));
  const editor = screen.getByRole("textbox", { name: `Edit ${header}` });
  fireEvent.change(editor, { target: { value: text } });
  fireEvent.keyDown(editor, { key: "Enter" });
}

async function renderPanel(classes: LineClass[], canWrite = true) {
  apiMock.listLineClasses.mockResolvedValue(classes);
  render(<LineClassPanel project={project} canWrite={canWrite} />);
  await waitFor(() => expect(apiMock.listLineClasses).toHaveBeenCalledWith("p1"));
  if (classes.length) await waitFor(() => expect(bodyRows()).toHaveLength(classes.length));
}

describe("LineClassPanel", () => {
  beforeEach(() => {
    Object.values(apiMock).forEach((fn) => fn.mockReset());
    importLineClassesFile.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the classes sorted by name, read-only for viewers", async () => {
    await renderPanel([B2B, A1A], false);
    expect(bodyRows()[0]).toContain("A1A");
    expect(bodyRows()[1]).toContain("B2B");
    expect(cell(0, 4)).toHaveTextContent('1/4"; 1/2"');
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Import file…" })).toBeNull();
    expect(screen.queryByLabelText("Select row 1")).toBeNull();
    fireEvent.doubleClick(cell(0, 1));
    expect(screen.queryByRole("textbox", { name: "Edit Material" })).toBeNull();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  });

  it("saves an inline edit through the update endpoint", async () => {
    apiMock.updateLineClass.mockImplementation(async (id: string, body: Partial<LineClass>) => ({ ...A1A, id, ...body }));
    await renderPanel([A1A, B2B]);
    editCell(0, 1, "Material", "  ");
    await waitFor(() => expect(apiMock.updateLineClass).toHaveBeenCalledWith("lc1", { material: null }));
    editCell(1, 4, "Sizes", '1"; 2" ; 1"');
    await waitFor(() => expect(apiMock.updateLineClass).toHaveBeenLastCalledWith("lc2", { sizes: ['1"', '2"'] }));
    await waitFor(() => expect(cell(0, 1)).toHaveTextContent(""));
    expect(cell(0, 1)).not.toHaveAttribute("aria-invalid");
  });

  it("rolls a refused edit back and shows the server's reason on the cell", async () => {
    apiMock.updateLineClass.mockRejectedValue(new Error("Line class name already exists in project"));
    await renderPanel([A1A, B2B]);
    editCell(1, 0, "Class", "A1A");
    await waitFor(() => expect(apiMock.updateLineClass).toHaveBeenCalledWith("lc2", { name: "A1A" }));
    await waitFor(() => expect(cell(1, 0)).toHaveAttribute("aria-invalid", "true"));
    expect(cell(1, 0)).toHaveTextContent("B2B");
    expect(cell(1, 0)).toHaveAttribute("title", "Line class name already exists in project");

    // A blank name is refused before it reaches the server.
    apiMock.updateLineClass.mockClear();
    editCell(0, 0, "Class", " ");
    expect(screen.getByText("A line class needs a name")).toBeInTheDocument();
    expect(apiMock.updateLineClass).not.toHaveBeenCalled();
  });

  it("creates classes from rows pasted below the last row and reports refused rows", async () => {
    apiMock.createLineClass.mockImplementation(async (_projectId: string, body: { name: string }) => {
      if (body.name === "B2B") throw new Error("Line class name already exists in project");
      return lineClass(`new-${body.name}`, body.name);
    });
    await renderPanel([]);
    apiMock.listLineClasses.mockResolvedValue([lineClass("new-C3C", "C3C")]);
    fireEvent.paste(grid(), { clipboardData: { getData: () => 'Class\tMaterial\tRating\tWall\tSizes\nC3C\t316L\t\t.049"\t1/4"; 3/8"\n\tno name\nB2B\tCS\n' } });
    await waitFor(() => expect(apiMock.createLineClass).toHaveBeenCalledTimes(2));
    expect(apiMock.createLineClass).toHaveBeenNthCalledWith(1, "p1", {
      name: "C3C",
      material: "316L",
      rating: null,
      wall: '.049"',
      sizes: ['1/4"', '3/8"'],
      insulation: null,
      description: null,
      notes: null
    });
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Added 1 line class(es); 2 row(s) refused.");
    expect(status).toHaveTextContent("Pasted row 2: missing class name");
    expect(status).toHaveTextContent("Pasted row 3 (B2B): Line class name already exists in project");
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
  });

  it("creates classes from the clipboard with Paste rows", async () => {
    apiMock.createLineClass.mockImplementation(async (_projectId: string, body: { name: string }) => lineClass(`new-${body.name}`, body.name));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: vi.fn(async () => "name\tsizes\nD4D\t1/2\"\n") } });
    await renderPanel([A1A]);
    fireEvent.click(screen.getByRole("button", { name: "Paste rows" }));
    await waitFor(() => expect(apiMock.createLineClass).toHaveBeenCalledWith("p1", expect.objectContaining({ name: "D4D", sizes: ['1/2"'], material: null })));
    expect(await screen.findByRole("status")).toHaveTextContent("Added 1 line class(es).");
  });

  it("deletes the selected classes in bulk and reports failures", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    apiMock.deleteLineClass.mockImplementation(async (id: string) => {
      if (id === "lc2") throw new Error("Line class is used by 3 lines");
    });
    await renderPanel([A1A, B2B, lineClass("lc3", "C3C")]);
    fireEvent.click(screen.getByLabelText("Select row 1"));
    fireEvent.click(screen.getByLabelText("Select row 2"));
    const bulk = screen.getByRole("region", { name: "Bulk actions" });
    apiMock.listLineClasses.mockResolvedValue([B2B, lineClass("lc3", "C3C")]);
    await act(async () => {
      fireEvent.click(within(bulk).getByRole("button", { name: "Delete 2" }));
    });
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Delete 2 line class(es)? A1A, B2B"));
    expect(apiMock.deleteLineClass).toHaveBeenCalledWith("lc1");
    expect(apiMock.deleteLineClass).toHaveBeenCalledWith("lc2");
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Deleted 1 line class(es); 1 failed.");
    expect(status).toHaveTextContent("B2B: Line class is used by 3 lines");
    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    expect(screen.queryByRole("region", { name: "Bulk actions" })).toBeNull();
  });

  it("imports a csv/xlsx file and pasted CSV text", async () => {
    importLineClassesFile.mockResolvedValue({ created: 2, updated: 1, errors: ["row 4: missing name"] });
    apiMock.importLineClasses.mockResolvedValue({ created: 1, updated: 0, errors: [] });
    await renderPanel([A1A]);
    const file = new File(["name\nA1A"], "classes.xlsx");
    fireEvent.change(screen.getByLabelText("Line class import file"), { target: { files: [file] } });
    await waitFor(() => expect(importLineClassesFile).toHaveBeenCalledWith("p1", file));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Imported: 2 created, 1 updated, 1 row error(s).");
    expect(status).toHaveTextContent("row 4: missing name");

    fireEvent.change(screen.getByRole("textbox", { name: /CSV \(header/ }), { target: { value: "name\nE5E" } });
    fireEvent.click(screen.getByRole("button", { name: "Import CSV" }));
    await waitFor(() => expect(apiMock.importLineClasses).toHaveBeenCalledWith("p1", "name\nE5E"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Imported: 1 created, 0 updated."));
  });
});
