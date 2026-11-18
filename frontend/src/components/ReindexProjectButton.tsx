import { useEffect, useState } from "react";
import { api } from "../api";
import type { ReindexResult } from "../types";

/** One-line summary of a server-side re-index run, for a toast. */
export function reindexSummary(result: ReindexResult): { message: string; isError: boolean } {
  if (!result.stale) return { message: "Nothing to re-index: every sheet index is up to date.", isError: false };
  const parts = [`Re-indexed ${result.indexed} of ${result.stale} stale sheet${result.stale === 1 ? "" : "s"}`];
  if (result.skipped) parts.push(`${result.skipped} changed meanwhile and left for their own save`);
  if (result.failed) {
    const first = result.errors[0];
    const where = first ? ` (${first.drawing_number} sheet ${first.sheet_no}: ${first.message})` : "";
    parts.push(`${result.failed} failed${where}`);
  }
  return { message: `${parts.join("; ")}.`, isError: result.failed > 0 };
}

/**
 * "Re-index project" for writers: asks the server to refresh every stale sheet
 * index and DRC of the project with its own engine (POST /projects/{id}/reindex).
 * Renders nothing for viewers, or when the server reports that it has no engine
 * (GET /engine/status); sheets are then re-indexed by opening them in Drafting.
 */
export function ReindexProjectButton({
  projectId,
  canWrite,
  notify,
  onDone
}: {
  projectId: string | null;
  canWrite: boolean;
  notify: (message: string, isError?: boolean) => void;
  /** Called after a run, whatever it did, so the caller can reload what it shows. */
  onDone?: (result: ReindexResult) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!canWrite) return;
    let cancelled = false;
    // Any failure (an older server without the endpoint included) hides the action.
    Promise.resolve()
      .then(() => api.getEngineStatus())
      .then((status) => {
        if (!cancelled) setEnabled(Boolean(status?.enabled));
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canWrite]);

  if (!enabled || !canWrite || !projectId) return null;

  async function run() {
    if (!projectId) return;
    setRunning(true);
    try {
      const result = await api.reindexProject(projectId);
      const { message, isError } = reindexSummary(result);
      notify(message, isError);
      onDone?.(result);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Re-index failed.", true);
    } finally {
      setRunning(false);
    }
  }

  return (
    <button type="button" className="linkButton" disabled={running} onClick={run} title="Refresh the stale sheet indexes and design rule checks of this project on the server">
      {running ? "Re-indexing…" : "Re-index project"}
    </button>
  );
}
