import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, hazardApi } from "../api";
import { DataGrid, type DataGridCellErrors, type DataGridColumn, type DataGridCommitResult, type DataGridEdit } from "../components/datagrid";
import { DataTable, FormError, Panel, TextArea, TextInput } from "../components/ui";
import type { Hazard, HazardCategory, HazardInput, HazardStatus, ProjectSheetItem, RiskLevel, TraceLink } from "../types";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { draftingHref } from "./draftingLinks";
import { PageLayout } from "./PageLayout";

const CATEGORY_OPTIONS: Array<{ value: HazardCategory; label: string }> = [
  { value: "overpressure", label: "Overpressure" },
  { value: "backflow", label: "Backflow" },
  { value: "ignition", label: "Ignition" },
  { value: "contamination", label: "Contamination" },
  { value: "single_point_failure", label: "Single point failure" },
  { value: "trapped_fluid", label: "Trapped fluid" },
  { value: "other", label: "Other" }
];

const STATUS_OPTIONS: Array<{ value: HazardStatus; label: string }> = [
  { value: "open", label: "Open" },
  { value: "mitigated", label: "Mitigated" },
  { value: "accepted", label: "Accepted" },
  { value: "closed", label: "Closed" }
];

export const SEVERITY_LABELS = ["Negligible", "Marginal", "Critical", "Catastrophic"];
export const LIKELIHOOD_LABELS = ["Improbable", "Remote", "Occasional", "Probable", "Frequent"];

const STATUS_TONES: Record<HazardStatus, string> = { open: "bad", mitigated: "info", accepted: "warn", closed: "good" };
const RISK_TONES: Record<RiskLevel, string> = { low: "good", medium: "warn", high: "bad" };

/** Same rule as the server (`hazard_risk_level`), for colouring the empty matrix cells. */
export function riskLevel(severity: number, likelihood: number): RiskLevel {
  const score = severity * likelihood;
  if (score >= 10) return "high";
  if (score >= 5 || severity >= 4) return "medium";
  return "low";
}

type HazardForm = {
  key: string;
  title: string;
  description: string;
  category: HazardCategory;
  severity: string;
  likelihood: string;
  mitigation: string;
  status: HazardStatus;
  owner: string;
};

const EMPTY_FORM: HazardForm = { key: "", title: "", description: "", category: "other", severity: "1", likelihood: "1", mitigation: "", status: "open", owner: "" };

function formOf(hazard: Hazard): HazardForm {
  return {
    key: hazard.key,
    title: hazard.title,
    description: hazard.description ?? "",
    category: hazard.category,
    severity: String(hazard.severity),
    likelihood: String(hazard.likelihood),
    mitigation: hazard.mitigation ?? "",
    status: hazard.status,
    owner: hazard.owner ?? ""
  };
}

