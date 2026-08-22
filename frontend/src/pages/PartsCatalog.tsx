import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../api";
import { DataTable, FormError, Panel, Select, StatusPill, TextArea, TextInput } from "../components/ui";
import type { CatalogDocument, CatalogSettings, Part, PartUsage } from "../types";

const LIFECYCLE_OPTIONS = ["draft", "active", "legacy", "restricted", "obsolete"].map((value) => ({
  value,
  label: value
}));
const QUALIFICATION_OPTIONS = ["unqualified", "in_qualification", "qualified", "disqualified"].map(
  (value) => ({ value, label: value.replaceAll("_", " ") })
);
const CERTIFICATION_OPTIONS = ["unreviewed", "in_review", "certified", "rejected", "expired"].map(
  (value) => ({ value, label: value.replaceAll("_", " ") })
);
const SOURCE_OPTIONS = ["internal", "vendor", "custom"].map((value) => ({ value, label: value }));
const DOCUMENT_KINDS = ["datasheet", "drawing", "cad", "coc", "test_report", "memo", "photo", "other"];

const EMPTY_FORM = {
  part_number: "",
  description: "",
  part_type: "valve",
  source_type: "internal",
  manufacturer: "",
  material: "",
  revision: "",
  pressure_rating_bar: "",
  temperature_min_c: "",
  temperature_max_c: "",
  cv: "",
  mass_kg: "",
  qualification_status: "unqualified",
  certification_status: "unreviewed",
  lifecycle_status: "draft",
  preferred: false,
  notes: ""
};

