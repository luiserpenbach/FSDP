import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  });
}

function findPaletteCell(text: string) {
  return screen.getAllByRole("button").find(
    (button) => button.classList.contains("paletteCell") && button.textContent?.includes(text)
  );
}

async function placeSymbolFromPalette(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "Symbols" }));
  const paletteButton = findPaletteCell(label);
  expect(paletteButton).toBeTruthy();
  fireEvent.click(paletteButton!);
  const pane = document.querySelector(".react-flow__pane");
  expect(pane).toBeTruthy();
  fireEvent.click(pane!, { clientX: 240, clientY: 240 });
}

describe("App", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
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
    expect(screen.getByText("Test Engineer · admin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByLabelText("Project")).toBeInTheDocument();
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
    await waitFor(() => {
      const projectSelects = screen.getAllByLabelText("Project");
      expect(projectSelects.some((el) => (el as HTMLSelectElement).value === "p1")).toBe(true);
    });

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
    await waitFor(() => {
      const projectSelects = screen.getAllByLabelText("Project");
      expect(projectSelects.some((el) => (el as HTMLSelectElement).value === "p1")).toBe(true);
    });

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
    expect(screen.getByText("V-B")).toBeInTheDocument();
    expect(screen.queryByText("V-A")).not.toBeInTheDocument();
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
    await waitFor(() => {
      const projectSelects = screen.getAllByLabelText("Project");
      expect(projectSelects.some((el) => (el as HTMLSelectElement).value === "p1")).toBe(true);
    });

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/systems/s1/diagrams"))).toBe(true);
    });

    const projectSelect = screen.getAllByLabelText("Project").find((el) => el.tagName === "SELECT") as HTMLSelectElement;
    fireEvent.change(projectSelect, { target: { value: "p2" } });

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
    await waitFor(() => {
      const projectSelects = screen.getAllByLabelText("Project");
      expect(projectSelects.some((el) => (el as HTMLSelectElement).value === "p1")).toBe(true);
    });

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

    await placeSymbolFromPalette("Valve");
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save graph" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input, init]) => {
        const url = String(input);
        return url.includes("/diagrams/d1/graph") && (init?.method ?? "GET").toUpperCase() === "PUT";
      })).toBe(true);
    });

    await placeSymbolFromPalette("Check valve");
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
});
