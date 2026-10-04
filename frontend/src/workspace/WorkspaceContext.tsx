/**
 * Workspace state shared by every page: the signed-in user, the project and
 * fluid system the user is working in (persisted per browser), the data most
 * pages read (projects, systems, requirements, catalog parts, custom symbols,
 * legacy diagrams), and the status line with its `runAction` helper.
 *
 * Pages own everything else. Selection changes go through `selectProject` /
 * `selectSystem`, which ask before discarding editor work registered in the
 * unsaved-changes registry for that selection.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import type { Diagram, FluidSystem, Part, PidSymbolDef, Project, Requirement, User } from "../types";
import { unsavedPrompt, useUnsavedChangesRegistry, type UnsavedScope } from "../unsavedChanges";

const PROJECT_KEY = "fsdp.selectedProject";
const SYSTEM_KEY = "fsdp.selectedSystem";

function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

type SelectOptions = {
  /** The caller already asked about unsaved work (e.g. before creating the item). */
  confirmed?: boolean;
};

export type WorkspaceContextValue = {
  user: User;
  canWrite: boolean;
  isAdmin: boolean;

  busy: boolean;
  message: string;
  error: string;
  /** Last error per form key, set by `runAction(..., formKey)`. */
  formErrors: Record<string, string>;
  /** Run an API action with the shared busy flag and status line. */
  runAction: (successMessage: string, action: () => Promise<void>, formKey?: string) => Promise<void>;
  /** Show a status message (or an error) without running an action. */
  notify: (text: string, isError?: boolean) => void;

  projects: Project[];
  /** Reload projects; the selection is left to the caller. */
  refreshProjects: () => Promise<Project[]>;
  /** Replace one project in the list after a page saved it. */
  replaceProject: (project: Project) => void;
  selectedProjectId: string;
  selectedProject: Project | null;
  /** Switch project; returns false when the user kept unsaved work instead. */
  selectProject: (projectId: string, options?: SelectOptions) => boolean;

  systems: FluidSystem[];
  /** Reload the systems of a project (ignored if the project changed meanwhile). */
  refreshSystems: (projectId: string) => Promise<FluidSystem[]>;
  selectedSystemId: string;
  selectedSystem: FluidSystem | null;
  selectSystem: (systemId: string, options?: SelectOptions) => boolean;
  /** Ask before discarding unsaved work bound to the project or system selection. */
  confirmDiscard: (selection: UnsavedScope) => boolean;

  requirements: Requirement[];
  refreshRequirements: (projectId: string) => Promise<Requirement[]>;
  selectedRequirementId: string;
  setSelectedRequirementId: (requirementId: string) => void;

  parts: Part[];
  setParts: (parts: Part[]) => void;
  selectedPartId: string;
  setSelectedPartId: (partId: string) => void;

  customSymbols: PidSymbolDef[];
  refreshSymbols: () => void;

  /** Legacy diagrams of the selected system (Diagrams page, BoM, trace links, conversion). */
  diagrams: Diagram[];
  refreshDiagrams: (systemId: string) => Promise<Diagram[]>;
  selectedDiagramId: string;
  setSelectedDiagramId: (diagramId: string) => void;
  /** Legacy component selected on the Diagrams or Requirements page (impact, trace links). */
  selectedComponentId: string;
  setSelectedComponentId: (componentId: string) => void;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside <WorkspaceProvider>.");
  return value;
}

