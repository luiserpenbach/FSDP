import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type ReactNode } from "vitest";
import type { User } from "../types";
import { useWorkspace, WorkspaceProvider } from "./WorkspaceContext";

const apiMock = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listParts: vi.fn(),
  listSymbols: vi.fn(),
  listSystems: vi.fn(),
  listRequirements: vi.fn()
}));

vi.mock("../api", () => ({ api: apiMock }));

const user: User = { id: "u1", email: "eng@fsdp.test", name: "Engineer", role: "engineer", is_active: true } as User;

function wrapper({ children }: { children: ReactNode }) {
  return <WorkspaceProvider user={user}>{children}</WorkspaceProvider>;
}

describe("WorkspaceProvider project switch", () => {
  beforeEach(() => {
    Object.values(apiMock).forEach((fn) => fn.mockReset());
    localStorage.clear();
    apiMock.listProjects.mockResolvedValue([
      { id: "p1", name: "Alpha", description: "", part_name_prefix: null },
      { id: "p2", name: "Beta", description: "", part_name_prefix: null }
    ]);
    apiMock.listParts.mockResolvedValue([]);
    apiMock.listSymbols.mockResolvedValue([]);
    apiMock.listSystems.mockImplementation(async (projectId: string) =>
      projectId === "p1"
        ? [{ id: "s1", project_id: "p1", name: "Helium", fluid: "GHe", description: "" }]
        : [{ id: "s2", project_id: "p2", name: "Lox", fluid: "LOX", description: "" }]
    );
    apiMock.listRequirements.mockImplementation(async (projectId: string) =>
      projectId === "p1"
        ? [{ id: "r1", project_id: "p1", key: "REQ-A", title: "Alpha rule", status: "active", constraint: { kind: "line_class_in", values: ["Steam-A"] } }]
        : [{ id: "r2", project_id: "p2", key: "REQ-B", title: "Beta rule", status: "active", constraint: { kind: "line_class_in", values: ["Coolant-B"] } }]
    );
  });

  it("clears systems and requirements immediately on project switch and marks details not ready until the load finishes", async () => {
    let resolveP2Reqs!: (value: unknown) => void;
    apiMock.listRequirements.mockImplementation((projectId: string) => {
      if (projectId === "p1") {
        return Promise.resolve([{ id: "r1", project_id: "p1", key: "REQ-A", title: "Alpha rule", status: "active", constraint: null }]);
      }
      return new Promise((resolve) => {
        resolveP2Reqs = resolve;
      });
    });
    apiMock.listSystems.mockImplementation((projectId: string) => {
      if (projectId === "p1") return Promise.resolve([{ id: "s1", project_id: "p1", name: "Helium", fluid: "GHe", description: "" }]);
      return Promise.resolve([{ id: "s2", project_id: "p2", name: "Lox", fluid: "LOX", description: "" }]);
    });

    const { result } = renderHook(() => useWorkspace(), { wrapper });
    await waitFor(() => expect(result.current.selectedProjectId).toBe("p1"));
    await waitFor(() => expect(result.current.projectDetailsReady).toBe(true));
    expect(result.current.requirements.map((entry) => entry.key)).toEqual(["REQ-A"]);

    act(() => {
      result.current.selectProject("p2", { confirmed: true });
    });
    expect(result.current.selectedProjectId).toBe("p2");
    expect(result.current.projectDetailsReady).toBe(false);
    expect(result.current.requirements).toEqual([]);
    expect(result.current.systems).toEqual([]);

    resolveP2Reqs([{ id: "r2", project_id: "p2", key: "REQ-B", title: "Beta rule", status: "active", constraint: null }]);
    await waitFor(() => expect(result.current.projectDetailsReady).toBe(true));
    expect(result.current.requirements.map((entry) => entry.key)).toEqual(["REQ-B"]);
    expect(result.current.systems.map((entry) => entry.id)).toEqual(["s2"]);
  });
});
