import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SafetyPage } from "./SafetyPage";
import type { Hazard, HazardMatrix, Requirement, SafetySettings } from "../types";

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

const settings: SafetySettings = {
  severity_scale: [
    { code: "I", name: "Catastrophic" },
    { code: "II", name: "Critical" },
    { code: "III", name: "Marginal" },
    { code: "IV", name: "Negligible" }
  ],
  likelihood_scale: [
    { code: "A", name: "Frequent" },
    { code: "B", name: "Probable" },
    { code: "C", name: "Occasional" },
    { code: "D", name: "Remote" },
    { code: "E", name: "Improbable" }
  ],
  risk_classes: [],
  risk_matrix: {
    I: { A: "high", B: "high", C: "high", D: "serious", E: "medium" },
    II: { A: "high", B: "high", C: "serious", D: "medium", E: "low" },
    III: { A: "serious", B: "serious", C: "medium", D: "medium", E: "low" },
    IV: { A: "medium", B: "medium", C: "medium", D: "low", E: "low" }
  },
  fault_tolerance: { I: 2, II: 2, III: 1, IV: 1 },
  rpn_threshold: 100,
  operating_modes: ["hold", "fast_fill"],
  hazard_categories: ["trapped_fluid", "backflow", "other"],
  auto_hazard: false,
  default_hazard_severity: "I",
  default_hazard_likelihood: "C",
  approvers: []
};

function hazard(overrides: Partial<Hazard>): Hazard {
  return {
    id: "h1",
    project_id: "p1",
    key: "HZ-001",
    title: "Overpressure of trapped LOX between FV-201 and QD-201",
    description: "",
    category: "trapped_fluid",
    system_id: null,
    operating_modes: ["hold"],
    severity_initial: "I",
    likelihood_initial: "C",
    severity_residual: "I",
    likelihood_residual: "D",
    status: "open",
    owner: null,
    accepted_by: null,
    accepted_at: null,
    acceptance_justification: null,
    fault_tolerance_required: 2,
    created_at: "2026-09-12T00:00:00Z",
    updated_at: "2026-09-12T00:00:00Z",
    computed_status: "open",
    risk_initial: "high",
    risk_residual: "serious",
    controls_total: 1,
    controls_verified: 1,
    independent_controls: 1,
    controls: [{ link_id: "l1", type: "requirement", id: "r1", label: "REQ-SAF-031", title: "Thermal relief", verification_status: "verified", covered: true, covering_requirements: [] }],
    causes: 0,
    ...overrides
  };
}

const matrix: HazardMatrix = {
  project_id: "p1",
  severity_scale: settings.severity_scale,
  likelihood_scale: settings.likelihood_scale,
  risk_matrix: settings.risk_matrix,
  initial: { I: { A: 0, B: 0, C: 1, D: 0, E: 0 }, II: { A: 0, B: 0, C: 1, D: 0, E: 0 }, III: { A: 0, B: 0, C: 0, D: 0, E: 0 }, IV: { A: 0, B: 0, C: 0, D: 0, E: 0 } },
  residual: { I: { A: 0, B: 0, C: 0, D: 1, E: 0 }, II: { A: 0, B: 0, C: 1, D: 0, E: 0 }, III: { A: 0, B: 0, C: 0, D: 0, E: 0 }, IV: { A: 0, B: 0, C: 0, D: 0, E: 0 } },
  unrated: 0
};

const requirements: Requirement[] = [
  { id: "r1", project_id: "p1", key: "REQ-SAF-031", title: "Thermal relief", text: "Shall.", requirement_type: "safety", status: "draft", category: "safety", safety_critical: true, verification_status: "verified" },
  { id: "r2", project_id: "p1", key: "REQ-SAF-034", title: "Drainback before isolation", text: "Shall.", requirement_type: "safety", status: "draft", category: "safety", safety_critical: false, verification_status: "planned" }
];

