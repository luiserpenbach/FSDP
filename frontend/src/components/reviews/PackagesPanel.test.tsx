import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PackagesPanel } from "./PackagesPanel";
import type { SafetyPackage } from "../../types";

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

const existing: SafetyPackage = {
  id: "pkg1",
  project_id: "p1",
  title: "PDR safety package",
  scope: { systems: [], drawings: [{ id: "d1", number: "LOX-P-001", title: "LOX P&ID", revision: "A", sheets: 1 }], worksheets: [] },
  summary: { hazards: 2, hazards_high_open: 1, fmea_rows: 12, fmea_over_threshold: 3, rpn_threshold: 100, requirements_verified: 1, requirements_safety: 2, actions: 4, changes: 0 },
  generated_by: "k.ortega@example.test",
  generated_at: "2026-09-12T10:00:00Z",
  change_log_from: null,
  pdf_url: "/safety/packages/pkg1/pdf",
  xlsx_url: "/safety/packages/pkg1/xlsx",
  created_at: "2026-09-12T10:00:00Z"
};

describe("PackagesPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists packages and generates a new one with the chosen scope", async () => {
    const packages = [existing];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const path = String(url).replace("http://localhost:8000", "");
      if (path === "/projects/p1/safety/packages" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { title: string | null; drawing_ids: string[] | null };
        const created: SafetyPackage = { ...existing, id: "pkg2", title: body.title ?? "Safety review package 2", summary: { ...existing.summary!, changes: 5 } };
        packages.unshift(created);
        return jsonResponse(created, 201);
      }
      if (path === "/projects/p1/safety/packages") return jsonResponse(packages);
      if (path === "/projects/p1/drawings") return jsonResponse([{ id: "d1", number: "LOX-P-001", title: "LOX P&ID" }]);
      if (path === "/projects/p1/fmea") return jsonResponse([{ id: "w1", title: "LOX fill", revision: 1, status: "draft" }]);
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PackagesPanel projectId="p1" canWrite />);
    expect(await screen.findByText("PDR safety package")).toBeInTheDocument();
    expect(screen.getByText(/2 hazards \(1 severity I–II not accepted\)/)).toBeInTheDocument();

    fireEvent.click(await screen.findByLabelText(/LOX-P-001/));
    fireEvent.change(screen.getByLabelText("Title (optional)"), { target: { value: "CDR safety package" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate package" }));

    expect(await screen.findByText("CDR safety package")).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post).toBeDefined();
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ title: "CDR safety package", drawing_ids: ["d1"], worksheet_ids: null });
    await waitFor(() => expect(screen.getByText(/Generated CDR safety package in/)).toBeInTheDocument());
  });

  it("hides the form for viewers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse([]))
    );
    render(<PackagesPanel projectId="p1" canWrite={false} />);
    expect(await screen.findByText("No packages yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate package" })).not.toBeInTheDocument();
  });
});
