import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Panel } from "../components/ui";
import type { Drawing, VerificationMatrix } from "../types";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { PageLayout } from "./PageLayout";

type Loadable<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: T };

type DrcSummary = {
  errors: number;
  warnings: number;
  /** Drawings with open errors or warnings, worst first. */
  flagged: Array<{ number: string; errors: number; warnings: number }>;
  /** Drawings whose DRC could not be read. */
  unavailable: number;
};

const LOADING = { state: "loading" } as const;

function failure(caught: unknown): { state: "error"; message: string } {
  return { state: "error", message: caught instanceof Error ? caught.message : "Request failed" };
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

/** Count values, most frequent first. */
function tally(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Requirements nothing verifies yet: no drawing check ran and no trace link points at them. */
function isUnverified(row: VerificationMatrix["rows"][number]): boolean {
  if (row.verdict === "pass" || row.verdict === "fail") return false;
  return row.linked_drawings === 0 && row.linked_components === 0;
}

/** Project overview: what needs attention, each card linking to where it is fixed. */
export function DashboardPage() {
  const { selectedProjectId, selectedProject, systems, selectedSystem, parts } = useWorkspace();
  const [drawings, setDrawings] = useState<Loadable<Drawing[]>>(LOADING);
  const [drc, setDrc] = useState<Loadable<DrcSummary>>(LOADING);
  const [matrix, setMatrix] = useState<Loadable<VerificationMatrix>>(LOADING);

  useEffect(() => {
    if (!selectedProjectId) return;
    const projectId = selectedProjectId;
    let cancelled = false;
    setDrawings(LOADING);
    setDrc(LOADING);
    setMatrix(LOADING);

    api
      .listDrawings(projectId)
      .then(async (list) => {
        if (cancelled) return;
        setDrawings({ state: "ready", data: list });
        const results = await Promise.allSettled(list.map((drawing) => api.getDrawingDrc(drawing.id)));
        if (cancelled) return;
        const summary: DrcSummary = { errors: 0, warnings: 0, flagged: [], unavailable: 0 };
        results.forEach((result, index) => {
          if (result.status === "rejected") {
            summary.unavailable += 1;
            return;
          }
          const { error, warning } = result.value.counts;
          summary.errors += error;
          summary.warnings += warning;
          if (error || warning) summary.flagged.push({ number: list[index].number, errors: error, warnings: warning });
        });
        summary.flagged.sort((a, b) => b.errors - a.errors || b.warnings - a.warnings);
        setDrc({ state: "ready", data: summary });
      })
      .catch((caught) => {
        if (cancelled) return;
        setDrawings(failure(caught));
        setDrc(failure(caught));
      });

    api
      .getVerificationMatrix(projectId)
      .then((next) => {
        if (!cancelled) setMatrix({ state: "ready", data: next });
      })
      .catch((caught) => {
        if (!cancelled) setMatrix(failure(caught));
      });

    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  const lifecycles = useMemo(() => tally(parts.map((part) => part.lifecycle_status || "draft")), [parts]);

  if (!selectedProject) {
    return (
      <PageLayout title="Dashboard" description="Project overview">
        <section className="grid">
          <Panel title="No project selected">
            <p className="hint">
              Pick a project with the switcher in the sidebar, or <Link to="/systems">create one on the Systems page</Link>.
            </p>
          </Panel>
        </section>
      </PageLayout>
    );
  }

  return (
    <PageLayout title="Dashboard" description={`Overview of ${selectedProject.name}`}>
      <section className="dashboardGrid">
        <DashboardCard
          to="/drafting"
          title="Drawings"
          data={drawings}
          value={(list) => list.length}
          detail={(list) => (list.length ? "by status" : "No drawings yet; create one on the Drafting page.")}
          breakdown={(list) => tally(list.map((drawing) => drawing.status || "working")).map(([status, count]) => (
            <li key={status}><span>{humanize(status)}</span><strong>{count}</strong></li>
          ))}
        />
        <DashboardCard
          to="/drafting"
          title="Design checks"
          tone={(summary) => (summary.errors ? "bad" : summary.warnings ? "warn" : "good")}
          data={drc}
          value={(summary) => summary.errors}
          detail={(summary) =>
            `open error${summary.errors === 1 ? "" : "s"} · ${summary.warnings} warning${summary.warnings === 1 ? "" : "s"}` +
            (summary.unavailable ? ` · ${summary.unavailable} drawing(s) unchecked` : "")
          }
          breakdown={(summary) => summary.flagged.slice(0, 4).map((entry) => (
            <li key={entry.number}><span className="mono">{entry.number}</span><strong>{entry.errors} E · {entry.warnings} W</strong></li>
          ))}
        />
        <DashboardCard
          to="/requirements"
          title="Unverified requirements"
          tone={(next) => (next.rows.some(isUnverified) || next.rows.some((row) => row.verdict === "fail") ? "warn" : "good")}
          data={matrix}
          value={(next) => next.rows.filter(isUnverified).length}
          detail={(next) => `of ${next.rows.length} requirement${next.rows.length === 1 ? "" : "s"} have no check or trace link`}
          breakdown={(next) => tally(next.rows.map((row) => row.verdict)).map(([verdict, count]) => (
            <li key={verdict}><span>{humanize(verdict)}</span><strong>{count}</strong></li>
          ))}
        />
        <DashboardCard
          to="/parts"
          title="Parts"
          data={{ state: "ready", data: parts }}
          value={(list) => list.length}
          detail={(list) => (list.length ? "in the catalog, by lifecycle" : "The catalog is empty.")}
          breakdown={() => lifecycles.map(([lifecycle, count]) => (
            <li key={lifecycle}><span>{humanize(lifecycle)}</span><strong>{count}</strong></li>
          ))}
        />
        <DashboardCard
          to="/systems"
          title="Fluid systems"
          data={{ state: "ready", data: systems }}
          value={(list) => list.length}
          detail={(list) => (list.length ? `working in ${selectedSystem?.name ?? "—"}` : "No systems yet.")}
        />
      </section>
    </PageLayout>
  );
}

function DashboardCard<T>({
  to,
  title,
  data,
  value,
  detail,
  breakdown,
  tone
}: {
  to: string;
  title: string;
  data: Loadable<T>;
  value: (data: T) => number;
  detail: (data: T) => string;
  breakdown?: (data: T) => ReactNode[];
  tone?: (data: T) => "good" | "warn" | "bad";
}) {
  const items = data.state === "ready" ? breakdown?.(data.data) ?? [] : [];
  const toneClass = data.state === "ready" && tone ? ` dashCard-${tone(data.data)}` : "";
  return (
    <Link className={`summaryCard dashCard${toneClass}`} to={to}>
      <span>{title}</span>
      {data.state === "ready" ? (
        <>
          <strong>{value(data.data)}</strong>
          <p>{detail(data.data)}</p>
          {items.length > 0 && <ul className="dashBreakdown">{items}</ul>}
        </>
      ) : data.state === "loading" ? (
        <p className="hint">Loading…</p>
      ) : (
        <p className="dashCardError" title={data.message}>Could not load.</p>
      )}
    </Link>
  );
}