function stubFetch(calls: Array<{ path: string; init?: RequestInit }>) {
  const worksheets: Array<Record<string, unknown>> = [];
  const fmeaRows: Array<Record<string, unknown>> = [];
  const hazards = [hazard({}), hazard({ id: "h2", key: "HZ-015", title: "Backflow of LOX into transfer pump on trip", category: "backflow", severity_initial: "II", severity_residual: "II", likelihood_residual: "C", operating_modes: ["fast_fill"], controls_total: 2, controls_verified: 2, independent_controls: 2, computed_status: "controlled", risk_residual: "medium" })];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const path = String(url).replace("http://localhost:8000", "");
      calls.push({ path, init });
      if (path === "/projects/p1/hazards") return jsonResponse(hazards);
      if (path === "/projects/p1/hazards/matrix") return jsonResponse(matrix);
      if (path === "/projects/p1/safety-settings") return jsonResponse({ project_id: "p1", settings });
      if (path === "/hazards/h1/controls" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { type: string; id: string };
        return jsonResponse(
          hazard({
            controls_total: 2,
            controls_verified: 1,
            independent_controls: 2,
            controls: [...hazard({}).controls, { link_id: "l2", type: "requirement", id: body.id, label: "REQ-SAF-034", title: "Drainback before isolation", verification_status: "planned", covered: true, covering_requirements: [] }]
          }),
          201
        );
      }
      if (path === "/hazards/h1/derive-requirement" && init?.method === "POST") {
        return jsonResponse({ id: "r3", project_id: "p1", key: "REQ-SAF-040", title: "New", text: "Shall.", requirement_type: "safety", status: "draft" }, 201);
      }
      if (path === "/projects/p1/drawings") return jsonResponse([{ id: "d1", project_id: "p1", number: "GSE-LOX-001", title: "LOX fill and drain", sheets: [{ id: "s1", sheet_no: 1 }], revisions: [{ id: "rv1", label: "B", sequence: 1 }] }]);
      if (path === "/projects/p1/fmea" && init?.method === "POST") {
        worksheets.push({ id: "w1", project_id: "p1", system_id: null, drawing_id: "d1", drawing_number: "GSE-LOX-001", drawing_revision_label: "B", drawing_current_revision_label: "B", revision_drift: false, title: JSON.parse(String(init.body)).title, method: "fmea", operating_modes: ["hold", "fast_fill"], status: "draft", revision: 0, row_count: 0, stale_count: 0, open_actions: 0, above_threshold: 0, created_at: "2026-09-12T00:00:00Z", updated_at: "2026-09-12T00:00:00Z" });
        return jsonResponse(worksheets[0], 201);
      }
      if (path === "/projects/p1/fmea") return jsonResponse(worksheets);
      if (path === "/fmea/w1") return jsonResponse({ ...worksheets[0], row_count: fmeaRows.length });
      if (path === "/fmea/w1/generate" && init?.method === "POST") {
        fmeaRows.push({ id: "fr1", worksheet_id: "w1", sheet_id: "s1", item_id: "fv201", subject_text: null, item_tag: "FV-201", item_category: "valve", item_symbol: "Pneumatic valve", item_zone: "C-4", item_exists: true, part_id: null, part_number: null, sheet_no: 1, drawing_id: "d1", drawing_number: "GSE-LOX-001", failure_mode_id: "m1", failure_mode_text: null, failure_mode_name: "fails_closed", failure_mode_title: "Fails closed / fails to open", operating_modes: ["fast_fill"], cause: "", local_effect: "FV-201 blocks LOX; no flow downstream", next_effect: "", end_effect: "", detected_by_item_id: "pt205", detected_by_tag: "PT-205", detection_kind: "instrument", detection_reason: null, severity: 6, occurrence: null, detection: null, rpn: null, hazard_id: null, hazard_key: null, recommended_action: null, action_owner: null, action_due: null, action_status: "not_required", severity_residual: null, occurrence_residual: null, detection_residual: null, rpn_residual: null, notes: null, not_applicable: false, stale_reason: null, stale_detail: null, position: 1, controls: [], comment_count: 0, open_comment_count: 0, created_at: "2026-09-12T00:00:00Z", updated_at: "2026-09-12T00:00:00Z" });
        return jsonResponse({ added: 1, kept: 0, stale: 0, items_without_modes: ["QD-201"] });
      }
      if (path === "/fmea/w1/rows") return jsonResponse(fmeaRows);
      if (path === "/fmea/w1/gate") return jsonResponse({ ready: false, blockers: [{ row_id: "fr1", item: "FV-201", reason: "no detection and no reason recorded" }] });
      if (path === "/fmea/w1/releases") return jsonResponse([]);
      if (path === "/hazards/h1") return jsonResponse(hazard({ controls_total: 3 }));
      if (path === "/hazards/h1/accept" && init?.method === "POST") {
        return jsonResponse(hazard({ status: "accepted", computed_status: "accepted", accepted_by: "sma@fsdp.test", acceptance_justification: "Agreed" }));
      }
      return jsonResponse({ detail: `Unhandled ${path}` }, 404);
    })
  );
}

