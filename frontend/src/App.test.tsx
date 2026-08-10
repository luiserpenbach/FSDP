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
  name: "Helium P&ID",
  diagram_type: "pid",
  revision: 1,
  graph: {
    nodes: [
      {
        id: "valve-1",
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

function mockWorkspaceFetch(overrides?: {
  onCreateProject?: () => void;
  onCreateSystem?: () => void;
}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url, "http://localhost").pathname;

    if (path === "/auth/me") return jsonResponse(TEST_USER);
    if (path === "/projects" && method === "GET") return jsonResponse([PROJECT]);
    if (path === "/projects" && method === "POST") {
      overrides?.onCreateProject?.();
      return jsonResponse({ ...PROJECT, id: "p2", name: "New Project" }, 201);
    }
    if (path === "/projects/p1/systems" && method === "GET") return jsonResponse([SYSTEM]);
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

async function openDirtyDiagram() {
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

  const checkValvePalette = screen
    .getAllByRole("button")
    .find(
      (button) =>
        button.classList.contains("paletteItem") && button.textContent?.includes("Check valve")
    );
  expect(checkValvePalette).toBeTruthy();
  fireEvent.click(checkValvePalette!);
  expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();
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

  it("asks before create project discards unsaved diagram edits", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    let createdProject = false;
    vi.stubGlobal("fetch", mockWorkspaceFetch({ onCreateProject: () => {
      createdProject = true;
    } }));

    await openDirtyDiagram();

    fireEvent.click(
      screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/systems"]')!
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Systems" })).toBeInTheDocument();

    const nameInputs = screen.getAllByLabelText("Name");
    fireEvent.change(nameInputs[0]!, { target: { value: "New Project" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(confirmSpy).toHaveBeenCalledWith("You have unsaved diagram changes. Discard them?");
    expect(createdProject).toBe(false);
    confirmSpy.mockRestore();
  });

  it("asks before create system discards unsaved diagram edits", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    let createdSystem = false;
    vi.stubGlobal("fetch", mockWorkspaceFetch({ onCreateSystem: () => {
      createdSystem = true;
    } }));

    await openDirtyDiagram();

    fireEvent.click(
      screen.getByRole("navigation", { name: "Primary navigation" }).querySelector('a[href="/systems"]')!
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Systems" })).toBeInTheDocument();

    const nameInputs = screen.getAllByLabelText("Name");
    fireEvent.change(nameInputs[1]!, { target: { value: "New System" } });
    fireEvent.click(screen.getByRole("button", { name: "Create system" }));

    expect(confirmSpy).toHaveBeenCalledWith("You have unsaved diagram changes. Discard them?");
    expect(createdSystem).toBe(false);
    confirmSpy.mockRestore();
  });
});
