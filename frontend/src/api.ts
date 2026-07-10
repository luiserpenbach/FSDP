import type {
  BomSnapshot,
  ComponentInstance,
  Diagram,
  FluidSystem,
  Impact,
  Part,
  PartAttachment,
  PartCompare,
  PartFamily,
  PartImportResult,
  PartRevision,
  PartWhereUsed,
  Project,
  Requirement,
  RequirementAttachment,
  RequirementCompare,
  RequirementImportResult,
  RequirementRevision,
  RequirementSet,
  RequirementTraceability,
  RequirementVerificationMatrixRow,
  TraceableComponent,
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
  listPartFamilies: () => request<PartFamily[]>("/parts/families"),
  createPartFamily: (body: {
    name: string;
    part_type: string;
    description?: string;
    template_properties?: Record<string, unknown>;
  }) => request<PartFamily>("/parts/families", { method: "POST", body: JSON.stringify(body) }),
  compareParts: (leftId: string, rightId: string) =>
    request<PartCompare>(`/parts/compare?left_id=${leftId}&right_id=${rightId}`),
  bulkUpdateParts: (body: {
    part_ids: string[];
    manufacturer?: string;
    material?: string;
    qualification_status?: string;
    certification_status?: string;
    lifecycle_status?: string;
    family_id?: string;
  }) => request<Part[]>(`/parts/bulk-update`, { method: "POST", body: JSON.stringify(body) }),
  importParts: (body: { csv_text: string; column_mapping: Record<string, string>; on_duplicate: string }) =>
    request<PartImportResult>("/parts/import", { method: "POST", body: JSON.stringify(body) }),
  listPartRevisions: (partId: string) => request<PartRevision[]>(`/parts/${partId}/revisions`),
  getPartWhereUsed: (partId: string) => request<PartWhereUsed>(`/parts/${partId}/where-used`),
  listPartAttachments: (partId: string) => request<PartAttachment[]>(`/parts/${partId}/attachments`),
  createPartAttachment: (
    partId: string,
    body: {
      filename: string;
      attachment_type: string;
      mime_type?: string;
      size_bytes?: number;
      content_base64?: string;
    }
  ) =>
    request<PartAttachment>(`/parts/${partId}/attachments`, { method: "POST", body: JSON.stringify(body) }),
  deletePartAttachment: (attachmentId: string) =>
    requestNoContent(`/part-attachments/${attachmentId}`, { method: "DELETE" }),
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
  getRequirementCoverage: (projectId: string) =>
    request<
      Record<
        string,
        {
          link_count: number;
          linked: boolean;
          evidence_count: number;
          verification_display: string;
        }
      >
    >(`/projects/${projectId}/requirements/coverage`),
  listTraceableComponents: (projectId: string) =>
    request<TraceableComponent[]>(`/projects/${projectId}/traceable-components`),
  getRequirementTraceability: (requirementId: string) =>
    request<RequirementTraceability>(`/requirements/${requirementId}/traceability`),
  createTraceLink: (body: Omit<TraceLink, "id">) =>
    request<TraceLink>("/trace-links", { method: "POST", body: JSON.stringify(body) }),
  deleteTraceLink: (linkId: string) => requestNoContent(`/trace-links/${linkId}`, { method: "DELETE" }),
  compareRequirements: (leftId: string, rightId: string) =>
    request<RequirementCompare>(`/requirements/compare?left_id=${leftId}&right_id=${rightId}`),
  bulkUpdateRequirements: (body: {
    requirement_ids: string[];
    status?: string;
    owner?: string;
    verification_method?: string;
    requirement_type?: string;
    lifecycle_status?: string;
    verification_status?: string;
    set_id?: string;
  }) =>
    request<Requirement[]>(`/requirements/bulk-update`, { method: "POST", body: JSON.stringify(body) }),
  importRequirements: (body: {
    project_id: string;
    csv_text: string;
    column_mapping: Record<string, string>;
    on_duplicate: string;
  }) => request<RequirementImportResult>("/requirements/import", { method: "POST", body: JSON.stringify(body) }),
  listRequirementSets: (projectId: string) =>
    request<RequirementSet[]>(`/projects/${projectId}/requirement-sets`),
  createRequirementSet: (
    projectId: string,
    body: {
      name: string;
      requirement_type: string;
      description?: string;
      default_verification_method?: string;
      template_text?: string;
      template_properties?: Record<string, unknown>;
    }
  ) =>
    request<RequirementSet>(`/projects/${projectId}/requirement-sets`, {
      method: "POST",
      body: JSON.stringify(body)
    }),
  listRequirementRevisions: (requirementId: string) =>
    request<RequirementRevision[]>(`/requirements/${requirementId}/revisions`),
  listRequirementAttachments: (requirementId: string) =>
    request<RequirementAttachment[]>(`/requirements/${requirementId}/attachments`),
  createRequirementAttachment: (
    requirementId: string,
    body: {
      filename: string;
      attachment_type: string;
      mime_type?: string;
      size_bytes?: number;
      content_base64?: string;
    }
  ) =>
    request<RequirementAttachment>(`/requirements/${requirementId}/attachments`, {
      method: "POST",
      body: JSON.stringify(body)
    }),
  deleteRequirementAttachment: (attachmentId: string) =>
    requestNoContent(`/requirement-attachments/${attachmentId}`, { method: "DELETE" }),
  getRequirementVerificationMatrix: (projectId: string) =>
    request<RequirementVerificationMatrixRow[]>(
      `/projects/${projectId}/requirements/verification-matrix`
    ),
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
