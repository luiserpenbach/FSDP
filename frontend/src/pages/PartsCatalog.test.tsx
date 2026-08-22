import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  completeness: 40
};

describe("PartsCatalog", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("fills a generated unique name into the part name field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const path = String(url).replace("http://localhost:8000", "");
        if (path === "/catalog/settings") {
          return jsonResponse({
            prefix: "AMPH",
            sequence_padding: 3,
            next_sequence: 1,
            part_types: ["valve"]
          });
        }
        if (path.startsWith("/catalog/generate-name") && init?.method === "POST") {
          return jsonResponse({ part_number: "AMPH-001" });
        }
        return jsonResponse({});
      })
    );

    render(
      <PartsCatalog
        parts={[]}
        selectedPartId=""
        onSelectPart={() => undefined}
        onPartsChanged={() => undefined}
      />
    );

    expect(await screen.findByText("Library")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Part name")).toHaveValue("AMPH-001");
    });
  });

  it("lists catalog parts and where-used for the selection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const path = String(url).replace("http://localhost:8000", "");
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

    render(
      <PartsCatalog
        parts={[samplePart]}
        selectedPartId="p1"
        onSelectPart={() => undefined}
        onPartsChanged={() => undefined}
      />
    );

    expect(await screen.findByText("AMPH-010")).toBeInTheDocument();
    expect(await screen.findByText("V-1")).toBeInTheDocument();
    expect(screen.getByText("Vehicle")).toBeInTheDocument();
  });
});
