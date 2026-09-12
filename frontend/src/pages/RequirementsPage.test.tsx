import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequirementsPage, treeOrder } from "./RequirementsPage";
import type { Requirement } from "../types";

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

const site: Requirement = { id: "r-site", project_id: "p1", key: "SITE-4.2", title: "Trapped cryogen relief", text: "Every isolable cryogenic volume shall have thermal relief.", requirement_type: "safety", status: "approved", category: "safety", verification_status: "planned", safety_critical: false, revision: 1 };
const derived: Requirement = {
  id: "r1",
  project_id: "p1",
  key: "REQ-SAF-031",
  title: "LOX thermal relief",
  text: "Every isolable LOX volume shall have a thermal relief valve.",
  requirement_type: "safety",
  status: "draft",
  category: "safety",
  verification_method: "design_rule",
  verification_status: "verified",
  safety_critical: true,
  parent_id: "r-site",
  revision: 3,
  constraint: { kind: "relief_required", values: [], scope: { services: ["LOX"] } }
};
const perf: Requirement = { id: "r2", project_id: "p1", key: "REQ-PERF-001", title: "Fill rate", text: "Fast fill shall deliver 40 kg/s.", requirement_type: "performance", status: "draft", category: "performance", verification_status: "planned", safety_critical: false, revision: 1 };

function Harness({ initial, calls }: { initial: Requirement[]; calls: Array<{ path: string; init?: RequestInit }> }) {
  const [requirements, setRequirements] = useState(initial);
  const [selected, setSelected] = useState("");
  void calls;
  return <RequirementsPage project={{ id: "p1", name: "LOX GSE" }} requirements={requirements} components={[{ id: "c1", diagram_id: "d1", tag: "V-B", quantity: 1 }]} selectedRequirementId={selected} canWrite onSelectRequirement={setSelected} onRequirementsChanged={setRequirements} />;
}

function stubFetch(calls: Array<{ path: string; init?: RequestInit }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const path = String(url).replace("http://localhost:8000", "");
      calls.push({ path, init });
      if (path === "/projects/p1/drawings") return jsonResponse([{ id: "dw1", project_id: "p1", number: "GSE-LOX-001", title: "LOX fill and drain", sheets: [], revisions: [] }]);
      if (path === "/projects/p1/verification-matrix") {
        return jsonResponse({
          project_id: "p1",
          rows: [
            { requirement_id: "r1", key: "REQ-SAF-031", title: "LOX thermal relief", status: "draft", constraint: derived.constraint, checked: 2, passed: 2, failed: 0, verdict: "pass", drawings: [{ drawing_id: "dw1", drawing_number: "GSE-LOX-001", checked: 2, failed: 0, sheets: [1] }], linked_components: 0, linked_drawings: 1, failures: [], verification_method: "design_rule", owner: "GSE lead", verification_status: "verified", safety_critical: true, evidence: { drc: 1 }, hazards: ["HZ-012"] }
          ]
        });
      }
      if (path === "/objects/requirement/r1/trace") return jsonResponse([{ id: "l1", source_type: "requirement", source_id: "r1", target_type: "drawing", target_id: "dw1", link_type: "verified_by" }]);
      if (path === "/requirements/r1/evidence") return jsonResponse([{ id: "e1", requirement_id: "r1", kind: "drc", ref_type: "sheet", ref_id: "s1", status: "pass", note: "Design rule check on sheet 1", recorded_by: null, created_at: "2026-09-12T00:00:00Z", updated_at: "2026-09-12T00:00:00Z" }]);
      if (path === "/requirements/r1/history") return jsonResponse([{ id: "h1", requirement_id: "r1", revision: 2, field: "title", old_value: "Relief", new_value: "LOX thermal relief", actor: "gse@fsdp.test", created_at: "2026-09-12T00:00:00Z" }]);
      if (path === "/requirements/r1/evidence" && init?.method === "POST") return jsonResponse({ id: "e2" }, 201);
      if (path === "/requirements/r1" && init?.method === "PUT") return jsonResponse({ ...derived, title: "LOX thermal relief (rev)", revision: 4 });
      if (path === "/projects/p1/requirements") return jsonResponse([site, { ...derived, title: "LOX thermal relief (rev)", revision: 4 }, perf]);
      return jsonResponse({ detail: `Unhandled ${path}` }, 404);
    })
  );
}

describe("RequirementsPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("orders requirements as a derivation tree", () => {
    expect(treeOrder([derived, perf, site]).map((row) => `${row.depth}:${row.requirement.key}`)).toEqual(["0:REQ-PERF-001", "0:SITE-4.2", "1:REQ-SAF-031"]);
  });

  it("filters, opens the drawer with links, evidence, and history, and saves", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    stubFetch(calls);
    render(<Harness initial={[site, derived, perf]} calls={calls} />);
    expect(await screen.findByText("Requirements · 3 of 3")).toBeInTheDocument();
    expect(screen.getByText("↳ REQ-SAF-031")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "performance" } });
    expect(screen.getByText("Requirements · 1 of 3")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("Safety-critical only"));
    // The parent stays visible so the tree keeps its shape: the match plus its ancestor.
    expect(screen.getByText("Requirements · 2 of 3")).toBeInTheDocument();
    expect(screen.getByText("SITE-4.2")).toBeInTheDocument();
    expect(screen.queryByText("REQ-PERF-001")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("↳ REQ-SAF-031"));
    const drawer = await screen.findByRole("complementary", { name: "Requirement REQ-SAF-031" });
    expect(within(drawer).getByText("safety-critical")).toBeInTheDocument();
    await waitFor(() => expect(within(drawer).getByText("GSE-LOX-001")).toBeInTheDocument());
    expect(within(drawer).getByText("drc")).toBeInTheDocument();
    expect(within(drawer).getByText(/rev 2/)).toBeInTheDocument();
    expect(within(drawer).getByLabelText("Rule")).toHaveValue("relief_required");
    expect(within(drawer).getByLabelText("Derives from")).toHaveValue("r-site");
    expect(within(drawer).getByRole("option", { name: "V-B" })).toBeInTheDocument();

    fireEvent.change(within(drawer).getByLabelText("Title"), { target: { value: "LOX thermal relief (rev)" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save requirement" }));
    await waitFor(() => expect(calls.some((call) => call.path === "/requirements/r1" && call.init?.method === "PUT")).toBe(true));
    const put = calls.find((call) => call.path === "/requirements/r1" && call.init?.method === "PUT");
    const body = JSON.parse(String(put?.init?.body)) as Record<string, unknown>;
    expect(body.parent_id).toBe("r-site");
    expect(body.constraint).toEqual({ kind: "relief_required", values: [], scope: { services: ["LOX"] } });
    await waitFor(() => expect(screen.getByText("LOX thermal relief (rev)")).toBeInTheDocument());

    fireEvent.change(within(drawer).getByLabelText("Reference"), { target: { value: "LOX-TP-07" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Record evidence" }));
    await waitFor(() => expect(calls.some((call) => call.path === "/requirements/r1/evidence" && call.init?.method === "POST")).toBe(true));
  });

  it("shows the verification matrix with status, evidence, and hazards", async () => {
    stubFetch([]);
    render(<Harness initial={[site, derived, perf]} calls={[]} />);
    await screen.findByText("Requirements · 3 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Verification matrix" }));
    expect(await screen.findByText("HZ-012")).toBeInTheDocument();
    expect(screen.getByText("1 drc")).toBeInTheDocument();
    expect(screen.getByText("2 pass / 0 fail")).toBeInTheDocument();
  });
});