function payloadOf(form: HazardForm): HazardInput {
  return {
    key: form.key.trim() || null,
    title: form.title.trim(),
    description: form.description.trim() || null,
    category: form.category,
    severity: Number(form.severity),
    likelihood: Number(form.likelihood),
    mitigation: form.mitigation.trim() || null,
    status: form.status,
    owner: form.owner.trim() || null
  };
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const optionalText = (text: string) => (text.trim() === "" ? null : text.trim());

function wholeNumberIn(name: string, min: number, max: number) {
  return (value: unknown) => (Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? null : `${name} is a whole number from ${min} to ${max}`);
}

function hazardColumns(onOpen: (row: Hazard) => void): DataGridColumn<Hazard>[] {
  return [
    {
      key: "key",
      header: "Key",
      frozen: true,
      hideable: false,
      mono: true,
      width: 110,
      render: (row) => (
        <button type="button" className="linkButton mono gridLink" title="Open in the editor and linked items" onClick={() => onOpen(row)}>
          {row.key}
        </button>
      )
    },
    {
      key: "title",
      header: "Title",
      width: 260,
      editable: true,
      parse: (text) => text.trim(),
      validate: (value) => (String(value ?? "").trim() ? null : "Title is required")
    },
    { key: "category", header: "Category", type: "enum", options: CATEGORY_OPTIONS, width: 160, editable: true, validate: (value) => (value ? null : "Category is required") },
    { key: "severity", header: "Severity", type: "number", width: 95, editable: true, validate: wholeNumberIn("Severity", 1, 4) },
    { key: "likelihood", header: "Likelihood", type: "number", width: 105, editable: true, validate: wholeNumberIn("Likelihood", 1, 5) },
    {
      key: "risk",
      header: "Risk",
      width: 120,
      getValue: (row) => `${row.risk_score} ${row.risk_level}`,
      sortValue: (row) => row.risk_score,
      render: (row) => (
        <span className={`pill pill-${RISK_TONES[row.risk_level]}`} title={`Severity ${row.severity} × likelihood ${row.likelihood}`}>
          {row.risk_score} · {row.risk_level}
        </span>
      )
    },
    {
      key: "status",
      header: "Status",
      type: "enum",
      options: STATUS_OPTIONS,
      width: 120,
      editable: true,
      validate: (value) => (value ? null : "Status is required"),
      render: (row) => <span className={`pill pill-${STATUS_TONES[row.status]}`}>{row.status}</span>
    },
    { key: "owner", header: "Owner", width: 140, editable: true, parse: optionalText },
    { key: "mitigation", header: "Mitigation", width: 300, editable: true, parse: optionalText },
    { key: "links", header: "Links", type: "number", width: 80, getValue: (row) => row.links.length },
    { key: "description", header: "Description", width: 320, hidden: true, editable: true, parse: optionalText }
  ];
}

/** Severity × likelihood counts of the hazards that are not closed. */
export function RiskMatrix({ hazards }: { hazards: Hazard[] }) {
  const active = hazards.filter((hazard) => hazard.status !== "closed");
  const count = (severity: number, likelihood: number) => active.filter((hazard) => hazard.severity === severity && hazard.likelihood === likelihood).length;
  const levels: RiskLevel[] = ["high", "medium", "low"];
  return (
    <div className="riskMatrix">
      <table aria-label="Risk matrix">
        <thead>
          <tr>
            <th scope="col">Severity \ likelihood</th>
            {LIKELIHOOD_LABELS.map((label, index) => (
              <th key={label} scope="col">
                {index + 1} {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[4, 3, 2, 1].map((severity) => (
            <tr key={severity}>
              <th scope="row">
                {severity} {SEVERITY_LABELS[severity - 1]}
              </th>
              {[1, 2, 3, 4, 5].map((likelihood) => {
                const total = count(severity, likelihood);
                return (
                  <td
                    key={likelihood}
                    className={`riskCell risk-${riskLevel(severity, likelihood)}${total ? "" : " riskCellEmpty"}`}
                    aria-label={`Severity ${severity}, likelihood ${likelihood}: ${total} hazard${total === 1 ? "" : "s"}`}
                  >
                    {total || ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="riskSummary">
        {levels.map((level) => (
          <span key={level} className={`pill pill-${RISK_TONES[level]}`}>
            {active.filter((hazard) => hazard.risk_level === level).length} {level}
          </span>
        ))}
        <span className="hint">
          {active.length} of {hazards.length} hazard{hazards.length === 1 ? "" : "s"} not closed. Risk = severity × likelihood: 10 and above is high, 5 to 9 medium, and a
          catastrophic hazard is never below medium.
        </span>
      </p>
    </div>
  );
}

/** Sheet items grouped by drawing for the picker, filtered by tag, drawing number, title, or symbol name. */
function groupItemsByDrawing(items: ProjectSheetItem[], filter: string): Array<{ drawingId: string; label: string; items: ProjectSheetItem[] }> {
  const needle = filter.trim().toLowerCase();
  const groups = new Map<string, { drawingId: string; label: string; items: ProjectSheetItem[] }>();
  for (const item of items) {
    const haystack = `${item.tag} ${item.drawing_number} ${item.drawing_title} ${item.symbol_name ?? ""} ${item.label ?? ""}`.toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    const group = groups.get(item.drawing_id) ?? { drawingId: item.drawing_id, label: `${item.drawing_number} · ${item.drawing_title}`, items: [] };
    group.items.push(item);
    groups.set(item.drawing_id, group);
  }
  return [...groups.values()];
}

/** Hazard register of the selected project: grid, risk matrix, editor, and links to drawing items. */
export function SafetyPage() {
  const { busy, canWrite, formErrors, runAction, selectedProjectId, selectedProject, requirements } = useWorkspace();
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const [loadError, setLoadError] = useState("");
  const [selectedHazardId, setSelectedHazardId] = useState("");
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [form, setForm] = useState<HazardForm>(EMPTY_FORM);
  const [sheetItems, setSheetItems] = useState<ProjectSheetItem[]>([]);
  const [itemFilter, setItemFilter] = useState("");
  const [selectedItemId, setSelectedItemId] = useState("");
  const [selectedRequirementId, setSelectedRequirementId] = useState("");

  // A response for a previous project must not overwrite what is on screen now.
  const projectIdRef = useRef(selectedProjectId);
  useEffect(() => {
    projectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  const refreshHazards = useCallback(async (projectId: string): Promise<Hazard[]> => {
    const next = await hazardApi.list(projectId);
    if (projectIdRef.current === projectId) setHazards(next);
    return next;
  }, []);

  useEffect(() => {
    setHazards([]);
    setSheetItems([]);
    setSelectedHazardId("");
    setCheckedIds([]);
    setSelectedItemId("");
    setSelectedRequirementId("");
    setForm(EMPTY_FORM);
    setLoadError("");
    if (!selectedProjectId) return;
    let cancelled = false;
    hazardApi
      .list(selectedProjectId)
      .then((next) => {
        if (!cancelled) setHazards(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(errorText(error, "Could not load hazards."));
      });
    api
      .listProjectSheetItems(selectedProjectId)
      .then((items) => {
        if (!cancelled) setSheetItems(items);
      })
      .catch(() => {
        if (!cancelled) setSheetItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  const selectedHazard = hazards.find((hazard) => hazard.id === selectedHazardId) ?? null;
  const itemsById = useMemo(() => new Map(sheetItems.map((item) => [item.id, item])), [sheetItems]);
  const itemGroups = useMemo(() => groupItemsByDrawing(sheetItems, itemFilter), [sheetItems, itemFilter]);
  const selectedItem = itemsById.get(selectedItemId) ?? null;

  const openHazard = useCallback((hazard: Hazard) => {
    setSelectedHazardId(hazard.id);
    setForm(formOf(hazard));
  }, []);

  function startNew() {
    setSelectedHazardId("");
    setForm(EMPTY_FORM);
  }

  function createHazard(event: FormEvent) {
    event.preventDefault();
    if (!selectedProjectId) return;
    const projectId = selectedProjectId;
    void runAction("Created hazard.", async () => {
      const created = await hazardApi.create(projectId, payloadOf(form));
      await refreshHazards(projectId);
      if (projectIdRef.current === projectId) openHazard(created);
    }, "hazard");
  }

  function updateHazard() {
    if (!selectedHazard) return;
    const projectId = selectedHazard.project_id;
    void runAction(`Updated ${selectedHazard.key}.`, async () => {
      const updated = await hazardApi.update(selectedHazard.id, payloadOf(form));
      await refreshHazards(projectId);
      if (projectIdRef.current === projectId) setForm(formOf(updated));
    }, "hazard");
  }

  function deleteHazards(targets: Hazard[]) {
    if (!targets.length) return;
    const what = targets.length === 1 ? `hazard ${targets[0].key}` : `${targets.length} hazards`;
    if (!window.confirm(`Delete ${what} and the links to drawing items and requirements?`)) return;
    const projectId = selectedProjectId;
    void runAction(`Deleted ${what}.`, async () => {
      for (const hazard of targets) await hazardApi.remove(hazard.id);
      await refreshHazards(projectId);
      setCheckedIds([]);
      if (targets.some((hazard) => hazard.id === selectedHazardId)) startNew();
    }, "hazardsGrid");
  }

  async function commitEdits(edits: DataGridEdit[]): Promise<DataGridCommitResult> {
    const projectId = selectedProjectId;
    const errors: DataGridCellErrors = {};
    const byRow = new Map<string, Record<string, unknown>>();
    for (const edit of edits) byRow.set(edit.rowId, { ...byRow.get(edit.rowId), [edit.key]: edit.value });
    let saved = 0;
    for (const [rowId, changes] of byRow) {
      try {
        const updated = await hazardApi.update(rowId, changes as Partial<HazardInput>);
        saved += 1;
        if (rowId === selectedHazardId) setForm(formOf(updated));
      } catch (error) {
        errors[rowId] = Object.fromEntries(Object.keys(changes).map((key) => [key, errorText(error, "Save failed")]));
      }
    }
    if (saved) await refreshHazards(projectId);
    return Object.keys(errors).length ? { errors } : undefined;
  }

  function linkTo(targetType: "sheet_item" | "requirement", targetId: string, label: string) {
    if (!selectedHazard || !targetId) return;
    const hazard = selectedHazard;
    void runAction(`Linked ${hazard.key} to ${label}.`, async () => {
      await api.createTraceLink({
        source_type: "hazard",
        source_id: hazard.id,
        target_type: targetType,
        target_id: targetId,
        link_type: targetType === "requirement" ? "mitigated_by" : "applies_to"
      });
      await refreshHazards(hazard.project_id);
    }, "hazardLink");
  }

  function removeLink(link: TraceLink) {
    if (!selectedHazard) return;
    const projectId = selectedHazard.project_id;
    void runAction("Removed link.", async () => {
      await api.deleteTraceLink(link.id);
      await refreshHazards(projectId);
    }, "hazardLink");
  }

  function describeLink(link: TraceLink): { kind: string; text: string; href?: string } {
    if (link.target_type === "sheet_item") {
      const item = itemsById.get(link.target_id);
      if (!item) return { kind: "Drawing item", text: "Item no longer tagged on a saved sheet" };
      return {
        kind: "Drawing item",
        text: `${item.tag} · ${item.drawing_number} sheet ${item.sheet_no}${item.zone ? ` @ ${item.zone}` : ""}`,
        href: draftingHref({ projectId: selectedProjectId, drawingId: item.drawing_id, sheetId: item.sheet_id, itemId: item.item_id })
      };
    }
    if (link.target_type === "requirement") {
      const requirement = requirements.find((entry) => entry.id === link.target_id);
      return { kind: "Requirement", text: requirement ? `${requirement.key} · ${requirement.title}` : "Requirement (deleted)" };
    }
    return { kind: link.target_type.replaceAll("_", " "), text: link.target_id.slice(0, 8) };
  }

  const columns = useMemo(() => hazardColumns(openHazard), [openHazard]);
  const linkedRequirementIds = new Set((selectedHazard?.links ?? []).filter((link) => link.target_type === "requirement").map((link) => link.target_id));
  const set = <K extends keyof HazardForm>(key: K, value: HazardForm[K]) => setForm((current) => ({ ...current, [key]: value }));

  return (
    <PageLayout title="Safety" description="Hazard register">
      <section className="grid">
        <Panel title="Hazards" className="panelWide">
          <FormError message={loadError || formErrors.hazardsGrid} />
          <DataGrid
            ariaLabel="Hazards"
            bulkActions={
              canWrite
                ? (selected: Hazard[]) => (
                    <button type="button" className="dgButton danger" disabled={busy} onClick={() => deleteHazards(selected)}>
                      Delete…
                    </button>
                  )
                : undefined
            }
            columns={columns}
            defaultSort={[{ key: "key", dir: "asc" }]}
            emptyMessage={
              selectedProject
                ? canWrite
                  ? "No hazards yet. Add the first one in the editor."
                  : "No hazards recorded for this project."
                : "Select a project to see its hazards."
            }
            exportFileName="hazards"
            getRowId={(row) => row.id}
            height={360}
            onCommit={canWrite && selectedProject ? commitEdits : undefined}
            onRowActivate={openHazard}
            onSelectionChange={setCheckedIds}
            rowClassName={(row) => (row.id === selectedHazardId ? "gridRowOpen" : undefined)}
            rows={hazards}
            selectable={canWrite}
            selectedIds={checkedIds}
            storageKey="safety.hazards"
          />
        </Panel>
        <Panel title="Risk matrix" className="panelWide">
          <RiskMatrix hazards={hazards} />
        </Panel>
        <Panel
          title={selectedHazard ? `Hazard ${selectedHazard.key}` : "New hazard"}
          actions={
            selectedHazard ? (
              <span className="panelActions">
                <button type="button" onClick={startNew}>
                  New hazard
                </button>
              </span>
            ) : null
          }
        >
          <form onSubmit={createHazard}>
            <TextInput label="Key (leave blank for the next HAZ number)" value={form.key} onChange={(key) => set("key", key)} />
            <TextInput label="Title" value={form.title} onChange={(title) => set("title", title)} />
            <label>
              Category
              <select value={form.category} onChange={(event) => set("category", event.target.value as HazardCategory)}>
                {CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="fieldPair">
              <label>
                Severity
                <select value={form.severity} onChange={(event) => set("severity", event.target.value)}>
                  {SEVERITY_LABELS.map((label, index) => (
                    <option key={label} value={String(index + 1)}>
                      {index + 1} · {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Likelihood
                <select value={form.likelihood} onChange={(event) => set("likelihood", event.target.value)}>
                  {LIKELIHOOD_LABELS.map((label, index) => (
                    <option key={label} value={String(index + 1)}>
                      {index + 1} · {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="fieldPair">
              <label>
                Status
                <select value={form.status} onChange={(event) => set("status", event.target.value as HazardStatus)}>
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <TextInput label="Owner" value={form.owner} onChange={(owner) => set("owner", owner)} />
            </div>
            <TextArea label="Description (cause and consequence)" value={form.description} onChange={(description) => set("description", description)} />
            <TextArea label="Mitigation" value={form.mitigation} onChange={(mitigation) => set("mitigation", mitigation)} />
            <FormError message={formErrors.hazard} />
            {canWrite ? (
              <div className="buttonRow">
                <button className={selectedHazard ? undefined : "primary"} disabled={busy || !selectedProject || !form.title.trim()}>
                  {selectedHazard ? "Create as new hazard" : "Create hazard"}
                </button>
                <button type="button" className="primary" disabled={busy || !selectedHazard || !form.title.trim()} onClick={updateHazard}>
                  Save changes
                </button>
                <button type="button" className="danger" disabled={busy || !selectedHazard} onClick={() => selectedHazard && deleteHazards([selectedHazard])}>
                  Delete
                </button>
              </div>
            ) : (
              <p className="hint">This account is read-only.</p>
            )}
          </form>
        </Panel>
        <Panel title="Linked items">
          {!selectedHazard ? (
            <p className="hint">Open a hazard from the table to link it to tagged drawing items and requirements.</p>
          ) : (
            <>
              {canWrite && (
                <>
                  <TextInput label="Find drawing item" value={itemFilter} onChange={setItemFilter} />
                  <label>
                    Drawing item
                    <select value={selectedItemId} onChange={(event) => setSelectedItemId(event.target.value)}>
                      <option value="">{sheetItems.length ? "Choose a tagged item…" : "No tagged items on saved sheets"}</option>
                      {itemGroups.map((group) => (
                        <optgroup key={group.drawingId} label={group.label}>
                          {group.items.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.tag} · sheet {item.sheet_no}
                              {item.zone ? ` @ ${item.zone}` : ""}
                              {item.symbol_name ? ` (${item.symbol_name})` : ""}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                  <button className="primary" disabled={busy || !selectedItem} onClick={() => selectedItem && linkTo("sheet_item", selectedItem.id, selectedItem.tag)}>
                    Link hazard to item
                  </button>
                  {!sheetItems.length && <p className="hint">Tag symbols on the Drafting page and save the sheet to link hazards to them.</p>}
                  <label>
                    Requirement
                    <select value={selectedRequirementId} onChange={(event) => setSelectedRequirementId(event.target.value)}>
                      <option value="">{requirements.length ? "Choose a requirement…" : "No requirements in this project"}</option>
                      {requirements
                        .filter((requirement) => !linkedRequirementIds.has(requirement.id))
                        .map((requirement) => (
                          <option key={requirement.id} value={requirement.id}>
                            {requirement.key} · {requirement.title}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    disabled={busy || !selectedRequirementId}
                    onClick={() => {
                      const requirement = requirements.find((entry) => entry.id === selectedRequirementId);
                      if (requirement) linkTo("requirement", requirement.id, requirement.key);
                      setSelectedRequirementId("");
                    }}
                  >
                    Link hazard to requirement
                  </button>
                  <FormError message={formErrors.hazardLink} />
                </>
              )}
              {selectedHazard.links.length ? (
                <DataTable
                  rows={selectedHazard.links}
                  getKey={(link) => link.id}
                  columns={[
                    { header: "Type", render: (link) => describeLink(link).kind },
                    {
                      header: "Linked to",
                      render: (link) => {
                        const target = describeLink(link);
                        return target.href ? (
                          <Link className="mono" to={target.href} title="Open in Drafting">
                            {target.text}
                          </Link>
                        ) : (
                          <span className="mono">{target.text}</span>
                        );
                      }
                    },
                    ...(canWrite
                      ? [
                          {
                            header: "",
                            render: (link: TraceLink) => (
                              <button className="danger" disabled={busy} onClick={() => removeLink(link)}>
                                Remove
                              </button>
                            )
                          }
                        ]
                      : [])
                  ]}
                />
              ) : (
                <p className="hint">Nothing linked to {selectedHazard.key} yet.</p>
              )}
            </>
          )}
        </Panel>
      </section>
    </PageLayout>
  );
}