function parseOptionalNumber(raw: string, label: string): number | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a number (leave empty if unknown).`);
  }
  return parsed;
}

export function PartsCatalog({
  parts,
  selectedPartId,
  projectId,
  onSelectPart,
  onPartsChanged
}: {
  parts: Part[];
  selectedPartId: string;
  projectId?: string;
  onSelectPart: (partId: string) => void;
  onPartsChanged: (parts: Part[]) => void;
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [lifecycleFilter, setLifecycleFilter] = useState("");
  const [catalogSettings, setCatalogSettings] = useState<CatalogSettings | null>(null);
  const [usage, setUsage] = useState<PartUsage | null>(null);
  const [documents, setDocuments] = useState<CatalogDocument[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadKind, setUploadKind] = useState("datasheet");

  const selectedPart = parts.find((part) => part.id === selectedPartId) ?? null;
  const typeOptions = useMemo(() => {
    const fromSettings = catalogSettings?.part_types ?? [];
    const fromParts = parts.map((part) => part.part_type);
    return Array.from(new Set([...fromSettings, ...fromParts, form.part_type].filter(Boolean))).sort();
  }, [catalogSettings, parts, form.part_type]);

  const visibleParts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return parts.filter((part) => {
      if (typeFilter && part.part_type !== typeFilter) return false;
      if (lifecycleFilter && part.lifecycle_status !== lifecycleFilter) return false;
      if (!needle) return true;
      return [part.part_number, part.description, part.manufacturer ?? ""].some((value) =>
        value.toLowerCase().includes(needle)
      );
    });
  }, [parts, query, typeFilter, lifecycleFilter]);

  useEffect(() => {
    void api.getCatalogSettings().then(setCatalogSettings).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!selectedPart) {
      setForm(EMPTY_FORM);
      setUsage(null);
      setDocuments([]);
      return;
    }
    setForm({
      part_number: selectedPart.part_number,
      description: selectedPart.description,
      part_type: selectedPart.part_type,
      source_type: selectedPart.source_type || "internal",
      manufacturer: selectedPart.manufacturer ?? "",
      material: selectedPart.material ?? "",
      revision: selectedPart.revision ?? "",
      pressure_rating_bar: selectedPart.pressure_rating_bar == null ? "" : String(selectedPart.pressure_rating_bar),
      temperature_min_c: selectedPart.temperature_min_c == null ? "" : String(selectedPart.temperature_min_c),
      temperature_max_c: selectedPart.temperature_max_c == null ? "" : String(selectedPart.temperature_max_c),
      cv: selectedPart.cv == null ? "" : String(selectedPart.cv),
      mass_kg: selectedPart.mass_kg == null ? "" : String(selectedPart.mass_kg),
      qualification_status: selectedPart.qualification_status,
      certification_status: selectedPart.certification_status,
      lifecycle_status: selectedPart.lifecycle_status || "draft",
      preferred: Boolean(selectedPart.preferred),
      notes: selectedPart.notes ?? ""
    });
    void api.getPartUsage(selectedPart.id).then(setUsage).catch(() => setUsage(null));
    void api.listPartDocuments(selectedPart.id).then(setDocuments).catch(() => setDocuments([]));
  }, [selectedPart]);

  async function run(message: string, work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : message);
    } finally {
      setBusy(false);
    }
  }

  function payload() {
    return {
      part_number: form.part_number,
      description: form.description,
      part_type: form.part_type,
      source_type: form.source_type,
      manufacturer: form.manufacturer || undefined,
      material: form.material || undefined,
      revision: form.revision || undefined,
      pressure_rating_bar: parseOptionalNumber(form.pressure_rating_bar, "Pressure rating"),
      temperature_min_c: parseOptionalNumber(form.temperature_min_c, "Temperature min"),
      temperature_max_c: parseOptionalNumber(form.temperature_max_c, "Temperature max"),
      cv: parseOptionalNumber(form.cv, "Cv"),
      mass_kg: parseOptionalNumber(form.mass_kg, "Mass"),
      qualification_status: form.qualification_status,
      certification_status: form.certification_status,
      lifecycle_status: form.lifecycle_status,
      preferred: form.preferred,
      notes: form.notes || undefined
    };
  }

  function submitPart(event: FormEvent) {
    event.preventDefault();
    void run("Created part.", async () => {
      const part = await api.createPart(payload());
      const next = await api.listParts();
      onPartsChanged(next);
      onSelectPart(part.id);
    });
  }

  function updateSelected() {
    if (!selectedPart) return;
    void run("Updated part.", async () => {
      await api.updatePart(selectedPart.id, payload());
      onPartsChanged(await api.listParts());
    });
  }

  function deleteSelected() {
    if (!selectedPart || !window.confirm(`Delete part "${selectedPart.part_number}"?`)) return;
    void run("Deleted part.", async () => {
      await api.deletePart(selectedPart.id);
      const next = await api.listParts();
      onPartsChanged(next);
      onSelectPart(next[0]?.id || "");
    });
  }

  function obsoleteSelected() {
    if (!selectedPart || !window.confirm(`Mark "${selectedPart.part_number}" obsolete?`)) return;
    void run("Marked obsolete.", async () => {
      await api.obsoletePart(selectedPart.id);
      onPartsChanged(await api.listParts());
    });
  }

  function generateName() {
    void run("Generated name.", async () => {
      const generated = await api.generatePartName(projectId);
      setForm((current) => ({ ...current, part_number: generated.part_number }));
    });
  }

  function onUpload(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file || !selectedPart) return;
    void run("Uploaded document.", async () => {
      await api.uploadPartDocument(selectedPart.id, file, file.name, uploadKind);
      setDocuments(await api.listPartDocuments(selectedPart.id));
    });
  }

  return (
    <section className="grid catalogLayout">
      <Panel title="Library">
        <div className="catalogFilters">
          <TextInput label="Search" value={query} onChange={setQuery} />
          <Select
            label="Type"
            value={typeFilter}
            options={typeOptions.map((value) => ({ value, label: value }))}
            onChange={setTypeFilter}
          />
          <Select label="Lifecycle" value={lifecycleFilter} options={LIFECYCLE_OPTIONS} onChange={setLifecycleFilter} />
        </div>
        <DataTable
          rows={visibleParts}
          selectedKey={selectedPartId}
          getKey={(part) => part.id}
          onSelect={(part) => onSelectPart(part.id)}
          columns={[
            { header: "Name", render: (part) => <span className="mono">{part.part_number}</span> },
            { header: "Type", render: (part) => part.part_type },
            { header: "Material", render: (part) => part.material ?? "—" },
            {
              header: "Bar",
              render: (part) => <span className="mono">{part.pressure_rating_bar ?? "—"}</span>
            },
            { header: "Lifecycle", render: (part) => <StatusPill value={part.lifecycle_status} /> },
            { header: "Qual", render: (part) => <StatusPill value={part.qualification_status} /> },
            {
              header: "%",
              render: (part) => <span className="mono">{part.completeness ?? "—"}</span>
            }
          ]}
        />
        <p className="hint">{visibleParts.length} of {parts.length} parts. Names are unique across the catalog.</p>
      </Panel>
      <Panel title="Part editor">
        <form onSubmit={submitPart}>
          <label>
            Part name
            <span className="inputWithAction">
              <input
                value={form.part_number}
                onChange={(event) => setForm({ ...form, part_number: event.target.value })}
              />
              <button type="button" disabled={busy} onClick={generateName}>
                Generate
              </button>
            </span>
          </label>
          <p className="hint">
            Generate uses {"{prefix}-{seq}"}
            {catalogSettings ? ` (${catalogSettings.prefix}-001, …)` : ""}. You can type any unique name.
          </p>
          <TextInput label="Description" value={form.description} onChange={(description) => setForm({ ...form, description })} />
          <label>
            Type
            <input
              list="catalog-part-types"
              value={form.part_type}
              onChange={(event) => setForm({ ...form, part_type: event.target.value })}
            />
            <datalist id="catalog-part-types">
              {typeOptions.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          </label>
          <Select label="Source" value={form.source_type} options={SOURCE_OPTIONS} onChange={(source_type) => setForm({ ...form, source_type })} />
          <TextInput label="Manufacturer" value={form.manufacturer} onChange={(manufacturer) => setForm({ ...form, manufacturer })} />
          <TextInput label="Material" value={form.material} onChange={(material) => setForm({ ...form, material })} />
          <TextInput label="Revision" value={form.revision} onChange={(revision) => setForm({ ...form, revision })} />
          <TextInput label="Pressure rating bar" value={form.pressure_rating_bar} onChange={(pressure_rating_bar) => setForm({ ...form, pressure_rating_bar })} />
          <div className="splitFields">
            <TextInput label="Temp min °C" value={form.temperature_min_c} onChange={(temperature_min_c) => setForm({ ...form, temperature_min_c })} />
            <TextInput label="Temp max °C" value={form.temperature_max_c} onChange={(temperature_max_c) => setForm({ ...form, temperature_max_c })} />
          </div>
          <div className="splitFields">
            <TextInput label="Cv" value={form.cv} onChange={(cv) => setForm({ ...form, cv })} />
            <TextInput label="Mass kg" value={form.mass_kg} onChange={(mass_kg) => setForm({ ...form, mass_kg })} />
          </div>
          <Select label="Lifecycle" value={form.lifecycle_status} options={LIFECYCLE_OPTIONS} onChange={(lifecycle_status) => setForm({ ...form, lifecycle_status })} />
          <Select label="Qualification" value={form.qualification_status} options={QUALIFICATION_OPTIONS} onChange={(qualification_status) => setForm({ ...form, qualification_status })} />
          <Select label="Certification" value={form.certification_status} options={CERTIFICATION_OPTIONS} onChange={(certification_status) => setForm({ ...form, certification_status })} />
          <label className="checkboxLabel">
            <input
              type="checkbox"
              checked={form.preferred}
              onChange={(event) => setForm({ ...form, preferred: event.target.checked })}
            />
            Preferred
          </label>
          <TextArea label="Notes" value={form.notes} onChange={(notes) => setForm({ ...form, notes })} />
          <FormError message={error} />
          <button disabled={busy || !form.part_number || !form.description || !form.part_type}>Add part</button>
        </form>
        <div className="buttonRow">
          <button disabled={!selectedPart || busy} onClick={updateSelected}>Update selected</button>
          <button disabled={!selectedPart || busy} onClick={obsoleteSelected}>Mark obsolete</button>
          <button className="danger" disabled={!selectedPart || busy} onClick={deleteSelected}>Delete selected</button>
        </div>
      </Panel>
      <Panel title="Where used">
        {!selectedPart && <p className="hint">Select a part to see diagrams and BoMs that use it.</p>}
        {selectedPart && usage && (
          <>
            {usage.components.length ? (
              <DataTable
                rows={usage.components}
                getKey={(row) => row.id}
                columns={[
                  { header: "Tag", render: (row) => <span className="mono">{row.tag}</span> },
                  { header: "Project", render: (row) => row.project_name },
                  { header: "Diagram", render: (row) => row.diagram_name },
                  { header: "Qty", render: (row) => <span className="mono">{row.quantity}</span> }
                ]}
              />
            ) : (
              <p className="hint">Not placed on any diagram.</p>
            )}
            {usage.bom_snapshots.length > 0 && (
              <p className="hint">
                {usage.bom_snapshots.length} BoM snapshot{usage.bom_snapshots.length === 1 ? "" : "s"} on those diagrams.
              </p>
            )}
          </>
        )}
      </Panel>
      <Panel title="Documents">
        {!selectedPart && <p className="hint">Select a part to attach datasheets, drawings, or CAD.</p>}
        {selectedPart && (
          <>
            <div className="catalogFilters">
              <Select
                label="Kind"
                value={uploadKind}
                options={DOCUMENT_KINDS.map((value) => ({ value, label: value.replaceAll("_", " ") }))}
                onChange={setUploadKind}
              />
              <label>
                Upload file
                <input type="file" disabled={busy} onChange={(event) => onUpload(event.target.files)} />
              </label>
            </div>
            {documents.length ? (
              <DataTable
                rows={documents}
                getKey={(doc) => doc.id}
                columns={[
                  { header: "Title", render: (doc) => doc.title },
                  { header: "Kind", render: (doc) => doc.kind.replaceAll("_", " ") },
                  { header: "File", render: (doc) => <span className="mono">{doc.original_filename}</span> },
                  {
                    header: "",
                    render: (doc) => (
                      <span className="rowActions">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void api.downloadPartDocument(selectedPart.id, doc.id, doc.original_filename)}
                        >
                          Download
                        </button>
                        <button
                          type="button"
                          className="danger"
                          disabled={busy}
                          onClick={() =>
                            void run("Removed document.", async () => {
                              await api.deletePartDocument(selectedPart.id, doc.id);
                              setDocuments(await api.listPartDocuments(selectedPart.id));
                            })
                          }
                        >
                          Remove
                        </button>
                      </span>
                    )
                  }
                ]}
              />
            ) : (
              <p className="hint">No files yet. PDF, images, STEP, ZIP, and Office documents up to 25 MB.</p>
            )}
          </>
        )}
      </Panel>
    </section>
  );
}
