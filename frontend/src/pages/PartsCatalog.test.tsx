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

    expect(await screen.findByText("Library")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New part" }));
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
});
