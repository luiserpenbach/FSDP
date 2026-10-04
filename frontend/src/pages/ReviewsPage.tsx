import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { DataTable, Panel, StatusPill } from "../components/ui";
import type { ChangeEvent as ChangeLogEvent, Impact } from "../types";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { draftingHref } from "./draftingLinks";
import { PageLayout, PlaceholderCard } from "./PageLayout";

type ImpactSubject = "part" | "requirement";

/** Change impact of a catalog part or a requirement on drawings, and the recent change log. */
export function ReviewsPage() {
  const { busy, runAction, selectedProjectId, parts, selectedPartId, requirements, selectedRequirementId } = useWorkspace();
  const [subject, setSubject] = useState<ImpactSubject>("part");
  const [partId, setPartId] = useState(selectedPartId);
  const [requirementId, setRequirementId] = useState(selectedRequirementId);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [changes, setChanges] = useState<ChangeLogEvent[]>([]);

  useEffect(() => {
    void runAction("Loaded change history.", async () => {
      setChanges(await api.listChanges());
    });
  }, [runAction]);

  // An impact result belongs to the project it was inspected in.
  useEffect(() => {
    setImpact(null);
    setRequirementId(selectedRequirementId);
    // Only a project switch resets the picks; the requirement list follows the project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  const objectId = subject === "part" ? partId : requirementId;
  const inspected = impact && impact.object_type === subject && impact.object_id === objectId ? impact : null;

  function inspectImpact() {
    if (!objectId) return;
    const objectType = subject;
    void runAction("Loaded impact.", async () => {
      setImpact(await api.getImpact(objectType, objectId));
    });
  }

  function refreshChanges() {
    void runAction("Refreshed change history.", async () => {
      setChanges(await api.listChanges());
    });
  }

  return (
    <PageLayout title="Reviews" description="Impact and approvals">
      <section className="grid">
        <Panel title="Change Impact" className="impactPanel">
          <div className="impactForm">
            <label>
              Change to
              <select value={subject} onChange={(event) => setSubject(event.target.value as ImpactSubject)}>
                <option value="part">Catalog part</option>
                <option value="requirement">Requirement</option>
              </select>
            </label>
            {subject === "part" ? (
              <label>
                Part
                <select value={partId} onChange={(event) => setPartId(event.target.value)}>
                  <option value="">Choose a part…</option>
                  {parts.map((part) => (
                    <option key={part.id} value={part.id}>
                      {part.part_number} · {part.description}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                Requirement
                <select value={requirementId} onChange={(event) => setRequirementId(event.target.value)}>
                  <option value="">Choose a requirement…</option>
                  {requirements.map((requirement) => (
                    <option key={requirement.id} value={requirement.id}>
                      {requirement.key} · {requirement.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button className="primary" disabled={busy || !objectId} onClick={inspectImpact}>
              Inspect impact
            </button>
          </div>
          {inspected && <ImpactReport impact={inspected} />}
        </Panel>
        <Panel title="Recent Changes">
          <button disabled={busy} onClick={refreshChanges}>Refresh</button>
          <DataTable
            rows={changes}
            getKey={(change) => change.id}
            columns={[
              { header: "Summary", render: (change) => <span className="clamp" title={change.summary}>{change.summary}</span> },
              { header: "Action", render: (change) => <StatusPill value={change.action} /> },
              { header: "Actor", render: (change) => <span className="mono">{change.actor ?? "—"}</span> },
              { header: "When", render: (change) => <span className="mono">{new Date(change.created_at).toLocaleString()}</span> }
            ]}
          />
        </Panel>
        <PlaceholderCard title="Review Workflows" body="Design review packages, comments, decisions, and approval routing will live here." />
      </section>
    </PageLayout>
  );
}

/** What a change touches: drawings and tags (with links into Drafting), requirements, parts, BoMs. */
function ImpactReport({ impact }: { impact: Impact }) {
  const drawings = impact.affected_drawings ?? [];
  const items = impact.affected_sheet_items ?? [];
  const requirements = impact.affected_requirements ?? [];
  const parts = impact.affected_parts ?? [];
  const boms = impact.affected_bom_snapshots;
  const drawingNumbers = new Map(drawings.map((drawing) => [drawing.id, drawing.number]));
  const projectOf = new Map(drawings.map((drawing) => [drawing.id, drawing.project_id]));
  const nothing = !drawings.length && !items.length && !requirements.length && !parts.length && !boms.length && !impact.affected_components.length;
  return (
    <div className="impact">
      <p>
        {drawings.length} drawing(s), {items.length} tag(s), {requirements.length} requirement(s), {parts.length} part(s), and {boms.length} BoM snapshot(s) affected;{" "}
        {impact.direct_links.length} direct trace link(s).
      </p>
      {nothing && <p className="hint">Nothing on a drawing, BoM, or requirement uses this yet.</p>}
      {drawings.length > 0 && (
        <section>
          <h3>Drawings</h3>
          <DataTable
            rows={drawings}
            getKey={(drawing) => drawing.id}
            columns={[
              { header: "Drawing", render: (drawing) => <Link className="mono" to={draftingHref({ projectId: drawing.project_id, drawingId: drawing.id })}>{drawing.number}</Link> },
              { header: "Title", render: (drawing) => drawing.title },
              { header: "Rev", render: (drawing) => <span className="mono">{drawing.revision ?? "—"}</span> },
              { header: "Status", render: (drawing) => <StatusPill value={drawing.status} /> },
              { header: "Sheets", render: (drawing) => <span className="mono">{drawing.sheets.join(", ") || "—"}</span> }
            ]}
          />
        </section>
      )}
      {items.length > 0 && (
        <section>
          <h3>Tags on drawings</h3>
          <DataTable
            rows={items}
            getKey={(item) => item.id}
            columns={[
              {
                header: "Tag",
                render: (item) => (
                  <Link className="mono" to={draftingHref({ projectId: projectOf.get(item.drawing_id), drawingId: item.drawing_id, sheetId: item.sheet_id, itemId: item.item_id })}>
                    {item.tag ?? item.item_id}
                  </Link>
                )
              },
              { header: "Drawing", render: (item) => <span className="mono">{item.drawing_number}</span> },
              { header: "Sheet", render: (item) => <span className="mono">{item.sheet_no}</span> },
              { header: "Zone", render: (item) => <span className="mono">{item.zone ?? "—"}</span> }
            ]}
          />
        </section>
      )}
      {requirements.length > 0 && (
        <section>
          <h3>Requirements</h3>
          <DataTable
            rows={requirements}
            getKey={(requirement) => requirement.id}
            columns={[
              { header: "Key", render: (requirement) => <span className="mono">{requirement.key}</span> },
              { header: "Title", render: (requirement) => requirement.title },
              { header: "Status", render: (requirement) => (requirement.status ? <StatusPill value={requirement.status} /> : "—") }
            ]}
          />
        </section>
      )}
      {parts.length > 0 && (
        <section>
          <h3>Parts</h3>
          <DataTable
            rows={parts}
            getKey={(part) => part.id}
            columns={[
              { header: "Part", render: (part) => <span className="mono">{part.part_number}</span> },
              { header: "Description", render: (part) => part.description }
            ]}
          />
        </section>
      )}
      {boms.length > 0 && (
        <section>
          <h3>BoM snapshots</h3>
          <DataTable
            rows={boms}
            getKey={(bom) => bom.id}
            columns={[
              {
                header: "Source",
                render: (bom) => (bom.drawing_id ? <span className="mono">{drawingNumbers.get(bom.drawing_id) ?? "Drawing"}</span> : <span className="hint">Legacy diagram</span>)
              },
              { header: "Rev", render: (bom) => <span className="mono">{bom.revision}</span> },
              { header: "Status", render: (bom) => <StatusPill value={bom.status} /> }
            ]}
          />
        </section>
      )}
      {impact.affected_components.length > 0 && (
        <p className="hint">Also used by {impact.affected_components.length} component(s) on legacy diagrams; convert them in Drafting to track them on drawings.</p>
      )}
    </div>
  );
}
