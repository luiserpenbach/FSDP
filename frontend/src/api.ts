import type {
  BomDiff,
  BomReadiness,
  BomSnapshot,
  ChangeEvent,
  ComponentInstance,
  CatalogDocument,
  CatalogSettings,
  Diagram,
  FluidSystem,
  Impact,
  Part,
  PartUsage,
  PidSymbolDef,
  Project,
  ProjectBom,
  Requirement,
  TraceLink,
  User
} from "./types";

// Production builds default to same-origin "/api" (served behind nginx or a
// Vercel rewrite); dev talks to the local backend directly. Override with
// VITE_API_BASE_URL at build time when needed.
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.PROD ? "/api" : "http://localhost:8000");

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

async function toApiError(response: Response): Promise<Error> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    if (typeof parsed.detail === "string") return new Error(parsed.detail);
    if (Array.isArray(parsed.detail)) {
      const messages = parsed.detail.map((item) => {
        const entry = item as { loc?: unknown[]; msg?: string };
        const field = Array.isArray(entry.loc) ? String(entry.loc[entry.loc.length - 1]) : "";
        return field && entry.msg ? `${field}: ${entry.msg}` : entry.msg ?? String(item);
      });
      return new Error(messages.join("; "));
    }
  } catch {
    // Fall through to the raw text.
  }
  return new Error(text || `Request failed (${response.status})`);
}

async function rawRequest(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
  });
  if (!response.ok) {
    if (response.status === 401) unauthorizedHandler?.();
    throw await toApiError(response);
  }
  return response;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await rawRequest(path, init);
  return response.json() as Promise<T>;
}

async function requestNoContent(path: string, init?: RequestInit): Promise<void> {
  await rawRequest(path, init);
}

export const api = {
  login: (email: string, password: string) =>
    request<User>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => requestNoContent("/auth/logout", { method: "POST" }),
  me: () => request<User>("/auth/me"),
  listChanges: (limit = 50) => request<ChangeEvent[]>(`/changes?limit=${limit}`),
  listProjects: () => request<Project[]>("/projects"),
  createProject: (body: { name: string; description?: string; owner?: string }) =>
    request<Project>("/projects", { method: "POST", body: JSON.stringify(body) }),
  updateProject: (
    projectId: string,
    body: { name?: string; description?: string; owner?: string; part_name_prefix?: string }
  ) =>
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
  listSymbols: () => request<PidSymbolDef[]>("/symbols"),
  createSymbol: (body: Omit<PidSymbolDef, "id" | "created_at" | "updated_at">) =>
    request<PidSymbolDef>("/symbols", { method: "POST", body: JSON.stringify(body) }),
  updateSymbol: (symbolId: string, body: Partial<Omit<PidSymbolDef, "id">>) =>
    request<PidSymbolDef>(`/symbols/${symbolId}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteSymbol: (symbolId: string) => requestNoContent(`/symbols/${symbolId}`, { method: "DELETE" }),
  listParts: (params?: {
    q?: string;
    part_type?: string;
    lifecycle_status?: string;
    qualification_status?: string;
  }) => {
    const query = new URLSearchParams();
    if (params?.q) query.set("q", params.q);
    if (params?.part_type) query.set("part_type", params.part_type);
    if (params?.lifecycle_status) query.set("lifecycle_status", params.lifecycle_status);
    if (params?.qualification_status) query.set("qualification_status", params.qualification_status);
    const suffix = query.size ? `?${query.toString()}` : "";
    return request<Part[]>(`/parts${suffix}`);
  },
  createPart: (body: Partial<Part> & { part_number: string; description: string; part_type: string }) =>
    request<Part>("/parts", { method: "POST", body: JSON.stringify(body) }),
  updatePart: (partId: string, body: Partial<Part>) =>
    request<Part>(`/parts/${partId}`, { method: "PUT", body: JSON.stringify(body) }),
  deletePart: (partId: string) => requestNoContent(`/parts/${partId}`, { method: "DELETE" }),
  obsoletePart: (partId: string) =>
    request<Part>(`/parts/${partId}/obsolete`, { method: "POST" }),
  getPartUsage: (partId: string) => request<PartUsage>(`/parts/${partId}/usage`),
  getCatalogSettings: () => request<CatalogSettings>("/catalog/settings"),
  updateCatalogSettings: (body: Partial<CatalogSettings>) =>
    request<CatalogSettings>("/catalog/settings", { method: "PUT", body: JSON.stringify(body) }),
  generatePartName: (projectId?: string) => {
    const suffix = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
    return request<{ part_number: string }>(`/catalog/generate-name${suffix}`, { method: "POST" });
  },
  listPartDocuments: (partId: string) => request<CatalogDocument[]>(`/parts/${partId}/documents`),
  uploadPartDocument: async (partId: string, file: File, title: string, kind: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("title", title);
    form.append("kind", kind);
    const response = await fetch(`${API_BASE_URL}/parts/${partId}/documents`, {
      credentials: "include",
      method: "POST",
      body: form
    });
    if (!response.ok) {
      if (response.status === 401) unauthorizedHandler?.();
      throw await toApiError(response);
    }
    return response.json() as Promise<CatalogDocument>;
  },
  downloadPartDocument: async (partId: string, documentId: string, filename: string) => {
    const response = await fetch(`${API_BASE_URL}/parts/${partId}/documents/${documentId}/file`, {
      credentials: "include"
    });
    if (!response.ok) {
      if (response.status === 401) unauthorizedHandler?.();
      throw await toApiError(response);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  },
  deletePartDocument: (partId: string, documentId: string) =>
    requestNoContent(`/parts/${partId}/documents/${documentId}`, { method: "DELETE" }),
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
  deleteTraceLink: (linkId: string) =>
    requestNoContent(`/trace-links/${linkId}`, { method: "DELETE" }),
  listTraceLinks: (objectType: string, objectId: string) =>
    request<TraceLink[]>(`/objects/${objectType}/${objectId}/trace`),
  generateBom: (diagramId: string) =>
    request<BomSnapshot>(`/diagrams/${diagramId}/bom`, { method: "POST" }),
  listDiagramBoms: (diagramId: string) => request<BomSnapshot[]>(`/diagrams/${diagramId}/bom`),
  listProjectBoms: (projectId: string) => request<ProjectBom[]>(`/projects/${projectId}/bom`),
  setBomStatus: (snapshotId: string, status: string) =>
    request<BomSnapshot>(`/bom/${snapshotId}/status`, {
      method: "PUT",
      body: JSON.stringify({ status })
    }),
  getBomReadiness: (snapshotId: string) => request<BomReadiness>(`/bom/${snapshotId}/readiness`),
  getBomDiff: (snapshotId: string, againstId: string) =>
    request<BomDiff>(`/bom/${snapshotId}/diff?against_id=${againstId}`),
  listUsers: () => request<User[]>("/auth/users"),
  createUser: (body: { email: string; name: string; password: string; role: string }) =>
    request<User>("/auth/users", { method: "POST", body: JSON.stringify(body) }),
  updateUser: (
    userId: string,
    body: { name?: string; password?: string; role?: string; is_active?: boolean }
  ) => request<User>(`/auth/users/${userId}`, { method: "PUT", body: JSON.stringify(body) }),
  getImpact: (objectType: string, objectId: string) =>
    request<Impact>(`/changes/impact?object_type=${objectType}&object_id=${objectId}`)
};

export function bomCsvUrl(snapshotId: string): string {
  return `${API_BASE_URL}/bom/${snapshotId}/csv`;
}
