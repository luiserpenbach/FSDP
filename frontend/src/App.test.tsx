import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const TEST_USER = { id: "u1", email: "engineer@fsdp.test", name: "Test Engineer", role: "admin", is_active: true };

const PROJECT = {
  id: "p1",
  name: "Demo",
  description: null,
  owner: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z"
};
const PROJECT_B = {
  id: "p2",
  name: "Project B",
  description: null,
  owner: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z"
};
const SYSTEM = {
  id: "s1",
  project_id: "p1",
  name: "Helium",
  fluid: "GHe",
  description: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z"
};
const DIAGRAM = {
  id: "d1",
  system_id: "s1",
  name: "Diagram A",
  diagram_type: "pid",
  revision: 1,
  graph: {
    nodes: [
      {
        id: "valve-a",
        type: "pidSymbol",
        position: { x: 0, y: 0 },
        data: { label: "Valve A", symbolType: "valve", rotation: 0 }
      }
    ],
    edges: []
  },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z"
};

const DRAWING = {
  id: "dw1",
  project_id: "p1",
  system_id: "s1",
  number: "AMB2-9003",
  title: "HELIUM PANEL",
  size: "A3",
  units: "mm",
  discipline: "P&ID",
  status: "working",
  frame_template: "basic",
  fields: {},
  notes: [],
  sheets: [{ id: "sh1", sheet_no: 1, title: null, source_diagram_id: null }],
  revisions: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z"
};
const DRAWING_SHEET = {
  id: "sh1",
  drawing_id: "dw1",
  sheet_no: 1,
  title: null,
  source_diagram_id: null,
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
        tag: "PT-1",
        fields: {}
      }
    ],
    meta: { grid: 2.5 }
  },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z"
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  });
}

function mockWorkspaceFetch(overrides?: {
  onCreateProject?: () => void;
  onCreateSystem?: () => void;
  projects?: unknown[];
  systems?: unknown[];
}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url, "http://localhost").pathname;

    if (path === "/auth/me") return jsonResponse(TEST_USER);
    if (path === "/projects" && method === "GET") return jsonResponse(overrides?.projects ?? [PROJECT]);
    if (path === "/projects" && method === "POST") {
      overrides?.onCreateProject?.();
      return jsonResponse({ ...PROJECT, id: "p2", name: "New Project" }, 201);
    }
    if (path === "/projects/p1/systems" && method === "GET") return jsonResponse(overrides?.systems ?? [SYSTEM]);
    if (path === "/projects/p1/systems" && method === "POST") {
      overrides?.onCreateSystem?.();
      return jsonResponse({ ...SYSTEM, id: "s2", name: "New System" }, 201);
    }
    if (path === "/projects/p1/requirements") return jsonResponse([]);
    if (path === "/projects/p1/bom") return jsonResponse([]);
    if (path === "/projects/p2/systems") return jsonResponse([]);
    if (path === "/projects/p2/requirements") return jsonResponse([]);
    if (path === "/projects/p2/bom") return jsonResponse([]);
    if (path === "/parts" && method === "GET") return jsonResponse([]);
    if (path === "/changes") return jsonResponse([]);
    if (path === "/systems/s1/diagrams" && method === "GET") return jsonResponse([DIAGRAM]);
    if (path === "/systems/s2/diagrams" && method === "GET") return jsonResponse([]);
    if (path === "/diagrams/d1" && method === "GET") return jsonResponse(DIAGRAM);
    if (path === "/diagrams/d1/components") return jsonResponse([]);
    if (path === "/diagrams/d1/bom") return jsonResponse([]);
    return jsonResponse({ detail: `unmocked ${method} ${path}` }, 500);
  });
}

async function waitForWorkspace(projectName = PROJECT.name) {
  expect(await screen.findByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByText(projectName)).toBeInTheDocument();
  });
}

