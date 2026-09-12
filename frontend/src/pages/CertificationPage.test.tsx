import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CertificationPage } from "./CertificationPage";
import type { CertificationEvidence, Project } from "../types";

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

const project: Project = { id: "p1", name: "LOX GSE", owner: "GSE", description: "", created_at: "", updated_at: "" } as Project;

const evidence: CertificationEvidence = {
  project_id: "p1",
  ready: false,
  counts: { hazards: 2, hazards_accepted: 1, requirements_safety: 2, requirements_verified: 1, worksheets: 1, worksheets_released: 1, analyses: 1, packages: 0, gaps: 3 },
  released_worksheets: [{ id: "w1", title: "LOX fill", revision: 1, released_by: "k.ortega", released_at: "2026-09-12T00:00:00Z", drawing_number: "LOX-P-001", drawing_revision: "A", current_drawing_revision: "B", behind_drawing: true, status: "released" }],
  accepted_hazards: [{ id: "h1", key: "HZ-001", title: "Fast-fill overpressure", severity_initial: "I", risk_residual: "medium", accepted_by: "k.ortega", accepted_at: "2026-09-12T00:00:00Z", status: "accepted" }],
  verified_requirements: [{ id: "r1", key: "REQ-SAF-001", title: "Thermal relief", verification_method: "analysis", verification_status: "verified", safety_critical: true }],
  analyses: [{ id: "a1", kind: "trapped_volume", title: "Trapped volume · LOX-P-001", verdict: "pass", outdated: false, drawing_number: "LOX-P-001", evidence_for: ["r1"] }],
  packages: [],
  gaps: [
    { kind: "hazard_not_accepted", ref_type: "hazard", ref_id: "h2", key: "HZ-002", title: "Backflow into GN2", detail: "severity II hazard is open; 1 of 2 independent controls verified" },
    { kind: "worksheet_behind_drawing", ref_type: "fmea_worksheet", ref_id: "w1", key: null, title: "LOX fill", detail: "released against drawing rev A, drawing is at rev B" },
    { kind: "no_package", ref_type: "project", ref_id: "p1", key: null, title: "No safety review package", detail: "generate one on the Reviews page" }
  ]
};

describe("CertificationPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists the evidence and the gaps", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).includes("/certification/evidence")) return jsonResponse(evidence);
        return jsonResponse({}, 404);
      })
    );
    render(
      <MemoryRouter>
        <CertificationPage project={project} />
      </MemoryRouter>
    );
    expect(await screen.findByText("Gaps · 3")).toBeInTheDocument();
    expect(screen.getByText("Hazard not accepted")).toBeInTheDocument();
    expect(screen.getByText("Worksheet behind drawing")).toBeInTheDocument();
    expect(screen.getByText("No review package")).toBeInTheDocument();
    expect(screen.getByText("HZ-001")).toBeInTheDocument();
    expect(screen.getByText("REQ-SAF-001")).toBeInTheDocument();
    expect(screen.getByText("behind drawing")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Open" })).toHaveLength(3);
  });

  it("asks for a project when none is selected", () => {
    render(
      <MemoryRouter>
        <CertificationPage project={null} />
      </MemoryRouter>
    );
    expect(screen.getByText(/Select a project/)).toBeInTheDocument();
  });
});
