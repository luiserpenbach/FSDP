import { useCallback, useEffect, useRef, useState } from "react";
import { api, bomCsvUrl } from "../api";
import { DataTable, Panel, Select, StatusPill } from "../components/ui";
import type { BomDiff, BomReadiness, BomSnapshot, ProjectBom } from "../types";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { PageLayout } from "./PageLayout";

/** BoM snapshots of the open legacy diagram: generate, release, readiness, diff, CSV. */
export function BomPage() {
  const { busy, runAction, selectedProjectId, diagrams, selectedDiagramId } = useWorkspace();
  const [bomSnapshots, setBomSnapshots] = useState<BomSnapshot[]>([]);
  const [selectedBomId, setSelectedBomId] = useState("");
  const [bomReadiness, setBomReadiness] = useState<BomReadiness | null>(null);
  const [diffAgainstId, setDiffAgainstId] = useState("");
  const [bomDiff, setBomDiff] = useState<BomDiff | null>(null);
  const [projectBoms, setProjectBoms] = useState<ProjectBom[]>([]);

  const selectedDiagram = diagrams.find((diagram) => diagram.id === selectedDiagramId) ?? null;
  const bom = bomSnapshots.find((snapshot) => snapshot.id === selectedBomId) ?? null;

  // Current selections for async actions: a response for a previous selection
  // must not overwrite what is on screen now.
  const selectedProjectIdRef = useRef(selectedProjectId);
  const selectedDiagramIdRef = useRef(selectedDiagramId);
  const selectedBomIdRef = useRef(selectedBomId);
  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
    selectedDiagramIdRef.current = selectedDiagramId;
    selectedBomIdRef.current = selectedBomId;
  }, [selectedProjectId, selectedDiagramId, selectedBomId]);

  useEffect(() => {
    // Never show the previous diagram's snapshots under the new one.
    setBomSnapshots([]);
    setSelectedBomId("");
    if (!selectedDiagramId) return;
    let cancelled = false;
    api
      .listDiagramBoms(selectedDiagramId)
      .then((snapshots) => {
        if (cancelled) return;
        setBomSnapshots(snapshots);
        setSelectedBomId(snapshots[0]?.id ?? "");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedDiagramId]);

  useEffect(() => {
    setProjectBoms([]);
    if (!selectedProjectId) return;
    let cancelled = false;
    api
      .listProjectBoms(selectedProjectId)
      .then((next) => {
        if (!cancelled) setProjectBoms(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  useEffect(() => {
    setBomDiff(null);
    setDiffAgainstId("");
    // Never show the previous snapshot's readiness under the new one.
    setBomReadiness(null);
    if (!selectedBomId) return;
    let cancelled = false;
    api
      .getBomReadiness(selectedBomId)
      .then((readiness) => {
        if (!cancelled) setBomReadiness(readiness);
      })
      .catch(() => {
        if (!cancelled) setBomReadiness(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBomId]);

  const reloadProjectBoms = useCallback(async (projectId: string) => {
    const next = projectId ? await api.listProjectBoms(projectId) : [];
    if (selectedProjectIdRef.current === projectId) setProjectBoms(next);
  }, []);

  function generateBom() {
    if (!selectedDiagram) return;
    const diagramId = selectedDiagram.id;
    const projectId = selectedProjectId;
    void runAction("Generated BoM snapshot.", async () => {
      const snapshot = await api.generateBom(diagramId);
      const snapshots = await api.listDiagramBoms(diagramId);
      // The snapshot list belongs to the diagram that was open when Generate was clicked.
      if (selectedDiagramIdRef.current === diagramId) {
        setBomSnapshots(snapshots);
        setSelectedBomId(snapshot.id);
      }
      await reloadProjectBoms(projectId);
    });
  }

  function setBomStatus(status: string) {
    if (!bom) return;
    const projectId = selectedProjectId;
    void runAction(`BoM revision ${bom.revision} marked ${status}.`, async () => {
      const updated = await api.setBomStatus(bom.id, status);
      setBomSnapshots((current) => current.map((snapshot) => (snapshot.id === updated.id ? updated : snapshot)));
      await reloadProjectBoms(projectId);
    });
  }

  function runBomDiff() {
    if (!bom || !diffAgainstId) return;
    const bomId = bom.id;
    void runAction("Compared BoM revisions.", async () => {
      const diff = await api.getBomDiff(bomId, diffAgainstId);
      if (selectedBomIdRef.current === bomId) setBomDiff(diff);
    });
  }

  return (
    <PageLayout title="BoM & Procurement" description="Snapshots, readiness, and exports">
      <section className="grid">
        <Panel title="Snapshots">
          <button className="primary" disabled={busy || !selectedDiagram} onClick={generateBom}>Generate BoM</button>
          {bom && (bom.status === "released"
            ? <button disabled={busy} onClick={() => setBomStatus("draft")}>Reopen as draft</button>
            : <button disabled={busy} onClick={() => setBomStatus("released")}>Release</button>)}
          {selectedDiagram
            ? <DataTable rows={bomSnapshots} selectedKey={selectedBomId} getKey={(snapshot) => snapshot.id} onSelect={(snapshot) => setSelectedBomId(snapshot.id)} columns={[{ header: "Rev", render: (snapshot) => <span className="mono">{snapshot.revision}</span> }, { header: "Status", render: (snapshot) => <StatusPill value={snapshot.status} /> }, { header: "Rows", render: (snapshot) => <span className="mono">{snapshot.rows.length}</span> }, { header: "Created", render: (snapshot) => <span className="mono">{snapshot.created_at ? new Date(snapshot.created_at).toLocaleString() : "—"}</span> }]} />
            : <p className="hint">Open a diagram on the Diagrams page first.</p>}
        </Panel>
        <Panel title="Selected Snapshot">
          {bom ? (
            <>
              <p className="snapshotMeta">Revision <span className="mono">{bom.revision}</span> · {bom.rows.length} row(s) · <StatusPill value={bom.status} /></p>
              <a className="downloadLink" href={bomCsvUrl(bom.id)}>Download CSV</a>
              <DataTable rows={bom.rows} getKey={(_, index?: number) => String(index)} columns={[{ header: "Part", render: (row) => <span className="mono">{String(row.part_number ?? "Unresolved")}</span> }, { header: "Description", render: (row) => String(row.description ?? "") }, { header: "Material", render: (row) => String(row.material ?? "—") }, { header: "Qty", render: (row) => <span className="mono">{String(row.quantity ?? 0)}</span> }]} />
            </>
          ) : <p className="hint">Generate or select a snapshot.</p>}
        </Panel>
        <Panel title="Procurement Readiness">
          {bomReadiness ? (
            bomReadiness.ready
              ? <p className="snapshotMeta"><span className="pill pill-good">ready</span> All {bomReadiness.row_count} row(s) reference qualified parts with complete data.</p>
              : (
                <>
                  <p className="snapshotMeta"><span className="pill pill-warn">{bomReadiness.issue_count} issue(s)</span> in {bomReadiness.row_count} row(s)</p>
                  <DataTable rows={bomReadiness.issues} getKey={(_, index?: number) => String(index)} columns={[{ header: "Part", render: (issue) => <span className="mono">{issue.part_number ?? "Unresolved"}</span> }, { header: "Tags", render: (issue) => <span className="mono">{issue.component_tags.join(", ") || "—"}</span> }, { header: "Warnings", render: (issue) => issue.warnings.join(" ") }]} />
                </>
              )
          ) : <p className="hint">Select a snapshot to check procurement readiness.</p>}
        </Panel>
        <Panel title="Compare Revisions">
          {bom && bomSnapshots.length > 1 ? (
            <>
              <Select label={`Compare rev ${bom.revision} against`} value={diffAgainstId} options={bomSnapshots.filter((snapshot) => snapshot.id !== bom.id).map((snapshot) => ({ value: snapshot.id, label: `rev ${snapshot.revision}` }))} onChange={setDiffAgainstId} />
              <button disabled={busy || !diffAgainstId} onClick={runBomDiff}>Compare</button>
              {bomDiff && (
                <>
                  <p className="snapshotMeta"><span className="pill pill-good">{bomDiff.added.length} added</span><span className="pill pill-bad">{bomDiff.removed.length} removed</span><span className="pill pill-info">{bomDiff.changed.length} qty changed</span></p>
                  {bomDiff.added.length > 0 && <DataTable rows={bomDiff.added} getKey={(_, index?: number) => `a${index}`} columns={[{ header: "Added", render: (row) => <span className="mono">{String(row.part_number ?? row.description ?? "?")}</span> }, { header: "Qty", render: (row) => <span className="mono">{String(row.quantity ?? 0)}</span> }]} />}
                  {bomDiff.removed.length > 0 && <DataTable rows={bomDiff.removed} getKey={(_, index?: number) => `r${index}`} columns={[{ header: "Removed", render: (row) => <span className="mono">{String(row.part_number ?? row.description ?? "?")}</span> }, { header: "Qty", render: (row) => <span className="mono">{String(row.quantity ?? 0)}</span> }]} />}
                  {bomDiff.changed.length > 0 && <DataTable rows={bomDiff.changed} getKey={(_, index?: number) => `c${index}`} columns={[{ header: "Part", render: (row) => <span className="mono">{row.part_number ?? "?"}</span> }, { header: "Qty", render: (row) => <span className="mono">{row.from_quantity} → {row.to_quantity}</span> }]} />}
                </>
              )}
            </>
          ) : <p className="hint">Generate at least two snapshots of a diagram to compare revisions.</p>}
        </Panel>
        <Panel title="Project BoM History">
          {projectBoms.length ? (
            <DataTable rows={projectBoms} getKey={(snapshot) => snapshot.id} columns={[{ header: "Diagram", render: (snapshot) => snapshot.diagram_name }, { header: "Rev", render: (snapshot) => <span className="mono">{snapshot.revision}</span> }, { header: "Status", render: (snapshot) => <StatusPill value={snapshot.status} /> }, { header: "Rows", render: (snapshot) => <span className="mono">{snapshot.rows.length}</span> }, { header: "Created", render: (snapshot) => <span className="mono">{snapshot.created_at ? new Date(snapshot.created_at).toLocaleString() : "—"}</span> }]} />
          ) : <p className="hint">No snapshots in this project yet.</p>}
        </Panel>
      </section>
    </PageLayout>
  );
}
