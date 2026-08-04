import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/auth/me")) return jsonResponse(TEST_USER);
      if (url.endsWith("/projects") && method === "GET") return jsonResponse([PROJECT]);
      if (url.includes("/projects/p1/systems")) return jsonResponse([SYSTEM]);
      if (url.includes("/projects/p1/requirements")) return jsonResponse([]);
      if (url.includes("/projects/p1/bom")) return jsonResponse([]);
      if (url.includes("/parts") && method === "GET") return jsonResponse([]);
      if (url.includes("/changes")) return jsonResponse([]);
      if (url.includes("/systems/s1/diagrams") && method === "GET") return jsonResponse(diagrams);
      if (url.includes("/diagrams/d1/components")) return jsonResponse([]);
      if (url.includes("/diagrams/d1/bom")) return jsonResponse([]);
      if (url.includes("/diagrams/d2/components")) return jsonResponse([]);
      if (url.includes("/diagrams/d2/bom")) return jsonResponse([]);
      if (url.endsWith("/diagrams/d1") && method === "GET") return jsonResponse(EXISTING_DIAGRAM);
      if (url.endsWith("/diagrams/d2") && method === "GET") return jsonResponse(NEW_DIAGRAM);
      if (url.includes("/systems/s1/diagrams") && method === "POST") {
        diagrams = [EXISTING_DIAGRAM, NEW_DIAGRAM];
        return jsonResponse(NEW_DIAGRAM, 201);
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    window.history.pushState({}, "", "/diagrams");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Diagrams" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Open diagram")).toHaveValue("d1"));

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

    const graphWrites = fetchMock.mock.calls.filter(([url, init]) => {
      const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
      return typeof url === "string" && url.includes("/graph") && method === "PUT";
    });
    expect(graphWrites).toHaveLength(0);

    await waitFor(() => expect(screen.getByLabelText("Open diagram")).toHaveValue("d2"));
  });
});