/** The workspace mock plus one drawing with a single-symbol sheet. */
function mockDraftingFetch(overrides?: Parameters<typeof mockWorkspaceFetch>[0]) {
  const base = mockWorkspaceFetch(overrides);
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === "/projects/p1/drawings") return jsonResponse([DRAWING]);
    if (path === "/sheets/sh1" && method === "GET") return jsonResponse(DRAWING_SHEET);
    if (path === "/sheets/sh1/drc") return jsonResponse({ sheet_id: "sh1", sheet_no: 1, counts: { error: 0, warning: 0, info: 0, waived: 0 }, findings: [], waivers: [], checks: [] });
    if (path === "/projects/p1/tag-scheme") return jsonResponse({ project_id: "p1", scheme: null });
    if (path === "/projects/p1/line-classes" || path === "/projects/p1/diagrams" || path === "/symbols") return jsonResponse([]);
    return base(input, init);
  });
}

/** Open the Drafting page and nudge the symbol so the sheet has unsaved edits. */
async function openDirtySheet() {
  render(<App />);
  await waitForWorkspace();
  fireEvent.click(screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/drafting"]')!);
  const canvas = await screen.findByTestId("schematic-canvas");
  await waitFor(() => expect(canvas.querySelector('[data-id="pt"]')).not.toBeNull());
  fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
  fireEvent.keyDown(canvas, { key: "ArrowRight" });
  expect(await screen.findByRole("button", { name: "Save" })).toBeEnabled();
}

describe("App", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
    // The project/system selection persists per browser; start each test fresh.
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the workspace shell for an authenticated user", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/auth/me")) return jsonResponse(TEST_USER);
        if (url.includes("/projects") || url.includes("/parts") || url.includes("/changes")) {
          return jsonResponse([]);
        }
        return jsonResponse({});
      })
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Parts Catalog")).toBeInTheDocument();
    expect(screen.getByText("BoM & Procurement")).toBeInTheDocument();
    expect(screen.getByText("Test Engineer")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    // The project/system switcher sits in the sidebar on every page.
    expect(screen.getByLabelText("Project")).toBeInTheDocument();
    expect(screen.getByLabelText("System")).toBeInTheDocument();
    // Placeholder pages are hidden until they do something.
    expect(screen.queryByText("Safety")).not.toBeInTheDocument();
    expect(screen.queryByText("Certification")).not.toBeInTheDocument();
  });

  it("shows the login page when there is no session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/auth/me")) return jsonResponse({ detail: "Not authenticated" }, 401);
        return jsonResponse({});
      })
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("creates a project on the Systems page and selects it in the switcher", async () => {
    let created = false;
    const base = mockWorkspaceFetch({ onCreateProject: () => (created = true) });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === "/projects" && (init?.method ?? "GET") === "GET" && created) {
          return jsonResponse([PROJECT, { ...PROJECT, id: "p2", name: "New Project" }]);
        }
        return base(input, init);
      })
    );

    render(<App />);
    await waitForWorkspace();
    fireEvent.click(screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/systems"]')!);
    expect(await screen.findByRole("heading", { level: 1, name: "Systems" })).toBeInTheDocument();

    fireEvent.change(screen.getAllByLabelText("Name")[0]!, { target: { value: "New Project" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(screen.getByLabelText("Project")).toHaveValue("p2"));
    expect(localStorage.getItem("fsdp.selectedProject")).toBe("p2");
  });

  it("asks before signing out discards an unsaved drafting sheet", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchMock = mockDraftingFetch();
    vi.stubGlobal("fetch", fetchMock);

    await openDirtySheet();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(confirmSpy).toHaveBeenCalledWith("You have unsaved drafting changes. Sign out and discard them?");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/auth/logout"))).toBe(false);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    confirmSpy.mockRestore();
  });

  it("keeps the workspace and its unsaved edits behind a sign-in overlay when the session expires", async () => {
    const base = mockDraftingFetch();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === "/sheets/sh1" && method === "PUT") return jsonResponse({ detail: "Not authenticated" }, 401);
      if (path === "/auth/login" && method === "POST") return jsonResponse(TEST_USER);
      return base(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);

    await openDirtySheet();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const overlay = await screen.findByRole("dialog", { name: "Session expired" });
    expect(overlay).toHaveTextContent("Your session has expired.");
    // The workspace stays mounted (inert) underneath, with the edit still pending.
    expect(screen.getByRole("heading", { level: 1, name: "Drafting" })).toBeInTheDocument();

    fireEvent.change(within(overlay).getByLabelText("Email"), { target: { value: TEST_USER.email } });
    fireEvent.change(within(overlay).getByLabelText("Password"), { target: { value: "secret-password" } });
    fireEvent.click(within(overlay).getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Session expired" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("asks before leaving the Drafting page with an unsaved sheet", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const base = mockWorkspaceFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === "/projects/p1/drawings") return jsonResponse([DRAWING]);
        if (path === "/sheets/sh1") return jsonResponse(DRAWING_SHEET);
        if (path === "/sheets/sh1/drc") return jsonResponse({ sheet_id: "sh1", sheet_no: 1, counts: { error: 0, warning: 0, info: 0, waived: 0 }, findings: [], waivers: [], checks: [] });
        if (path === "/projects/p1/tag-scheme") return jsonResponse({ project_id: "p1", scheme: null });
        if (path === "/projects/p1/line-classes" || path === "/symbols") return jsonResponse([]);
        return base(input, init);
      })
    );

    render(<App />);
    await waitForWorkspace();
    fireEvent.click(screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/drafting"]')!);
    const canvas = await screen.findByTestId("schematic-canvas");
    await waitFor(() => expect(canvas.querySelector('[data-id="pt"]')).not.toBeNull());
    fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(await screen.findByRole("button", { name: "Save" })).toBeEnabled();

    const partsLink = screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/parts"]')!;
    fireEvent.click(partsLink);
    await waitFor(() =>
      expect(confirmSpy).toHaveBeenCalledWith("You have unsaved drafting changes. Leave this page and discard them?")
    );
    expect(screen.getByRole("heading", { level: 1, name: "Drafting" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(partsLink);
    expect(await screen.findByRole("heading", { level: 1, name: "Parts" })).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("does not show a previous requirement's trace links after the selection changes", async () => {
    let resolveFirstLinks!: (body: unknown) => void;
    const base = mockWorkspaceFetch();
    const requirement = (id: string, key: string) => ({ id, project_id: "p1", key, title: `Requirement ${key}`, text: "", requirement_type: "safety", verification_method: null, status: "draft", constraint: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === "/projects/p1/requirements") return jsonResponse([requirement("r1", "REQ-1"), requirement("r2", "REQ-2")]);
        if (path === "/objects/requirement/r1/trace") {
          return new Promise<unknown>((resolve) => (resolveFirstLinks = resolve)).then((body) => jsonResponse(body));
        }
        if (path === "/objects/requirement/r2/trace") return jsonResponse([]);
        return base(input, init);
      })
    );

    render(<App />);
    await waitForWorkspace();
    fireEvent.click(screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/requirements"]')!);
    expect(await screen.findByRole("heading", { level: 1, name: "Requirements" })).toBeInTheDocument();
    await waitFor(() => expect(resolveFirstLinks).toBeDefined());

    fireEvent.click(screen.getAllByText("REQ-2")[0]!);
    expect(await screen.findByText("No trace links for REQ-2 yet.")).toBeInTheDocument();

    resolveFirstLinks([{ id: "link-1", source_type: "requirement", source_id: "r1", target_type: "component", target_id: "c-a", link_type: "satisfied_by", created_at: "2026-01-01T00:00:00Z" }]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByText("No trace links for REQ-2 yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("traces a requirement to a tagged drawing item and keeps legacy component links read-only", async () => {
    const requirement = { id: "r1", project_id: "p1", key: "REQ-1", title: "Relief", text: "", requirement_type: "safety", verification_method: null, status: "draft", constraint: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
    const sheetItem = { id: "row-1", sheet_id: "sh1", item_id: "pt", kind: "symbol", category: "instrument", tag: "PT-1", label: null, symbol_name: "Pressure transmitter", zone: "B-2", part_id: null, drawing_id: "dw1", drawing_number: "AMB2-9003", drawing_title: "HELIUM PANEL", sheet_no: 1 };
    const legacyLink = { id: "link-legacy", source_type: "requirement", source_id: "r1", target_type: "component", target_id: "c-a", link_type: "satisfied_by", created_at: "2026-01-01T00:00:00Z" };
    const itemLink = { id: "link-item", source_type: "requirement", source_id: "r1", target_type: "sheet_item", target_id: "row-1", link_type: "satisfied_by", created_at: "2026-01-01T00:00:00Z" };
    let links: unknown[] = [legacyLink];
    const base = mockWorkspaceFetch();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === "/projects/p1/requirements") return jsonResponse([requirement]);
      if (path === "/objects/requirement/r1/trace") return jsonResponse(links);
      if (path === "/projects/p1/drawings") return jsonResponse([DRAWING]);
      if (path === "/projects/p1/verification-matrix") return jsonResponse({ project_id: "p1", rows: [] });
      if (path === "/projects/p1/sheet-items") return jsonResponse([sheetItem]);
      if (path === "/projects/p1/diagrams") return jsonResponse([{ id: "d1", system_id: "s1", name: "Diagram A", diagram_type: "pid", revision: 1 }]);
      if (path === "/diagrams/d1/components") return jsonResponse([{ id: "c-a", diagram_id: "d1", tag: "V-A", quantity: 1 }]);
      if (path === "/trace-links" && method === "POST") {
        links = [legacyLink, itemLink];
        return jsonResponse(itemLink, 201);
      }
      if (path === "/trace-links/link-legacy" && method === "DELETE") {
        links = [itemLink];
        return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null), text: () => Promise.resolve("") });
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await waitForWorkspace();
    fireEvent.click(screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/requirements"]')!);
    expect(await screen.findByText("Legacy component V-A (Diagram A)")).toBeInTheDocument();
    expect(screen.getByText("· read-only")).toBeInTheDocument();
    // Legacy components are no longer edited here.
    expect(screen.queryByRole("button", { name: "Update component" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete component" })).not.toBeInTheDocument();

    const picker = screen.getByLabelText("Drawing item");
    await waitFor(() => expect(within(picker).getByRole("option", { name: "PT-1 · sheet 1 @ B-2 (Pressure transmitter)" })).toBeInTheDocument());
    fireEvent.change(picker, { target: { value: "row-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Link requirement to item" }));
    expect(await screen.findByText("AMB2-9003 sheet 1 · PT-1 @ B-2")).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith("/trace-links") && init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ source_type: "requirement", source_id: "r1", target_type: "sheet_item", target_id: "row-1" });

    // Legacy links can still be removed.
    fireEvent.click(within(screen.getByText("Legacy component V-A (Diagram A)").closest("tr")!).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText("Legacy component V-A (Diagram A)")).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/trace-links/link-legacy") && init?.method === "DELETE")).toBe(true);
  });

  it("shows a part's impact on drawings and opens a tag in Drafting from it", async () => {
    const part = { id: "part-1", part_number: "AMB2-001", description: "Pressure transmitter", part_type: "sensor", source_type: "internal", qualification_status: "qualified", certification_status: "certified", lifecycle_status: "active", preferred: true };
    const impact = {
      object_type: "part",
      object_id: "part-1",
      direct_links: [],
      affected_components: [{ id: "c-a", diagram_id: "d1", tag: "V-A", quantity: 1 }],
      affected_bom_snapshots: [{ id: "bom-1", diagram_id: null, drawing_id: "dw1", revision: 2, status: "released", rows: [] }],
      affected_drawings: [{ id: "dw1", project_id: "p1", number: "AMB2-9003", title: "HELIUM PANEL", status: "released", revision: "A", sheets: [1] }],
      affected_sheet_items: [{ id: "row-1", sheet_id: "sh1", item_id: "pt", tag: "PT-1", zone: "B-2", part_id: "part-1", drawing_id: "dw1", drawing_number: "AMB2-9003", sheet_no: 1 }],
      affected_requirements: [{ id: "r1", project_id: "p1", key: "REQ-1", title: "Relief", status: "approved" }],
      affected_parts: []
    };
    const base = mockDraftingFetch();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/parts") return jsonResponse([part]);
      if (url.pathname === "/changes/impact") return jsonResponse(impact);
      return base(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await waitForWorkspace();
    fireEvent.click(screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/reviews"]')!);
    expect(await screen.findByRole("heading", { level: 1, name: "Reviews" })).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByLabelText("Part")).getByRole("option", { name: "AMB2-001 · Pressure transmitter" })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Part"), { target: { value: "part-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Inspect impact" }));

    expect(await screen.findByText(/1 drawing\(s\), 1 tag\(s\), 1 requirement\(s\), 0 part\(s\), and 1 BoM snapshot\(s\) affected/)).toBeInTheDocument();
    const impactCall = fetchMock.mock.calls.map(([input]) => new URL(String(input), "http://localhost")).find((url) => url.pathname === "/changes/impact")!;
    expect(impactCall.searchParams.get("object_type")).toBe("part");
    expect(impactCall.searchParams.get("object_id")).toBe("part-1");
    expect(screen.getByRole("link", { name: "AMB2-9003" })).toHaveAttribute("href", "/drafting?project=p1&drawing=dw1");
    expect(screen.getByText("REQ-1")).toBeInTheDocument();
    expect(screen.getByText(/1 component\(s\) on legacy diagrams/)).toBeInTheDocument();

    // The tag link opens its drawing and sheet in Drafting and selects the item.
    const tagLink = screen.getByRole("link", { name: "PT-1" });
    expect(tagLink).toHaveAttribute("href", "/drafting?project=p1&drawing=dw1&sheet=sh1&item=pt");
    fireEvent.click(tagLink);
    expect(await screen.findByRole("heading", { level: 1, name: "Drafting" })).toBeInTheDocument();
    const tagInput = (await screen.findByLabelText("Tag")) as HTMLInputElement;
    expect(tagInput.value).toBe("PT-1");
  });

  it("asks before a project switch discards an unsaved drafting sheet, but not before a system switch", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const base = mockWorkspaceFetch({ projects: [PROJECT, PROJECT_B], systems: [SYSTEM, { ...SYSTEM, id: "s2", name: "Oxidizer" }] });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === "/projects/p1/drawings") return jsonResponse([DRAWING]);
        if (path === "/sheets/sh1") return jsonResponse(DRAWING_SHEET);
        if (path === "/sheets/sh1/drc") return jsonResponse({ sheet_id: "sh1", sheet_no: 1, counts: { error: 0, warning: 0, info: 0, waived: 0 }, findings: [], waivers: [], checks: [] });
        if (path === "/projects/p1/tag-scheme") return jsonResponse({ project_id: "p1", scheme: null });
        if (path === "/projects/p1/line-classes" || path === "/symbols") return jsonResponse([]);
        return base(input, init);
      })
    );

    render(<App />);
    await waitForWorkspace();
    fireEvent.click(screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/drafting"]')!);
    const canvas = await screen.findByTestId("schematic-canvas");
    await waitFor(() => expect(canvas.querySelector('[data-id="pt"]')).not.toBeNull());
    fireEvent.keyDown(canvas, { key: "a", ctrlKey: true });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(await screen.findByRole("button", { name: "Save" })).toBeEnabled();

    // Drawings belong to the project, not the system.
    fireEvent.change(screen.getByLabelText("System"), { target: { value: "s2" } });
    await waitFor(() => expect(screen.getByLabelText("System")).toHaveValue("s2"));
    expect(confirmSpy).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "p2" } });
    expect(confirmSpy).toHaveBeenCalledWith("You have unsaved drafting changes. Switch project and discard them?");
    expect(screen.getByLabelText("Project")).toHaveValue("p1");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    confirmSpy.mockRestore();
  });

  it("restores the persisted project and remembers a new choice", async () => {
    localStorage.setItem("fsdp.selectedProject", "p2");
    vi.stubGlobal("fetch", mockWorkspaceFetch({ projects: [PROJECT, PROJECT_B] }));

    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Project")).toHaveValue("p2"));

    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "p1" } });
    await waitFor(() => expect(screen.getByLabelText("System")).toHaveValue("s1"));
    expect(localStorage.getItem("fsdp.selectedProject")).toBe("p1");
    expect(localStorage.getItem("fsdp.selectedSystem")).toBe("s1");
  });

  it("sends the retired Diagrams route to Drafting and leaves it out of the navigation", async () => {
    window.history.pushState({}, "", "/diagrams");
    vi.stubGlobal("fetch", mockDraftingFetch());

    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Drafting" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/drafting");
    expect(screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/diagrams"]')).toBeNull();
  });

  it("redirects the retired placeholder routes to the dashboard", async () => {
    window.history.pushState({}, "", "/certification");
    vi.stubGlobal("fetch", mockWorkspaceFetch());

    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/dashboard");
  });

  it("summarizes the selected project on the dashboard, card by card", async () => {
    const base = mockWorkspaceFetch();
    const part = (id: string, lifecycle: string) => ({ id, part_number: id, description: id, part_type: "valve", source_type: "internal", qualification_status: "qualified", certification_status: "unreviewed", lifecycle_status: lifecycle, preferred: false, completeness: 100 });
    const row = (id: string, verdict: string, linkedDrawings = 0) => ({ requirement_id: id, key: id, title: id, status: "draft", constraint: null, checked: 0, passed: 0, failed: 0, verdict, drawings: [], linked_components: 0, linked_drawings: linkedDrawings, failures: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === "/parts") return jsonResponse([part("a", "draft"), part("b", "released"), part("c", "released")]);
        if (path === "/projects/p1/drawings") {
          return jsonResponse([DRAWING, { ...DRAWING, id: "dw2", number: "AMB2-9004", status: "released" }, { ...DRAWING, id: "dw3", number: "AMB2-9005", status: "released" }]);
        }
        if (path === "/drawings/dw1/drc") return jsonResponse({ drawing_id: "dw1", counts: { error: 2, warning: 1, info: 0, waived: 0 }, sheets: [] });
        if (path === "/drawings/dw2/drc") return jsonResponse({ drawing_id: "dw2", counts: { error: 0, warning: 0, info: 0, waived: 0 }, sheets: [] });
        if (path === "/drawings/dw3/drc") return jsonResponse({ detail: "boom" }, 500);
        if (path === "/projects/p1/verification-matrix") {
          return jsonResponse({ project_id: "p1", rows: [row("r1", "no_data"), row("r2", "pass"), row("r3", "manual", 1), row("r4", "manual")] });
        }
        return base(input, init);
      })
    );

    render(<App />);
    await waitForWorkspace();
    const card = async (title: string) => (await screen.findByText(title, { selector: ".dashCard > span" })).closest("a")!;

    const drawingsCard = await card("Drawings");
    expect(drawingsCard).toHaveAttribute("href", "/drafting");
    await waitFor(() => expect(drawingsCard.querySelector("strong")).toHaveTextContent("3"));
    expect(within(drawingsCard).getByText("released").closest("li")).toHaveTextContent("released2");
    expect(within(drawingsCard).getByText("working").closest("li")).toHaveTextContent("working1");

    const checksCard = await card("Design checks");
    expect(checksCard).toHaveAttribute("href", "/drafting");
    await waitFor(() => expect(checksCard.querySelector("strong")).toHaveTextContent("2"));
    expect(checksCard).toHaveTextContent("1 warning");
    expect(checksCard).toHaveTextContent("1 drawing(s) unchecked");
    expect(within(checksCard).getByText("AMB2-9003")).toBeInTheDocument();
    expect(within(checksCard).queryByText("AMB2-9004")).not.toBeInTheDocument();

    const requirementsCard = await card("Unverified requirements");
    expect(requirementsCard).toHaveAttribute("href", "/requirements");
    await waitFor(() => expect(requirementsCard.querySelector("strong")).toHaveTextContent("2"));
    expect(requirementsCard).toHaveTextContent("of 4 requirements");

    const partsCard = await card("Parts");
    expect(partsCard).toHaveAttribute("href", "/parts");
    await waitFor(() => expect(partsCard.querySelector("strong")).toHaveTextContent("3"));
    expect(within(partsCard).getByText("released").closest("li")).toHaveTextContent("released2");
  });

  it("keeps the other dashboard cards when one request fails", async () => {
    // The base mock answers drawings with a 500; the verification matrix still loads.
    const base = mockWorkspaceFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === "/projects/p1/verification-matrix") return jsonResponse({ project_id: "p1", rows: [] });
        return base(input, init);
      })
    );

    render(<App />);
    await waitForWorkspace();
    const drawingsCard = (await screen.findByText("Drawings", { selector: ".dashCard > span" })).closest("a")!;
    expect(await within(drawingsCard).findByText("Could not load.")).toBeInTheDocument();
    const requirementsCard = screen.getByText("Unverified requirements", { selector: ".dashCard > span" }).closest("a")!;
    await waitFor(() => expect(requirementsCard.querySelector("strong")).toHaveTextContent("0"));
  });
});
