import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartsCatalog } from "./PartsCatalog";
import type { ImportReport, Part } from "../types";

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" }
    })
  );
}

const samplePart: Part = {
  id: "p1",
  part_number: "AMPH-010",
  description: "Solenoid",
  part_type: "valve",
  source_type: "internal",
  qualification_status: "unqualified",
  certification_status: "unreviewed",
  lifecycle_status: "draft",
  preferred: false,
  completeness: 40,
  material: "SS316"
};

const otherPart: Part = { ...samplePart, id: "p2", part_number: "AMPH-011", description: "Regulator", material: "Brass" };

type FetchCall = { path: string; method: string; body: unknown };

function stubCatalogFetch(extra: (path: string, init?: RequestInit) => Promise<Response> | null = () => null) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const path = String(url).replace("http://localhost:8000", "");
      calls.push({
        path,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body
      });
      const override = extra(path, init);
      if (override) return override;
      if (path === "/catalog/settings") {
        return jsonResponse({
          prefix: "AMPH",
          sequence_padding: 3,
          next_sequence: 4,
          part_types: ["valve"]
        });
      }
      if (path === "/parts/p1/usage") {
        return jsonResponse({
          components: [
            {
              id: "c1",
              tag: "V-1",
              quantity: 1,
              diagram_id: "d1",
              diagram_name: "P&ID",
              system_id: "s1",
              system_name: "Press",
              project_id: "pr1",
              project_name: "Vehicle"
            }
          ],
          bom_snapshots: []
        });
      }
      if (path === "/parts/p1/documents") return jsonResponse([]);
      return jsonResponse({});
    })
  );
  return calls;
}

function CatalogHarness({
  initialId = "",
  initialParts = [samplePart],
  onPartsChanged
}: {
  initialId?: string;
  initialParts?: Part[];
  onPartsChanged?: (parts: Part[]) => void;
}) {
  const [selectedPartId, setSelectedPartId] = useState(initialId);
  const [parts, setParts] = useState(initialParts);
  return (
    <PartsCatalog
      parts={parts}
      selectedPartId={selectedPartId}
      onSelectPart={setSelectedPartId}
      onPartsChanged={(next) => {
        setParts(next);
        onPartsChanged?.(next);
      }}
    />
  );
}

function grid() {
  return screen.getByRole("grid", { name: "Parts catalog" });
}

/** The grid cell showing `text` (a part number, a material, ...). */
function cellWith(text: string): HTMLElement {
  const element = within(grid()).getByText(text).closest<HTMLElement>("[role='gridcell']");
  if (!element) throw new Error(`no cell shows ${text}`);
  return element;
}

