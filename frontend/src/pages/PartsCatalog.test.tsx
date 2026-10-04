import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartsCatalog } from "./PartsCatalog";
import type { Part } from "../types";

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

function stubCatalogFetch(extra: (path: string, init?: RequestInit) => Promise<Response> | null = () => null) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const path = String(url).replace("http://localhost:8000", "");
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
}

function CatalogHarness({ initialId = "" }: { initialId?: string }) {
  const [selectedPartId, setSelectedPartId] = useState(initialId);
  return (
    <PartsCatalog
      parts={[samplePart]}
      selectedPartId={selectedPartId}
      onSelectPart={setSelectedPartId}
      onPartsChanged={() => undefined}
    />
  );
}

describe("PartsCatalog", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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

  it("opens part details with where-used after clicking a library row", async () => {
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

  it("opens the part editor modal from the details panel", async () => {
    stubCatalogFetch();
    render(<CatalogHarness initialId="p1" />);

    expect(await screen.findByText("Part details")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("heading", { name: "Edit part" })).toBeInTheDocument();
    expect(screen.getByLabelText("Part name")).toHaveValue("AMPH-010");
    expect(screen.getByLabelText("Description")).toHaveValue("Solenoid");
  });

  it("hides a library attribute when it is turned off in Columns", async () => {
    stubCatalogFetch();
    render(<CatalogHarness />);

    expect(await screen.findByRole("columnheader", { name: "Material" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByLabelText("Material"));
    expect(screen.queryByRole("columnheader", { name: "Material" })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
  });

  it("exports the visible library rows as CSV", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    expect(createObjectURL).toHaveBeenCalled();
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toContain("csv");
    const csv = await blob.text();
    expect(csv).toContain("Name");
    expect(csv).toContain("AMPH-010");
    expect(csv).toContain("SS316");
    expect(click).toHaveBeenCalled();
    click.mockRestore();
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
    const otherPart: Part = { ...samplePart, id: "p2", part_number: "AMPH-011", description: "Regulator" };
    let resolveFirstDocuments!: (response: Promise<Response>) => void;
    stubCatalogFetch((path) => {
      if (path === "/parts/p1/documents") return new Promise<Response>((resolve) => (resolveFirstDocuments = resolve));
      if (path === "/parts/p2/usage") return jsonResponse({ components: [], bom_snapshots: [] });
      if (path === "/parts/p2/documents") return jsonResponse([]);
      return null;
    });
    function TwoPartHarness() {
      const [selectedPartId, setSelectedPartId] = useState("p1");
      return <PartsCatalog parts={[samplePart, otherPart]} selectedPartId={selectedPartId} onSelectPart={setSelectedPartId} onPartsChanged={() => undefined} />;
    }
    render(<TwoPartHarness />);

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
