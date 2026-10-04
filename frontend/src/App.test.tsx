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
const PROJECT_A = {
  id: "p1",
  name: "Project A",
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
const SYSTEM_A = {
  id: "s1",
  project_id: "p1",
  name: "System A",
  fluid: "GHe",
  description: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z"
};
const SYSTEM_B = {
  id: "s2",
  project_id: "p2",
  name: "System B",
  fluid: "LOX",
  description: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z"
};
const EXISTING_DIAGRAM = {
  id: "d1",
  system_id: "s1",
  name: "Helium P&ID",
  diagram_type: "pid",
  revision: 2,
  graph: {
    nodes: [
      {
        id: "valve-1",
        type: "pidSymbol",
        position: { x: 0, y: 0 },
        data: { label: "Valve", symbolType: "valve", rotation: 0 }
      }
    ],
    edges: []
  },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z"
};
const NEW_DIAGRAM = {
  id: "d2",
  system_id: "s1",
  name: "Propellant Feed",
  diagram_type: "pid",
  revision: 1,
  graph: { nodes: [], edges: [] },
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
const DIAGRAM_A = {
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
const DIAGRAM_B_SAME_SYSTEM = {
  id: "d2",
  system_id: "s1",
  name: "Diagram B",
  diagram_type: "pid",
  revision: 1,
  graph: {
    nodes: [
      {
        id: "valve-b",
        type: "pidSymbol",
        position: { x: 40, y: 40 },
        data: { label: "Valve B", symbolType: "valve", rotation: 0 }
      }
    ],
    edges: []
  },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z"
};
const DIAGRAM_B = {
  id: "d2",
  system_id: "s2",
  name: "Diagram B",
  diagram_type: "pid",
  revision: 1,
  graph: {
    nodes: [
      {
        id: "valve-b",
        type: "pidSymbol",
        position: { x: 40, y: 40 },
        data: { label: "Valve B", symbolType: "valve", rotation: 0 }
      }
    ],
    edges: []
  },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z"
};
const COMPONENT_A = {
  id: "c-a",
  diagram_id: "d1",
  node_id: null,
  part_id: null,
  tag: "V-A",
  quantity: 1,
  properties: { node_external_id: "valve-a" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z"
};
const COMPONENT_B = {
  id: "c-b",
  diagram_id: "d2",
  node_id: null,
  part_id: null,
  tag: "V-B",
  quantity: 1,
  properties: { node_external_id: "valve-b" },
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

async function makeDiagramDirty() {
  const node = await waitFor(() => document.querySelector(".react-flow__node") as HTMLElement);
  fireEvent.click(node);
  const rotateButton = await screen.findByTitle("Rotate symbol 90 degrees");
  fireEvent.click(rotateButton);
  await screen.findByText("Unsaved changes");
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

async function openDirtyDiagram() {
  render(<App />);
  await waitForWorkspace();

  fireEvent.click(
    screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/diagrams"]')!
  );
  expect(await screen.findByRole("heading", { level: 1, name: "Diagrams" })).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByLabelText("Open diagram")).toHaveValue("d1");
  });
  await waitFor(() => {
    expect(screen.getByText("Valve A")).toBeInTheDocument();
  });

  await makeDiagramDirty();
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

  it("creates a blank P&ID instead of copying the open canvas", async () => {
    let diagrams = [EXISTING_DIAGRAM];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url, "http://localhost").pathname;

      if (path === "/auth/me") return jsonResponse(TEST_USER);
      if (path === "/projects" && method === "GET") return jsonResponse([PROJECT]);
      if (path === "/projects/p1/systems") return jsonResponse([SYSTEM]);
      if (path === "/projects/p1/requirements") return jsonResponse([]);
      if (path === "/projects/p1/bom") return jsonResponse([]);
      if (path === "/parts" && method === "GET") return jsonResponse([]);
      if (path === "/changes") return jsonResponse([]);
      if (path === "/systems/s1/diagrams" && method === "GET") return jsonResponse(diagrams);
      if (path === "/systems/s1/diagrams" && method === "POST") {
        diagrams = [EXISTING_DIAGRAM, NEW_DIAGRAM];
        return jsonResponse(NEW_DIAGRAM, 201);
      }
      if (path === "/diagrams/d1" && method === "GET") return jsonResponse(EXISTING_DIAGRAM);
      if (path === "/diagrams/d2" && method === "GET") return jsonResponse(NEW_DIAGRAM);
      if (path === "/diagrams/d1/components" || path === "/diagrams/d2/components") {
        return jsonResponse([]);
      }
      if (path === "/diagrams/d1/bom" || path === "/diagrams/d2/bom") return jsonResponse([]);
      return jsonResponse({ detail: `unmocked ${method} ${path}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    await waitForWorkspace();

    fireEvent.click(screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/diagrams"]')!);
    expect(await screen.findByRole("heading", { level: 1, name: "Diagrams" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("Open diagram")).toHaveValue("d1");
    });

    fireEvent.change(screen.getByLabelText("Diagram name"), {
      target: { value: "Propellant Feed" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create P&ID" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/systems/s1/diagrams"),
        expect.objectContaining({ method: "POST" })
      )
    );

    const graphWrites = fetchMock.mock.calls.filter(([input, init]) => {
      const url = typeof input === "string" ? input : String(input);
      const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
      return url.includes("/graph") && method === "PUT";
    });
    expect(graphWrites).toHaveLength(0);

    await waitFor(() => expect(screen.getByLabelText("Open diagram")).toHaveValue("d2"));
  });

  it("ignores a stale diagram load so a slower prior response cannot overwrite the open diagram", async () => {
    let resolveComponentsA!: (body: unknown) => void;
    const componentsAPromise = new Promise<unknown>((resolve) => {
      resolveComponentsA = resolve;
    });

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url, "http://localhost").pathname;

      if (path === "/auth/me") return jsonResponse(TEST_USER);
      if (path === "/projects" && method === "GET") return jsonResponse([PROJECT]);
      if (path === "/projects/p1/systems") return jsonResponse([SYSTEM]);
      if (path === "/projects/p1/requirements") return jsonResponse([]);
      if (path === "/projects/p1/bom") return jsonResponse([]);
      if (path === "/parts" && method === "GET") return jsonResponse([]);
      if (path === "/changes") return jsonResponse([]);
      if (path === "/systems/s1/diagrams" && method === "GET") {
        return jsonResponse([DIAGRAM_A, DIAGRAM_B_SAME_SYSTEM]);
      }
      if (path === "/diagrams/d1" && method === "GET") return jsonResponse(DIAGRAM_A);
      if (path === "/diagrams/d2" && method === "GET") return jsonResponse(DIAGRAM_B_SAME_SYSTEM);
      if (path === "/diagrams/d1/components") {
        return componentsAPromise.then((body) => jsonResponse(body));
      }
      if (path === "/diagrams/d2/components") return jsonResponse([COMPONENT_B]);
      if (path === "/diagrams/d1/bom" || path === "/diagrams/d2/bom") return jsonResponse([]);
      return jsonResponse({ detail: `unmocked ${method} ${path}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    await waitForWorkspace();

    fireEvent.click(
      screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/diagrams"]')!
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Diagrams" })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByLabelText("Open diagram")).toHaveValue("d1");
    });
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/diagrams/d1/components"))).toBe(
        true
      );
    });

    fireEvent.change(screen.getByLabelText("Open diagram"), { target: { value: "d2" } });
    await waitFor(() => {
      expect(screen.getByLabelText("Open diagram")).toHaveValue("d2");
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Diagram name")).toHaveValue("Diagram B");
    });
    await waitFor(() => {
      expect(screen.getByText("Valve B")).toBeInTheDocument();
    });
    expect(screen.queryByText("Valve A")).not.toBeInTheDocument();

    resolveComponentsA([COMPONENT_A]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByLabelText("Open diagram")).toHaveValue("d2");
    expect(screen.getByLabelText("Diagram name")).toHaveValue("Diagram B");
    expect(screen.getByText("Valve B")).toBeInTheDocument();
    expect(screen.queryByText("Valve A")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/requirements"]')!
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Requirements" })).toBeInTheDocument();
    // The Requirements page loads the open diagram's components itself.
    expect(await screen.findByText("V-B")).toBeInTheDocument();
    expect(screen.queryByText("V-A")).not.toBeInTheDocument();
  });

  it("keeps the diagram dirty when the canvas is edited after graph load but before components finish", async () => {
    let resolveComponentsB!: (body: unknown) => void;
    const componentsBPromise = new Promise<unknown>((resolve) => {
      resolveComponentsB = resolve;
    });

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url, "http://localhost").pathname;

      if (path === "/auth/me") return jsonResponse(TEST_USER);
      if (path === "/projects" && method === "GET") return jsonResponse([PROJECT]);
      if (path === "/projects/p1/systems") return jsonResponse([SYSTEM]);
      if (path === "/projects/p1/requirements") return jsonResponse([]);
      if (path === "/projects/p1/bom") return jsonResponse([]);
      if (path === "/parts" && method === "GET") return jsonResponse([]);
      if (path === "/changes") return jsonResponse([]);
      if (path === "/systems/s1/diagrams" && method === "GET") {
        return jsonResponse([DIAGRAM_A, DIAGRAM_B_SAME_SYSTEM]);
      }
      if (path === "/diagrams/d1" && method === "GET") return jsonResponse(DIAGRAM_A);
      if (path === "/diagrams/d2" && method === "GET") return jsonResponse(DIAGRAM_B_SAME_SYSTEM);
      if (path === "/diagrams/d1/components") return jsonResponse([COMPONENT_A]);
      if (path === "/diagrams/d2/components") {
        return componentsBPromise.then((body) => jsonResponse(body));
      }
      if (path === "/diagrams/d1/bom" || path === "/diagrams/d2/bom") return jsonResponse([]);
      return jsonResponse({ detail: `unmocked ${method} ${path}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitForWorkspace();

    fireEvent.click(
      screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/diagrams"]')!
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Diagrams" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("Open diagram")).toHaveValue("d1");
    });
    await waitFor(() => {
      expect(screen.getByText("Valve A")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Open diagram"), { target: { value: "d2" } });
    await waitFor(() => {
      expect(screen.getByLabelText("Open diagram")).toHaveValue("d2");
    });
    await waitFor(() => {
      expect(screen.getByText("Valve B")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/diagrams/d2/components"))).toBe(
        true
      );
    });

    await makeDiagramDirty();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    resolveComponentsB([COMPONENT_B]);
    // Allow the in-flight load to finish its component/BoM phase and attempt to
    // clear dirty — the mid-load edit must still be protected.
    await waitFor(() => {
      expect(screen.getByText("Loaded saved diagram.")).toBeInTheDocument();
    });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save graph" })).not.toBeDisabled();
  });

  it("ignores a stale system diagram list so a slower prior response cannot switch the open P&ID", async () => {
    let resolveDiagramsA!: (body: unknown) => void;
    const diagramsAPromise = new Promise<unknown>((resolve) => {
      resolveDiagramsA = resolve;
    });

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url, "http://localhost").pathname;

      if (path === "/auth/me") return jsonResponse(TEST_USER);
      if (path === "/projects" && method === "GET") return jsonResponse([PROJECT_A, PROJECT_B]);
      if (path === "/projects/p1/systems") return jsonResponse([SYSTEM_A]);
      if (path === "/projects/p2/systems") return jsonResponse([SYSTEM_B]);
      if (path === "/projects/p1/requirements" || path === "/projects/p2/requirements") return jsonResponse([]);
      if (path === "/projects/p1/bom" || path === "/projects/p2/bom") return jsonResponse([]);
      if (path === "/parts" && method === "GET") return jsonResponse([]);
      if (path === "/changes") return jsonResponse([]);
      if (path === "/systems/s1/diagrams" && method === "GET") {
        return diagramsAPromise.then((body) => jsonResponse(body));
      }
      if (path === "/systems/s2/diagrams" && method === "GET") return jsonResponse([DIAGRAM_B]);
      if (path === "/diagrams/d1" && method === "GET") return jsonResponse(DIAGRAM_A);
      if (path === "/diagrams/d2" && method === "GET") return jsonResponse(DIAGRAM_B);
      if (path === "/diagrams/d1/components" || path === "/diagrams/d2/components") return jsonResponse([]);
      if (path === "/diagrams/d1/bom" || path === "/diagrams/d2/bom") return jsonResponse([]);
      return jsonResponse({ detail: `unmocked ${method} ${path}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    await waitForWorkspace(PROJECT_A.name);

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/systems/s1/diagrams"))).toBe(true);
    });

    fireEvent.click(
      screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/systems"]')!
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Systems" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("main")).getByText("Project B"));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/systems/s2/diagrams"))).toBe(true);
    });

    fireEvent.click(
      screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/diagrams"]')!
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Diagrams" })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByLabelText("Open diagram")).toHaveValue("d2");
    });
    expect(screen.getByLabelText("Open diagram")).toHaveTextContent("Diagram B");

    resolveDiagramsA([DIAGRAM_A]);

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/diagrams/d2"))).toBe(true);
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(screen.getByLabelText("Open diagram")).toHaveValue("d2");
    expect(screen.getByLabelText("Open diagram")).not.toHaveValue("d1");
    expect(screen.queryByText("Valve A")).not.toBeInTheDocument();
  });

  it("keeps the diagram dirty when the canvas is edited during an in-flight save", async () => {
    let resolveGraphSave!: (body: unknown) => void;
    const graphSavePromise = new Promise<unknown>((resolve) => {
      resolveGraphSave = resolve;
    });

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url, "http://localhost").pathname;

      if (path === "/auth/me") return jsonResponse(TEST_USER);
      if (path === "/projects" && method === "GET") return jsonResponse([PROJECT]);
      if (path === "/projects/p1/systems") return jsonResponse([SYSTEM]);
      if (path === "/projects/p1/requirements") return jsonResponse([]);
      if (path === "/projects/p1/bom") return jsonResponse([]);
      if (path === "/parts" && method === "GET") return jsonResponse([]);
      if (path === "/changes") return jsonResponse([]);
      if (path === "/systems/s1/diagrams" && method === "GET") return jsonResponse([DIAGRAM]);
      if (path === "/diagrams/d1" && method === "GET") return jsonResponse(DIAGRAM);
      if (path === "/diagrams/d1/components") return jsonResponse([]);
      if (path === "/diagrams/d1/bom") return jsonResponse([]);
      if (path === "/diagrams/d1/graph" && method === "PUT") {
        return graphSavePromise.then((body) => jsonResponse(body));
      }
      return jsonResponse({ detail: `unmocked ${method} ${path}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    await waitForWorkspace();

    fireEvent.click(
      screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/diagrams"]')!
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Diagrams" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("Open diagram")).toHaveValue("d1");
    });
    await waitFor(() => {
      expect(screen.getByText("Valve A")).toBeInTheDocument();
    });

    await makeDiagramDirty();

    fireEvent.click(screen.getByRole("button", { name: "Save graph" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input, init]) => {
        const url = String(input);
        return url.includes("/diagrams/d1/graph") && (init?.method ?? "GET").toUpperCase() === "PUT";
      })).toBe(true);
    });

    // Edit again while the save request is still outstanding. The save response
    // must not clear dirty — those mid-save edits were not persisted.
    fireEvent.click(screen.getByTitle("Rotate symbol 90 degrees"));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    resolveGraphSave({
      ...DIAGRAM,
      revision: 2,
      graph: {
        nodes: [
          ...DIAGRAM.graph.nodes,
          {
            id: "valve-mid-save",
            type: "pidSymbol",
            position: { x: 120, y: 180 },
            data: { label: "Valve", symbolType: "valve", rotation: 0 }
          }
        ],
        edges: []
      }
    });

    await waitFor(() => {
      expect(screen.getByText("Saved graph.")).toBeInTheDocument();
    });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.queryByText("Saved", { selector: ".cleanBadge" })).not.toBeInTheDocument();
  });

  it("asks before switching project from the sidebar discards unsaved diagram edits", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchMock = mockWorkspaceFetch({ projects: [PROJECT, PROJECT_B] });
    vi.stubGlobal("fetch", fetchMock);

    await openDirtyDiagram();
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "p2" } });

    expect(confirmSpy).toHaveBeenCalledWith("You have unsaved diagram changes. Switch project and discard them?");
    expect(screen.getByLabelText("Project")).toHaveValue("p1");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/projects/p2/systems"))).toBe(false);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("asks before switching system from the sidebar discards unsaved diagram edits", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchMock = mockWorkspaceFetch({ systems: [SYSTEM, { ...SYSTEM, id: "s2", name: "Oxidizer" }] });
    vi.stubGlobal("fetch", fetchMock);

    await openDirtyDiagram();
    fireEvent.change(screen.getByLabelText("System"), { target: { value: "s2" } });

    expect(confirmSpy).toHaveBeenCalledWith("You have unsaved diagram changes. Switch system and discard them?");
    expect(screen.getByLabelText("System")).toHaveValue("s1");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/systems/s2/diagrams"))).toBe(false);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    confirmSpy.mockRestore();
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

  it("asks before signing out discards unsaved diagram edits", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchMock = mockWorkspaceFetch();
    vi.stubGlobal("fetch", fetchMock);

    await openDirtyDiagram();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(confirmSpy).toHaveBeenCalledWith("You have unsaved diagram changes. Sign out and discard them?");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/auth/logout"))).toBe(false);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("keeps the workspace and its unsaved edits behind a sign-in overlay when the session expires", async () => {
    const base = mockWorkspaceFetch();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === "/diagrams/d1/graph" && method === "PUT") return jsonResponse({ detail: "Not authenticated" }, 401);
      if (path === "/auth/login" && method === "POST") return jsonResponse(TEST_USER);
      return base(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);

    await openDirtyDiagram();
    fireEvent.click(screen.getByRole("button", { name: "Save graph" }));

    const overlay = await screen.findByRole("dialog", { name: "Session expired" });
    expect(overlay).toHaveTextContent("Your session has expired.");
    // The workspace stays mounted (inert) underneath, with the edit still pending.
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Diagrams" })).toBeInTheDocument();

    fireEvent.change(within(overlay).getByLabelText("Email"), { target: { value: TEST_USER.email } });
    fireEvent.change(within(overlay).getByLabelText("Password"), { target: { value: "secret-password" } });
    fireEvent.click(within(overlay).getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Session expired" })).not.toBeInTheDocument());
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save graph" })).not.toBeDisabled();
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

  it("asks before leaving the Diagrams page with unsaved edits, and handles legacy shortcuts only there", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.stubGlobal("fetch", mockWorkspaceFetch());
    const primaryNav = () => screen.getByRole("navigation", { name: "Primary navigation" });

    const rotor = () => document.querySelector<HTMLElement>(".pidGlyphRotor")!;

    // Rotates Valve A by 90 degrees: one undoable step.
    await openDirtyDiagram();
    expect(rotor().style.transform).toBe("rotate(90deg)");

    // The canvas unmounts with its page, so leaving with unsaved edits asks first.
    fireEvent.click(primaryNav().querySelector('a[href="/parts"]')!);
    await waitFor(() =>
      expect(confirmSpy).toHaveBeenCalledWith("You have unsaved diagram changes. Leave this page and discard them?")
    );
    expect(screen.getByRole("heading", { level: 1, name: "Diagrams" })).toBeInTheDocument();
    expect(rotor().style.transform).toBe("rotate(90deg)");

    // A handler that already consumed the key wins.
    const consume = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener("keydown", consume, { capture: true });
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    window.removeEventListener("keydown", consume, { capture: true });
    expect(rotor().style.transform).toBe("rotate(90deg)");

    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(rotor().style.transform).toBe(""));

    // Confirming leaves; the shortcuts go with the page, and coming back
    // reloads the saved diagram.
    confirmSpy.mockReturnValue(true);
    fireEvent.click(primaryNav().querySelector('a[href="/parts"]')!);
    expect(await screen.findByRole("heading", { level: 1, name: "Parts" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });

    fireEvent.click(primaryNav().querySelector('a[href="/diagrams"]')!);
    expect(await screen.findByRole("heading", { level: 1, name: "Diagrams" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Valve A")).toBeInTheDocument());
    expect(rotor().style.transform).toBe("");
    expect(await screen.findByText("Saved", { selector: ".cleanBadge" })).toBeInTheDocument();
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

  it("redirects the retired placeholder routes to the dashboard", async () => {
    window.history.pushState({}, "", "/certification");
    vi.stubGlobal("fetch", mockWorkspaceFetch());

    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/dashboard");
  });
});