describe("PartsCatalog", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("fills a generated unique name into the part name field", async () => {
    stubCatalogFetch((path, init) => {
      if (path.startsWith("/catalog/generate-name") && init?.method === "POST") {
        return jsonResponse({ part_number: "AMPH-001" });
      }
      return null;
    });

    render(
      <PartsCatalog
        parts={[]}
        selectedPartId=""
        onSelectPart={() => undefined}
        onPartsChanged={() => undefined}
      />
    );

    expect(await screen.findByRole("heading", { name: "Parts" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+ New part" }));
    expect(screen.getByRole("heading", { name: "New part" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Part name")).toHaveValue("AMPH-001");
    });
  });

  it("opens part details with where-used after clicking a part number", async () => {
    stubCatalogFetch();
    render(<CatalogHarness />);

    expect(await screen.findByText("AMPH-010")).toBeInTheDocument();
    expect(screen.queryByText("Part details")).not.toBeInTheDocument();
    expect(screen.queryByText("V-1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("AMPH-010"));

    expect(await screen.findByText("Part details")).toBeInTheDocument();
    expect(await screen.findByText("V-1")).toBeInTheDocument();
    expect(screen.getByText("Vehicle")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Where used" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Documents" })).toBeInTheDocument();
  });

  it("opens part details when a row is activated with Enter on a read-only cell", async () => {
    stubCatalogFetch();
    render(<CatalogHarness />);
    expect(await screen.findByText("AMPH-010")).toBeInTheDocument();

    act(() => grid().focus());
    fireEvent.keyDown(grid(), { key: "Enter" });
    expect(await screen.findByText("Part details")).toBeInTheDocument();
  });

  it("opens the part editor modal from the details panel", async () => {
    stubCatalogFetch();
    render(<CatalogHarness initialId="p1" />);

    expect(await screen.findByText("Part details")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("heading", { name: "Edit part" })).toBeInTheDocument();
    expect(screen.getByLabelText("Part name")).toHaveValue("AMPH-010");
    expect(screen.getByLabelText("Description")).toHaveValue("Solenoid");
  });

  it("hides a column turned off in the column chooser and remembers it", async () => {
    stubCatalogFetch();
    const { unmount } = render(<CatalogHarness />);

    expect(await screen.findByRole("columnheader", { name: /Material/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Choose columns" })).getByLabelText("Material"));
    expect(screen.queryByRole("columnheader", { name: /Material/ })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Part number/ })).toBeInTheDocument();

    unmount();
    render(<CatalogHarness />);
    expect(await screen.findByText("AMPH-010")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /Material/ })).not.toBeInTheDocument();
  });

  it("exports the visible rows as CSV", async () => {
    stubCatalogFetch();
    const createObjectURL = vi.fn((blob: Blob) => {
      expect(blob).toBeInstanceOf(Blob);
      return "blob:parts";
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<CatalogHarness />);
    expect(await screen.findByText("AMPH-010")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));

    expect(createObjectURL).toHaveBeenCalled();
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toContain("csv");
    const csv = await blob.text();
    expect(csv).toContain("Part number");
    expect(csv).toContain("AMPH-010");
    expect(csv).toContain("SS316");
    expect(click).toHaveBeenCalled();
  });

  it("exports the visible rows as XLSX through the export endpoint", async () => {
    const calls = stubCatalogFetch((path) =>
      path === "/exports/xlsx"
        ? Promise.resolve(
            new Response("xlsx-bytes", {
              status: 200,
              headers: { "Content-Disposition": 'attachment; filename="parts.xlsx"' }
            })
          )
        : null
    );
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<CatalogHarness initialParts={[samplePart, otherPart]} />);
    expect(await screen.findByText("AMPH-011")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export XLSX" }));

    await waitFor(() => expect(click).toHaveBeenCalled());
    const request = calls.find((call) => call.path === "/exports/xlsx");
    const body = request?.body as { title: string; columns: Array<{ key: string; header: string }>; rows: Array<Record<string, unknown>> };
    expect(request?.method).toBe("POST");
    expect(body.title).toBe("Parts catalog");
    expect(body.columns.map((column) => column.header)).toContain("Material");
    expect(body.rows.map((row) => row.part_number)).toEqual(["AMPH-010", "AMPH-011"]);
    expect(body.rows[0].completeness).toBe(40);
    expect(body.rows[0].lifecycle_status).toBe("draft");
  });

  it("saves an inline edit through the part update API", async () => {
    const calls = stubCatalogFetch((path, init) =>
      path === "/parts/p1" && init?.method === "PUT" ? jsonResponse({ ...samplePart, material: "Inconel 718" }) : null
    );
    const changed = vi.fn();
    render(<CatalogHarness onPartsChanged={changed} />);
    expect(await screen.findByText("SS316")).toBeInTheDocument();

    fireEvent.doubleClick(cellWith("SS316"));
    const editor = screen.getByLabelText("Edit Material");
    fireEvent.change(editor, { target: { value: "Inconel 718" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(calls.find((call) => call.path === "/parts/p1" && call.method === "PUT")?.body).toEqual({ material: "Inconel 718" });
    expect(changed.mock.calls[0][0][0].material).toBe("Inconel 718");
    expect(within(grid()).getByText("Inconel 718")).toBeInTheDocument();
  });

  it("rolls an inline edit back and shows the server's error on the cell", async () => {
    stubCatalogFetch((path, init) =>
      path === "/parts/p1" && init?.method === "PUT"
        ? jsonResponse({ detail: "lifecycle_status: must be one of: active, draft" }, 422)
        : null
    );
    const changed = vi.fn();
    render(<CatalogHarness onPartsChanged={changed} />);
    expect(await screen.findByText("SS316")).toBeInTheDocument();

    fireEvent.doubleClick(cellWith("SS316"));
    const editor = screen.getByLabelText("Edit Material");
    fireEvent.change(editor, { target: { value: "Unobtainium" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(cellWith("SS316")).toHaveAttribute("aria-invalid", "true"));
    expect(cellWith("SS316")).toHaveAttribute("title", "lifecycle_status: must be one of: active, draft");
    expect(within(grid()).queryByText("Unobtainium")).not.toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
  });

  it("refuses a blank required cell before calling the API", async () => {
    const calls = stubCatalogFetch();
    render(<CatalogHarness />);
    expect(await screen.findByText("Solenoid")).toBeInTheDocument();

    fireEvent.doubleClick(cellWith("Solenoid"));
    const editor = screen.getByLabelText("Edit Description");
    fireEvent.change(editor, { target: { value: "  " } });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(screen.getByRole("alert")).toHaveTextContent("Description is required");
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("sets the lifecycle of the selected parts in one bulk edit", async () => {
    const calls = stubCatalogFetch((path, init) =>
      path === "/parts/bulk" && init?.method === "PATCH"
        ? jsonResponse({
            updated: 2,
            unchanged: 0,
            items: [
              { ...samplePart, lifecycle_status: "active" },
              { ...otherPart, lifecycle_status: "active" }
            ]
          })
        : null
    );
    render(<CatalogHarness initialParts={[samplePart, otherPart]} />);
    expect(await screen.findByText("AMPH-011")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Select all rows"));
    const bulk = screen.getByRole("region", { name: "Bulk actions" });
    expect(bulk).toHaveTextContent("2 selected");
    fireEvent.change(within(bulk).getByLabelText("Set lifecycle"), { target: { value: "active" } });

    expect(await screen.findByText("Lifecycle: updated 2 parts.")).toBeInTheDocument();
    expect(calls.find((call) => call.path === "/parts/bulk")?.body).toEqual({
      ids: ["p1", "p2"],
      changes: { lifecycle_status: "active" }
    });
    expect(within(grid()).getAllByText("active")).toHaveLength(2);
  });

  it("bulk deletes the selection and lists the parts that were refused", async () => {
    const calls = stubCatalogFetch((path, init) => {
      if (path === "/parts/bulk-delete" && init?.method === "POST") {
        return jsonResponse({
          deleted: 1,
          refused: 1,
          results: [
            { id: "p1", deleted: false, reason: "Part AMPH-010 is placed on 2 component instance(s)." },
            { id: "p2", deleted: true, reason: null }
          ]
        });
      }
      if (path === "/parts" && (init?.method ?? "GET") === "GET") return jsonResponse([samplePart]);
      return null;
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<CatalogHarness initialParts={[samplePart, otherPart]} />);
    expect(await screen.findByText("AMPH-011")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Select all rows"));
    fireEvent.click(within(screen.getByRole("region", { name: "Bulk actions" })).getByRole("button", { name: "Delete…" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Delete 2 parts?"));
    const refused = await screen.findByRole("list", { name: "Refused" });
    expect(refused).toHaveTextContent("AMPH-010: Part AMPH-010 is placed on 2 component instance(s).");
    expect(screen.getByText("Deleted 1 part; 1 refused.")).toBeInTheDocument();
    expect(calls.find((call) => call.path === "/parts/bulk-delete")?.body).toEqual({ ids: ["p1", "p2"] });
    // The deleted part is gone; the refused one stays selected for another action.
    await waitFor(() => expect(within(grid()).queryByText("AMPH-011")).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "Bulk actions" })).toHaveTextContent("1 selected");
  });

  it("offers rows pasted below the last part to the import wizard, dry run first", async () => {
    const report: ImportReport = {
      entity: "part",
      mode: "create_only",
      dry_run: true,
      committed: false,
      mapping: { part_number: "part_number", description: "description" },
      warnings: [],
      rows: [
        {
          row: 1,
          action: "create",
          key: "AMPH-020",
          id: null,
          errors: [],
          changes: { part_number: [null, "AMPH-020"], description: [null, "Check valve"] }
        }
      ],
      summary: { create: 1, update: 0, unchanged: 0, error: 0 }
    };
    const calls = stubCatalogFetch((path) => (path.startsWith("/parts/import?") ? jsonResponse(report) : null));
    render(<CatalogHarness />);
    expect(await screen.findByText("AMPH-010")).toBeInTheDocument();

    fireEvent.mouseDown(cellWith("AMPH-010"), { button: 0 });
    fireEvent.paste(grid(), {
      clipboardData: { getData: () => "AMPH-010\tSolenoid\nAMPH-020\tCheck valve\n" }
    });

    const dialog = await screen.findByRole("dialog", { name: "Import parts" });
    expect(within(dialog).getByLabelText("Pasted rows")).toHaveValue("part_number\tdescription\nAMPH-020\tCheck valve");
    expect(await within(dialog).findByText("1 create")).toBeInTheDocument();
    const request = calls.find((call) => call.path.startsWith("/parts/import?"));
    expect(request?.path).toBe("/parts/import?dry_run=true&mode=create_only");
    expect(request?.body).toEqual({ headers: ["part_number", "description"], rows: [["AMPH-020", "Check valve"]] });
    expect(within(dialog).getByRole("button", { name: "Import 1 row" })).toBeEnabled();
    // The first pasted line matched the existing row unchanged: nothing was saved.
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("keeps viewers read-only: no import, no bulk actions, no inline editors", async () => {
    stubCatalogFetch();
    render(
      <PartsCatalog parts={[samplePart]} selectedPartId="" canWrite={false} onSelectPart={() => undefined} onPartsChanged={() => undefined} />
    );
    expect(await screen.findByText("SS316")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import…" })).not.toBeInTheDocument();
    fireEvent.doubleClick(cellWith("SS316"));
    expect(screen.queryByLabelText("Edit Material")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select all rows"));
    expect(screen.queryByLabelText("Set lifecycle")).not.toBeInTheDocument();
  });

  it("shows a failed delete on the page, not only inside the closed edit modal", async () => {
    stubCatalogFetch((path, init) =>
      path === "/parts/p1" && init?.method === "DELETE" ? jsonResponse({ detail: "Part is used in 2 BoM snapshots." }, 409) : null
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<CatalogHarness initialId="p1" />);

    expect(await screen.findByText("Part details")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Part is used in 2 BoM snapshots.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    confirm.mockRestore();
  });

  it("does not show a previously selected part's documents after the selection changes", async () => {
    let resolveFirstDocuments!: (response: Promise<Response>) => void;
    stubCatalogFetch((path) => {
      if (path === "/parts/p1/documents") return new Promise<Response>((resolve) => (resolveFirstDocuments = resolve));
      if (path === "/parts/p2/usage") return jsonResponse({ components: [], bom_snapshots: [] });
      if (path === "/parts/p2/documents") return jsonResponse([]);
      return null;
    });
    render(<CatalogHarness initialId="p1" initialParts={[samplePart, otherPart]} />);

    expect(await screen.findByText("Part details")).toBeInTheDocument();
    await waitFor(() => expect(resolveFirstDocuments).toBeDefined());
    fireEvent.click(screen.getByText("AMPH-011"));
    await waitFor(() => expect(screen.getByText("Regulator", { selector: ".catalogOverview *" })).toBeInTheDocument());

    resolveFirstDocuments(
      jsonResponse([{ id: "doc-1", part_id: "p1", title: "Solenoid datasheet", kind: "datasheet", original_filename: "solenoid.pdf" }])
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("solenoid.pdf")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });
});