describe("SafetyPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the overview tiles, the risk matrix, and the hazards needing attention", async () => {
    stubFetch([]);
    render(<MemoryRouter><SafetyPage project={{ id: "p1", name: "LOX GSE" }} systems={[]} requirements={requirements} canWrite onRequirementsChanged={() => undefined} /></MemoryRouter>);
    expect(await screen.findByText("Uncontrolled I–II")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("grid", { name: "residual risk matrix" })).toBeInTheDocument());
    expect(screen.getByRole("gridcell", { name: "I-D: 1 hazard, serious" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Initial" }));
    expect(screen.getByRole("gridcell", { name: "I-C: 1 hazard, high" })).toBeInTheDocument();
    const attention = screen.getByText("Needs attention").closest("article")!;
    expect(within(attention).getByText("HZ-001")).toBeInTheDocument();
    expect(within(attention).queryByText("HZ-015")).not.toBeInTheDocument();
  });

  it("filters the log from the matrix, opens a hazard, adds a control, derives a requirement, and accepts", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    stubFetch(calls);
    const onRequirementsChanged = vi.fn();
    render(<MemoryRouter><SafetyPage project={{ id: "p1", name: "LOX GSE" }} systems={[]} requirements={requirements} canWrite onRequirementsChanged={onRequirementsChanged} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("grid", { name: "residual risk matrix" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("gridcell", { name: "II-C: 1 hazard, serious" }));
    expect(await screen.findByText("Hazard log · 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("HZ-015")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Clear matrix filter/ }));
    expect(screen.getByText("Hazard log · 2 of 2")).toBeInTheDocument();

    fireEvent.click(screen.getByText("HZ-001"));
    const drawer = await screen.findByRole("complementary", { name: "Hazard HZ-001" });
    expect(within(drawer).getByText("REQ-SAF-031")).toBeInTheDocument();
    expect(within(drawer).getByText(/1 of 1 verified · 1 of 2 independent required/)).toBeInTheDocument();

    fireEvent.change(within(drawer).getByLabelText("Requirement"), { target: { value: "r2" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Add control" }));
    await waitFor(() => expect(within(drawer).getByText("REQ-SAF-034")).toBeInTheDocument());
    const post = calls.find((call) => call.path === "/hazards/h1/controls");
    expect(JSON.parse(String(post?.init?.body))).toEqual({ type: "requirement", id: "r2" });
    expect(onRequirementsChanged).toHaveBeenCalled();

    fireEvent.click(within(drawer).getByRole("button", { name: "New safety requirement from this hazard" }));
    fireEvent.change(within(drawer).getByLabelText("Key"), { target: { value: "REQ-SAF-040" } });
    fireEvent.change(within(drawer).getByLabelText("Requirement title"), { target: { value: "Pump trip interlock" } });
    fireEvent.change(within(drawer).getByLabelText("Requirement text"), { target: { value: "The transfer pump shall trip on loss of FV-201 position feedback." } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Create and link" }));
    await waitFor(() => expect(calls.some((call) => call.path === "/hazards/h1/derive-requirement")).toBe(true));
    await waitFor(() => expect(within(drawer).getByText(/of 3 verified/)).toBeInTheDocument());

    fireEvent.change(within(drawer).getByLabelText("Justification"), { target: { value: "Agreed" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Accept residual risk" }));
    await waitFor(() => expect(within(drawer).getByText(/Accepted by sma@fsdp.test/)).toBeInTheDocument());
  });

  it("creates a worksheet, generates rows from the drawing, and shows the release gate", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    stubFetch(calls);
    render(<MemoryRouter><SafetyPage project={{ id: "p1", name: "LOX GSE" }} systems={[]} requirements={requirements} canWrite onRequirementsChanged={() => undefined} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("grid", { name: "residual risk matrix" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "FMEA" }));
    expect(await screen.findByText(/Create a worksheet for a drawing/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New worksheet" }));
    const dialog = await screen.findByRole("dialog", { name: "New worksheet" });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "LOX fill and drain" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create worksheet" }));
    await waitFor(() => expect(calls.some((call) => call.path === "/projects/p1/fmea" && call.init?.method === "POST")).toBe(true));
    expect(await screen.findByText(/generated against/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Generate rows…" }));
    const generate = await screen.findByRole("dialog", { name: "Generate rows" });
    fireEvent.click(within(generate).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(calls.some((call) => call.path === "/fmea/w1/generate")).toBe(true));
    const grid = await screen.findByRole("grid", { name: "FMEA worksheet" });
    await waitFor(() => expect(within(grid).getByText("FV-201")).toBeInTheDocument());
    expect(within(grid).getByText("PT-205")).toBeInTheDocument();
    expect(await screen.findByText(/No library modes for: QD-201/)).toBeInTheDocument();
    expect(await screen.findByText(/1 thing blocks release/)).toBeInTheDocument();
  });

  it("asks for a project when none is selected", () => {
    stubFetch([]);
    render(<MemoryRouter><SafetyPage project={null} systems={[]} requirements={[]} canWrite={false} onRequirementsChanged={() => undefined} /></MemoryRouter>);
    expect(screen.getByText(/Select a project on the Systems page/)).toBeInTheDocument();
  });
});
