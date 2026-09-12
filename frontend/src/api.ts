import type {
  Analysis,
  ProjectDrc,
  SheetOverlay,
  SheetVolume,
  FailureMode,
  FmeaComment,
  FmeaDiff,
  FmeaGate,
  FmeaGenerateResult,
  FmeaRelease,
  FmeaRow,
  FmeaRowPatch,
  FmeaWorksheet,
  Evidence,
  RequirementCoverage,
  RequirementImportResult,
  Hazard,
  HazardInput,
  HazardMatrix,
  RequirementHistoryEntry,
  SafetySettings,
  SheetItemRef,
  BomDiff,
  BomReadiness,
  BomSnapshot,
  ChangeEvent,
  ComponentInstance,
  CatalogDocument,
  CatalogSettings,
  Diagram,
  Drawing,
  DrawingRevision,
  DrawingSheet,
  FluidSystem,
  Impact,
  LineClass,
  ListRead,
  Part,
  SheetDrcRead,
  DrcWaiverRead,
  DrawingDrcRead,
  VerificationMatrix,
  PartUsage,
  PidSymbolDef,
  Project,
  ProjectBom,
  Requirement,
  SchematicRead,
  TagSchemeRead,
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
  getSchematic: (diagramId: string) => request<SchematicRead>(`/diagrams/${diagramId}/schematic`),
  saveSchematic: (diagramId: string, document: unknown) =>
    request<SchematicRead>(`/diagrams/${diagramId}/schematic`, {
      method: "PUT",
      body: JSON.stringify({ document })
    }),
  listDrawings: (projectId: string) => request<Drawing[]>(`/projects/${projectId}/drawings`),
  createDrawing: (
    projectId: string,
    body: {
      title: string;
      number?: string;
      system_id?: string | null;
      size?: string;
      units?: string;
      frame_template?: string;
      fields?: Record<string, unknown>;
      notes?: string[];
      first_sheet?: { title?: string | null; source_diagram_id?: string | null; document?: unknown };
      revision?: Partial<Omit<DrawingRevision, "id" | "drawing_id" | "sequence" | "status" | "created_at">>;
    }
  ) => request<Drawing>(`/projects/${projectId}/drawings`, { method: "POST", body: JSON.stringify(body) }),
  getDrawing: (drawingId: string) => request<Drawing>(`/drawings/${drawingId}`),
  updateDrawing: (drawingId: string, body: Partial<Omit<Drawing, "id" | "project_id" | "sheets" | "revisions" | "created_at" | "updated_at">>) =>
    request<Drawing>(`/drawings/${drawingId}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteDrawing: (drawingId: string) => requestNoContent(`/drawings/${drawingId}`, { method: "DELETE" }),
  createSheet: (drawingId: string, body: { title?: string | null; source_diagram_id?: string | null; document?: unknown }) =>
    request<DrawingSheet>(`/drawings/${drawingId}/sheets`, { method: "POST", body: JSON.stringify(body) }),
  getSheet: (sheetId: string) => request<DrawingSheet>(`/sheets/${sheetId}`),
  updateSheet: (sheetId: string, body: { title?: string | null; document?: unknown; index?: unknown; drc?: unknown }) =>
    request<DrawingSheet>(`/sheets/${sheetId}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteSheet: (sheetId: string) => requestNoContent(`/sheets/${sheetId}`, { method: "DELETE" }),
  createRevision: (drawingId: string, body: Partial<Omit<DrawingRevision, "id" | "drawing_id" | "sequence" | "status" | "created_at">>) =>
    request<DrawingRevision>(`/drawings/${drawingId}/revisions`, { method: "POST", body: JSON.stringify(body) }),
  updateRevision: (revisionId: string, body: Partial<Omit<DrawingRevision, "id" | "drawing_id" | "sequence" | "status" | "created_at">>) =>
    request<DrawingRevision>(`/revisions/${revisionId}`, { method: "PUT", body: JSON.stringify(body) }),
  /** Convert a rendered sheet SVG on the server; resolves to the file blob and its filename. */
  exportSheet: async (sheetId: string, body: { svg: string; format: "pdf" | "png" | "svg"; dpi?: number; pages?: string[] }) => {
    const response = await rawRequest(`/sheets/${sheetId}/export`, { method: "POST", body: JSON.stringify(body) });
    const disposition = response.headers.get("content-disposition") ?? "";
    const match = /filename="([^"]+)"/.exec(disposition);
    return { blob: await response.blob(), filename: match?.[1] ?? `sheet.${body.format}` };
  },
  getSheetDrc: (sheetId: string) => request<SheetDrcRead>(`/sheets/${sheetId}/drc`),
  waiveFinding: (sheetId: string, key: string, reason: string) =>
    request<DrcWaiverRead>(`/sheets/${sheetId}/drc/waivers`, { method: "PUT", body: JSON.stringify({ key, reason }) }),
  unwaiveFinding: (sheetId: string, key: string) =>
    requestNoContent(`/sheets/${sheetId}/drc/waivers/${encodeURIComponent(key)}`, { method: "DELETE" }),
  getDrawingDrc: (drawingId: string) => request<DrawingDrcRead>(`/drawings/${drawingId}/drc`),
  getVerificationMatrix: (projectId: string) => request<VerificationMatrix>(`/projects/${projectId}/verification-matrix`),
  getDrawingList: (drawingId: string, kind: string) => request<ListRead>(`/drawings/${drawingId}/lists/${kind}`),
  getProjectList: (projectId: string, kind: string) => request<ListRead>(`/projects/${projectId}/lists/${kind}`),
  downloadList: async (scope: "drawing" | "project", id: string, kind: string, format: "csv" | "xlsx") => {
    const base = scope === "drawing" ? `/drawings/${id}` : `/projects/${id}`;
    const response = await rawRequest(`${base}/lists/${kind}?format=${format}`);
    const match = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "");
    return { blob: await response.blob(), filename: match?.[1] ?? `${kind}-list.${format}` };
  },
  generateDrawingBom: (drawingId: string) => request<BomSnapshot>(`/drawings/${drawingId}/bom`, { method: "POST" }),
  listDrawingBoms: (drawingId: string) => request<BomSnapshot[]>(`/drawings/${drawingId}/bom`),
  listLineClasses: (projectId: string) => request<LineClass[]>(`/projects/${projectId}/line-classes`),
  createLineClass: (projectId: string, body: Partial<Omit<LineClass, "id" | "project_id" | "created_at" | "updated_at">> & { name: string }) =>
    request<LineClass>(`/projects/${projectId}/line-classes`, { method: "POST", body: JSON.stringify(body) }),
  updateLineClass: (lineClassId: string, body: Partial<Omit<LineClass, "id" | "project_id" | "created_at" | "updated_at">>) =>
    request<LineClass>(`/line-classes/${lineClassId}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteLineClass: (lineClassId: string) => requestNoContent(`/line-classes/${lineClassId}`, { method: "DELETE" }),
  importLineClasses: (projectId: string, csv: string, replace = false) =>
    request<{ created: number; updated: number; errors: string[] }>(`/projects/${projectId}/line-classes/import`, {
      method: "POST",
      body: JSON.stringify({ csv, replace })
    }),
  getTagScheme: (projectId: string) => request<TagSchemeRead>(`/projects/${projectId}/tag-scheme`),
  updateTagScheme: (projectId: string, scheme: unknown) =>
    request<TagSchemeRead>(`/projects/${projectId}/tag-scheme`, { method: "PUT", body: JSON.stringify({ scheme }) }),
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
  listRequirements: (projectId: string, params?: { category?: string; verification_status?: string; safety_critical?: boolean; parent_id?: string; q?: string }) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== "" && value !== null) query.set(key, String(value));
    }
    const suffix = query.toString();
    return request<Requirement[]>(`/projects/${projectId}/requirements${suffix ? `?${suffix}` : ""}`);
  },
  getRequirement: (requirementId: string) => request<Requirement>(`/requirements/${requirementId}`),
  getRequirementHistory: (requirementId: string) => request<RequirementHistoryEntry[]>(`/requirements/${requirementId}/history`),
  listEvidence: (requirementId: string) => request<Evidence[]>(`/requirements/${requirementId}/evidence`),
  addEvidence: (requirementId: string, body: { kind: string; status: string; ref_type?: string | null; ref_id?: string | null; note?: string | null }) =>
    request<Evidence>(`/requirements/${requirementId}/evidence`, { method: "POST", body: JSON.stringify(body) }),
  updateEvidence: (evidenceId: string, body: { status?: string; note?: string | null; ref_type?: string | null; ref_id?: string | null }) =>
    request<Evidence>(`/evidence/${evidenceId}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteEvidence: (evidenceId: string) => requestNoContent(`/evidence/${evidenceId}`, { method: "DELETE" }),
  importRequirements: async (projectId: string, file: File, options: { mapping?: Record<string, string>; dryRun?: boolean; updateExisting?: boolean } = {}) => {
    const form = new FormData();
    form.append("file", file);
    if (options.mapping) form.append("mapping", JSON.stringify(options.mapping));
    form.append("dry_run", options.dryRun ? "true" : "false");
    form.append("update_existing", options.updateExisting ? "true" : "false");
    const response = await fetch(`${API_BASE_URL}/projects/${projectId}/requirements/import`, { credentials: "include", method: "POST", body: form });
    if (!response.ok) {
      if (response.status === 401) unauthorizedHandler?.();
      throw await toApiError(response);
    }
    return response.json() as Promise<RequirementImportResult>;
  },
  downloadRequirements: async (projectId: string, format: "csv" | "xlsx") => {
    const response = await rawRequest(`/projects/${projectId}/requirements/export?format=${format}`);
    const match = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "");
    return { blob: await response.blob(), filename: match?.[1] ?? `requirements.${format}` };
  },
  downloadVerificationMatrix: async (projectId: string, format: "csv" | "xlsx") => {
    const response = await rawRequest(`/projects/${projectId}/verification-matrix?format=${format}`);
    const match = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "");
    return { blob: await response.blob(), filename: match?.[1] ?? `verification-matrix.${format}` };
  },
  getRequirementCoverage: (projectId: string) => request<RequirementCoverage>(`/projects/${projectId}/requirements/coverage`),
  getSafetySettings: (projectId: string) => request<{ project_id: string; settings: SafetySettings }>(`/projects/${projectId}/safety-settings`),
  updateSafetySettings: (projectId: string, settings: SafetySettings) =>
    request<{ project_id: string; settings: SafetySettings }>(`/projects/${projectId}/safety-settings`, { method: "PUT", body: JSON.stringify({ settings }) }),
  listHazards: (projectId: string, params?: { category?: string; status?: string; computed_status?: string; system_id?: string; severity?: string; mode?: string }) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value) query.set(key, value);
    }
    const suffix = query.toString();
    return request<Hazard[]>(`/projects/${projectId}/hazards${suffix ? `?${suffix}` : ""}`);
  },
  getHazardMatrix: (projectId: string) => request<HazardMatrix>(`/projects/${projectId}/hazards/matrix`),
  createHazard: (projectId: string, body: HazardInput & { title: string }) =>
    request<Hazard>(`/projects/${projectId}/hazards`, { method: "POST", body: JSON.stringify(body) }),
  getHazard: (hazardId: string) => request<Hazard>(`/hazards/${hazardId}`),
  updateHazard: (hazardId: string, body: HazardInput) =>
    request<Hazard>(`/hazards/${hazardId}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteHazard: (hazardId: string) => requestNoContent(`/hazards/${hazardId}`, { method: "DELETE" }),
  addHazardControl: (hazardId: string, body: { type: "requirement" | "sheet_item"; id: string }) =>
    request<Hazard>(`/hazards/${hazardId}/controls`, { method: "POST", body: JSON.stringify(body) }),
  removeHazardControl: (hazardId: string, linkId: string) =>
    request<Hazard>(`/hazards/${hazardId}/controls/${linkId}`, { method: "DELETE" }),
  deriveRequirement: (hazardId: string, body: { key: string; title: string; text: string; verification_method?: string | null; category?: string }) =>
    request<Requirement>(`/hazards/${hazardId}/derive-requirement`, { method: "POST", body: JSON.stringify(body) }),
  acceptHazard: (hazardId: string, justification: string) =>
    request<Hazard>(`/hazards/${hazardId}/accept`, { method: "POST", body: JSON.stringify({ justification }) }),
  listFailureModes: () => request<FailureMode[]>("/failure-modes"),
  createFailureMode: (body: Omit<FailureMode, "id">) => request<FailureMode>("/failure-modes", { method: "POST", body: JSON.stringify(body) }),
  updateFailureMode: (modeId: string, body: Partial<Omit<FailureMode, "id" | "category" | "symbol_key" | "name">>) =>
    request<FailureMode>(`/failure-modes/${modeId}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteFailureMode: (modeId: string) => requestNoContent(`/failure-modes/${modeId}`, { method: "DELETE" }),
  listWorksheets: (projectId: string) => request<FmeaWorksheet[]>(`/projects/${projectId}/fmea`),
  createWorksheet: (projectId: string, body: { title: string; drawing_id?: string | null; system_id?: string | null; method?: string; operating_modes?: string[] | null }) =>
    request<FmeaWorksheet>(`/projects/${projectId}/fmea`, { method: "POST", body: JSON.stringify(body) }),
  getWorksheet: (worksheetId: string) => request<FmeaWorksheet>(`/fmea/${worksheetId}`),
  updateWorksheet: (worksheetId: string, body: Partial<Pick<FmeaWorksheet, "title" | "drawing_id" | "system_id" | "method" | "operating_modes" | "status">>) =>
    request<FmeaWorksheet>(`/fmea/${worksheetId}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteWorksheet: (worksheetId: string) => requestNoContent(`/fmea/${worksheetId}`, { method: "DELETE" }),
  generateWorksheet: (worksheetId: string, body: { drawing_id?: string | null; sheet_ids?: string[] | null; categories?: string[] | null; operating_modes?: string[] | null }) =>
    request<FmeaGenerateResult>(`/fmea/${worksheetId}/generate`, { method: "POST", body: JSON.stringify(body) }),
  listWorksheetRows: (worksheetId: string) => request<FmeaRow[]>(`/fmea/${worksheetId}/rows`),
  createWorksheetRow: (worksheetId: string, body: FmeaRowPatch) => request<FmeaRow>(`/fmea/${worksheetId}/rows`, { method: "POST", body: JSON.stringify(body) }),
  updateWorksheetRow: (rowId: string, body: FmeaRowPatch) => request<FmeaRow>(`/fmea/rows/${rowId}`, { method: "PUT", body: JSON.stringify(body) }),
  bulkUpdateRows: (worksheetId: string, rows: Array<FmeaRowPatch & { id: string }>) =>
    request<FmeaRow[]>(`/fmea/${worksheetId}/rows/bulk`, { method: "POST", body: JSON.stringify({ rows }) }),
  deleteWorksheetRow: (rowId: string) => requestNoContent(`/fmea/rows/${rowId}`, { method: "DELETE" }),
  confirmRow: (rowId: string) => request<FmeaRow>(`/fmea/rows/${rowId}/confirm`, { method: "POST" }),
  confirmAllRows: (worksheetId: string) => request<FmeaWorksheet>(`/fmea/${worksheetId}/confirm-all`, { method: "POST" }),
  addRowControl: (rowId: string, body: { type: "requirement" | "sheet_item"; id: string }) =>
    request<FmeaRow>(`/fmea/rows/${rowId}/controls`, { method: "POST", body: JSON.stringify(body) }),
  removeRowControl: (rowId: string, linkId: string) => request<FmeaRow>(`/fmea/rows/${rowId}/controls/${linkId}`, { method: "DELETE" }),
  getWorksheetGate: (worksheetId: string) => request<FmeaGate>(`/fmea/${worksheetId}/gate`),
  releaseWorksheet: (worksheetId: string, note?: string) => request<FmeaRelease>(`/fmea/${worksheetId}/release`, { method: "POST", body: JSON.stringify({ note: note ?? null }) }),
  listWorksheetReleases: (worksheetId: string) => request<FmeaRelease[]>(`/fmea/${worksheetId}/releases`),
  getWorksheetDiff: (worksheetId: string, against?: number) => request<FmeaDiff>(`/fmea/${worksheetId}/diff${against ? `?against=${against}` : ""}`),
  downloadWorksheet: async (worksheetId: string, format: "xlsx" | "csv" | "pdf") => {
    const response = await rawRequest(`/fmea/${worksheetId}/export?format=${format}`);
    const match = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "");
    return { blob: await response.blob(), filename: match?.[1] ?? `fmea.${format}` };
  },
  listRowComments: (rowId: string) => request<FmeaComment[]>(`/fmea/rows/${rowId}/comments`),
  addRowComment: (rowId: string, body: string) => request<FmeaComment>(`/fmea/rows/${rowId}/comments`, { method: "POST", body: JSON.stringify({ body }) }),
  updateRowComment: (commentId: string, body: { resolved?: boolean; body?: string }) =>
    request<FmeaComment>(`/fmea/comments/${commentId}`, { method: "PUT", body: JSON.stringify(body) }),
  listSheetVolumes: (sheetId: string) => request<SheetVolume[]>(`/sheets/${sheetId}/volumes`),
  listDrawingVolumes: (drawingId: string) => request<SheetVolume[]>(`/drawings/${drawingId}/volumes`),
  listProjectVolumes: (projectId: string) => request<SheetVolume[]>(`/projects/${projectId}/volumes`),
  getSheetOverlay: (sheetId: string) => request<SheetOverlay>(`/sheets/${sheetId}/safety-overlay`),
  getProjectDrc: (projectId: string) => request<ProjectDrc>(`/projects/${projectId}/drc`),
  listAnalyses: (projectId: string) => request<Analysis[]>(`/projects/${projectId}/analyses`),
  createAnalysis: (projectId: string, body: { kind: string; title?: string | null; sheet_id?: string | null; scope?: Record<string, unknown> | null; assumptions?: Record<string, unknown> | null }) =>
    request<Analysis>(`/projects/${projectId}/analyses`, { method: "POST", body: JSON.stringify(body) }),
  getAnalysis: (analysisId: string) => request<Analysis>(`/analyses/${analysisId}`),
  updateAnalysis: (analysisId: string, body: { title?: string; scope?: Record<string, unknown> | null; assumptions?: Record<string, unknown> | null; result?: Record<string, unknown> | null; verdict?: string | null }) =>
    request<Analysis>(`/analyses/${analysisId}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteAnalysis: (analysisId: string) => requestNoContent(`/analyses/${analysisId}`, { method: "DELETE" }),
  runAnalysis: (analysisId: string) => request<Analysis>(`/analyses/${analysisId}/run`, { method: "POST" }),
  attachAnalysisEvidence: (analysisId: string, requirementId: string) =>
    request<Analysis>(`/analyses/${analysisId}/attach-evidence`, { method: "POST", body: JSON.stringify({ requirement_id: requirementId }) }),
  listSheetItems: (projectId: string, params?: { q?: string; category?: string; limit?: number }) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const suffix = query.toString();
    return request<SheetItemRef[]>(`/projects/${projectId}/sheet-items${suffix ? `?${suffix}` : ""}`);
  },
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