export function WorkspaceProvider({ user, children }: { user: User; children: ReactNode }) {
  const unsaved = useUnsavedChangesRegistry();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Ready");
  const [error, setError] = useState("");
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const busyCountRef = useRef(0);

  const [projects, setProjects] = useState<Project[]>([]);
  const [systems, setSystems] = useState<FluidSystem[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [parts, setParts] = useState<Part[]>([]);
  const [customSymbols, setCustomSymbols] = useState<PidSymbolDef[]>([]);
  const [diagrams, setDiagrams] = useState<Diagram[]>([]);

  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedSystemId, setSelectedSystemId] = useState("");
  const [selectedRequirementId, setSelectedRequirementId] = useState("");
  const [selectedPartId, setSelectedPartId] = useState("");
  const [selectedDiagramId, setSelectedDiagramId] = useState("");
  const [selectedComponentId, setSelectedComponentId] = useState("");

  // Current selections for async work: a response for a previous selection
  // must not overwrite what is on screen now.
  const selectedProjectIdRef = useRef(selectedProjectId);
  const selectedSystemIdRef = useRef(selectedSystemId);
  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
    selectedSystemIdRef.current = selectedSystemId;
  }, [selectedProjectId, selectedSystemId]);
  // Invalidate in-flight project/system list responses when selection changes so a
  // slower prior request cannot rewrite systems/diagrams (and selected ids) for the
  // wrong parent — which would then wipe the open canvas via the diagram load effect.
  const projectLoadGeneration = useRef(0);
  const systemLoadGeneration = useRef(0);

  const runAction = useCallback(async (successMessage: string, action: () => Promise<void>, formKey?: string) => {
    busyCountRef.current += 1;
    setBusy(true);
    setError("");
    if (formKey) setFormErrors((current) => ({ ...current, [formKey]: "" }));
    try {
      await action();
      setMessage(successMessage);
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : "Unknown error";
      setError(detail);
      if (formKey) setFormErrors((current) => ({ ...current, [formKey]: detail }));
      setMessage("Action failed.");
    } finally {
      busyCountRef.current = Math.max(0, busyCountRef.current - 1);
      if (busyCountRef.current === 0) setBusy(false);
    }
  }, []);

  const notify = useCallback((text: string, isError = false) => {
    if (isError) {
      setError(text);
      setMessage("Action failed.");
    } else {
      setError("");
      setMessage(text);
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    const next = await api.listProjects();
    setProjects(next);
    return next;
  }, []);

  const replaceProject = useCallback((updated: Project) => {
    setProjects((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  }, []);

  const refreshSystems = useCallback(async (projectId: string) => {
    const next = await api.listSystems(projectId);
    if (selectedProjectIdRef.current === projectId) setSystems(next);
    return next;
  }, []);

  const refreshRequirements = useCallback(async (projectId: string) => {
    const next = await api.listRequirements(projectId);
    if (selectedProjectIdRef.current === projectId) setRequirements(next);
    return next;
  }, []);

  const refreshDiagrams = useCallback(async (systemId: string) => {
    const next = await api.listDiagrams(systemId);
    if (selectedSystemIdRef.current === systemId) setDiagrams(next);
    return next;
  }, []);

  const refreshSymbols = useCallback(() => {
    api
      .listSymbols()
      .then((list) => setCustomSymbols(Array.isArray(list) ? list : []))
      .catch(() => undefined);
  }, []);

  const confirmDiscard = useCallback(
    (selection: UnsavedScope) => {
      const pending = unsaved.pending({ selection });
      return !pending.length || window.confirm(unsavedPrompt(pending, selection === "project" ? "Switch project" : "Switch system"));
    },
    [unsaved]
  );

  const selectProject = useCallback(
    (projectId: string, options?: SelectOptions) => {
      if (projectId === selectedProjectIdRef.current) return true;
      if (!options?.confirmed && !confirmDiscard("project")) return false;
      setSelectedProjectId(projectId);
      setSelectedSystemId("");
      setSelectedDiagramId("");
      return true;
    },
    [confirmDiscard]
  );

  const selectSystem = useCallback(
    (systemId: string, options?: SelectOptions) => {
      if (systemId === selectedSystemIdRef.current) return true;
      if (!options?.confirmed && !confirmDiscard("system")) return false;
      setSelectedSystemId(systemId);
      setSelectedDiagramId("");
      return true;
    },
    [confirmDiscard]
  );

  useEffect(() => {
    void runAction("Loaded projects.", async () => {
      const next = await api.listProjects();
      setProjects(next);
      const stored = readStored(PROJECT_KEY);
      setSelectedProjectId((current) => {
        if (next.some((project) => project.id === current)) return current;
        if (next.some((project) => project.id === stored)) return stored;
        return next[0]?.id || "";
      });
    });
    void runAction("Loaded parts.", async () => {
      setParts(await api.listParts());
    });
    refreshSymbols();
  }, [refreshSymbols, runAction]);

  useEffect(() => {
    if (!selectedProjectId) {
      projectLoadGeneration.current += 1;
      setSystems([]);
      setRequirements([]);
      return;
    }
    writeStored(PROJECT_KEY, selectedProjectId);
    const projectId = selectedProjectId;
    const generation = ++projectLoadGeneration.current;
    void runAction("Loaded project details.", async () => {
      const [nextSystems, nextRequirements] = await Promise.all([api.listSystems(projectId), api.listRequirements(projectId)]);
      if (generation !== projectLoadGeneration.current) return;
      setSystems(nextSystems);
      setRequirements(nextRequirements);
      const stored = readStored(SYSTEM_KEY);
      setSelectedSystemId((current) => {
        if (nextSystems.some((system) => system.id === current)) return current;
        if (nextSystems.some((system) => system.id === stored)) return stored;
        return nextSystems[0]?.id || "";
      });
      setSelectedRequirementId((current) => (nextRequirements.some((requirement) => requirement.id === current) ? current : nextRequirements[0]?.id || ""));
    });
  }, [selectedProjectId, runAction]);

  useEffect(() => {
    if (!selectedSystemId) {
      systemLoadGeneration.current += 1;
      setDiagrams([]);
      setSelectedDiagramId("");
      return;
    }
    writeStored(SYSTEM_KEY, selectedSystemId);
    const systemId = selectedSystemId;
    const generation = ++systemLoadGeneration.current;
    void runAction("Loaded system diagrams.", async () => {
      const next = await api.listDiagrams(systemId);
      if (generation !== systemLoadGeneration.current) return;
      setDiagrams(next);
      setSelectedDiagramId((current) => (next.some((diagram) => diagram.id === current) ? current : next[0]?.id || ""));
    });
  }, [selectedSystemId, runAction]);

  // A component selection belongs to the diagram it was picked on.
  useEffect(() => {
    setSelectedComponentId("");
  }, [selectedDiagramId]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedSystem = systems.find((system) => system.id === selectedSystemId) ?? null;

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      user,
      canWrite: user.role !== "viewer",
      isAdmin: user.role === "admin",
      busy,
      message,
      error,
      formErrors,
      runAction,
      notify,
      projects,
      refreshProjects,
      replaceProject,
      selectedProjectId,
      selectedProject,
      selectProject,
      systems,
      refreshSystems,
      selectedSystemId,
      selectedSystem,
      selectSystem,
      confirmDiscard,
      requirements,
      refreshRequirements,
      selectedRequirementId,
      setSelectedRequirementId,
      parts,
      setParts,
      selectedPartId,
      setSelectedPartId,
      customSymbols,
      refreshSymbols,
      diagrams,
      refreshDiagrams,
      selectedDiagramId,
      setSelectedDiagramId,
      selectedComponentId,
      setSelectedComponentId
    }),
    [
      user,
      busy,
      message,
      error,
      formErrors,
      runAction,
      notify,
      projects,
      refreshProjects,
      replaceProject,
      selectedProjectId,
      selectedProject,
      selectProject,
      systems,
      refreshSystems,
      selectedSystemId,
      selectedSystem,
      selectSystem,
      confirmDiscard,
      requirements,
      refreshRequirements,
      selectedRequirementId,
      parts,
      selectedPartId,
      customSymbols,
      refreshSymbols,
      diagrams,
      refreshDiagrams,
      selectedDiagramId,
      selectedComponentId
    ]
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
