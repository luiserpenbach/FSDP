import { useEffect, useState } from "react";
import { api } from "../api";
import { DataTable, Panel, StatusPill } from "../components/ui";
import type { ChangeEvent as ChangeLogEvent, Impact } from "../types";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { PageLayout, PlaceholderCard } from "./PageLayout";

/** Change impact of the selected component or part, and the recent change log. */
export function ReviewsPage() {
  const { busy, runAction, selectedProjectId, selectedPartId, selectedComponentId } = useWorkspace();
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
  }, [selectedProjectId]);

  function inspectImpact() {
    const objectType = selectedComponentId ? "component" : "part";
    const objectId = selectedComponentId || selectedPartId;
    if (!objectId) return;
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
        <Panel title="Change Impact">
          <button disabled={!selectedPartId && !selectedComponentId} onClick={inspectImpact}>Inspect impact</button>
          {impact && <div className="impact"><p>{impact.direct_links.length} trace links, {impact.affected_components.length} components, {impact.affected_bom_snapshots.length} BoM snapshots affected.</p></div>}
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
