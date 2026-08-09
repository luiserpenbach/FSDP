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

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  });
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

    const valvePalette = screen
      .getAllByRole("button")
      .find((button) => button.classList.contains("paletteItem") && button.textContent?.includes("Valve") && !button.textContent?.includes("Check"));
    expect(valvePalette).toBeTruthy();
    fireEvent.click(valvePalette!);
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save graph" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input, init]) => {
        const url = String(input);
        return url.includes("/diagrams/d1/graph") && (init?.method ?? "GET").toUpperCase() === "PUT";
      })).toBe(true);
    });

    // Edit again while the save request is still outstanding. The save response
    // must not clear dirty — those mid-save edits were not persisted.
    const checkValvePalette = screen
      .getAllByRole("button")
      .find((button) => button.classList.contains("paletteItem") && button.textContent?.includes("Check valve"));
    expect(checkValvePalette).toBeTruthy();
    fireEvent.click(checkValvePalette!);
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
