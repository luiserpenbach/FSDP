import type {
  BomSnapshot,
  ComponentInstance,
  Diagram,
  FluidSystem,
  Impact,
  Part,
  Project,
  Requirement,
  TraceLink
} from "./types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

async function requestNoContent(path: string, init?: RequestInit): Promise<void> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

export const api = {
  listProjects: () => request<Project[]>("/projects"),
  createProject: (body: { name: string; description?: string; owner?: string }) =>
    request<Project>("/projects", { method: "POST", body: JSON.stringify(body) }),
  updateProject: (projectId: string, body: { name?: string; description?: string; owner?: string }) =>
    request<Project>(`/projects/${projectId}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteProject: (projectId: string) =>
    requestNoContent(`/projects/${projectId}`, { method: "DELETE" }),
  listSystems: (projectId: string) => request<FluidSystem[]>(`/projects/${projectId}/systems`),
  createSystem: (projectId: string, body: { name: string; fluid?: string; description?: string }) =>
    request<FluidSystem>(`/projects/${projectId}/systems`, {
      method: "POST",
      body: JSON.stringify(body)
    }),
  updateSystem: (
    systemId: string,
    body: { name?: string; fluid?: string; description?: string }
  ) => request<FluidSystem>(`/systems/${systemId}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteSystem: (systemId: string) =>
    requestNoContent(`/systems/${systemId}`, { method: "DELETE" }),
  listDiagrams: (systemId: string) => request<Diagram[]>(`/systems/${systemId}/diagrams`),
  createDiagram: (systemId: string, body: { name: string; diagram_type?: string }) =>
    request<Diagram>(`/systems/${systemId}/diagrams`, { method: "POST", body: JSON.stringify(body) }),
  getDiagram: (diagramId: string) => request<Diagram>(`/diagrams/${diagramId}`),
  updateDiagram: (diagramId: string, body: { name?: string; diagram_type?: string }) =>
    request<Diagram>(`/diagrams/${diagramId}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteDiagram: (diagramId: string) =>
    requestNoContent(`/diagrams/${diagramId}`, { method: "DELETE" }),
  updateDiagramGraph: (diagramId: string, body: unknown) =>
    request<Diagram>(`/diagrams/${diagramId}/graph`, { method: "PUT", body: JSON.stringify(body) }),
  listParts: () => request<Part[]>("/parts"),
  createPart: (body: Partial<Part> & { part_number: string; description: string; part_type: string }) =>
    request<Part>("/parts", { method: "POST", body: JSON.stringify(body) }),
  updatePart: (partId: string, body: Partial<Part>) =>
    request<Part>(`/parts/${partId}`, { method: "PUT", body: JSON.stringify(body) }),
  deletePart: (partId: string) => requestNoContent(`/parts/${partId}`, { method: "DELETE" }),
  listComponents: (diagramId: string) =>
    request<ComponentInstance[]>(`/diagrams/${diagramId}/components`),
  createComponent: (
    diagramId: string,
    body: {
      tag: string;
      part_id?: string;
      node_id?: string;
      quantity?: number;
      properties?: Record<string, unknown>;
    }
  ) =>
    request<ComponentInstance>(`/diagrams/${diagramId}/components`, {
      method: "POST",
      body: JSON.stringify(body)
    }),
  updateComponent: (componentId: string, body: Partial<ComponentInstance>) =>
    request<ComponentInstance>(`/components/${componentId}`, {
      method: "PUT",
      body: JSON.stringify(body)
    }),
  deleteComponent: (componentId: string) =>
    requestNoContent(`/components/${componentId}`, { method: "DELETE" }),
  listRequirements: (projectId: string) => request<Requirement[]>(`/projects/${projectId}/requirements`),
  createRequirement: (body: Omit<Requirement, "id">) =>
    request<Requirement>("/requirements", { method: "POST", body: JSON.stringify(body) }),
  updateRequirement: (requirementId: string, body: Partial<Requirement>) =>
    request<Requirement>(`/requirements/${requirementId}`, {
      method: "PUT",
      body: JSON.stringify(body)
    }),
  deleteRequirement: (requirementId: string) =>
    requestNoContent(`/requirements/${requirementId}`, { method: "DELETE" }),
  createTraceLink: (body: Omit<TraceLink, "id">) =>
    request<TraceLink>("/trace-links", { method: "POST", body: JSON.stringify(body) }),
  generateBom: (diagramId: string) =>
    request<BomSnapshot>(`/diagrams/${diagramId}/bom`, { method: "POST" }),
  listDiagramBoms: (diagramId: string) => request<BomSnapshot[]>(`/diagrams/${diagramId}/bom`),
  listProjectBoms: (projectId: string) => request<BomSnapshot[]>(`/projects/${projectId}/bom`),
  getImpact: (objectType: string, objectId: string) =>
    request<Impact>(`/changes/impact?object_type=${objectType}&object_id=${objectId}`)
};

export function bomCsvUrl(snapshotId: string): string {
  return `${API_BASE_URL}/bom/${snapshotId}/csv`;
}
