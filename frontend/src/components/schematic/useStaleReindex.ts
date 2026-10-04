/**
 * Background re-indexing of stale sheets.
 *
 * A sheet's stored index and DRC go stale when its document changes without
 * them (conversion, a new sheet with content, a part or requirement change on
 * the server). Lists, BoMs, the verification matrix, and release all read the
 * stored rows, so the drafting page re-derives them in the background: one
 * sheet at a time, abandoned when the drawing changes or editing is disabled.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** What re-indexing one sheet did: wrote the index, left it (open with unsaved edits), or nothing to do. */
export type ReindexOutcome = "indexed" | "skipped";

export type ReindexStatus = {
  running: boolean;
  /** Sheet being re-indexed now. */
  current: string | null;
  /** Sheets still to do in this run, including `current`. */
  remaining: number;
  /** Sheets whose re-index failed (left stale; "Re-index now" retries them). */
  failed: string[];
};

const IDLE: ReindexStatus = { running: false, current: null, remaining: 0, failed: [] };

type Run = {
  drawingId: string;
  cancelled: boolean;
  running: boolean;
  /** Sheets this run has tried; each is tried once unless "Re-index now" asks again. */
  attempted: Set<string>;
  failed: Set<string>;
  /** Sheets "Re-index now" asked for even if the drawing does not list them as stale yet. */
  forced: Set<string>;
};

export function useStaleReindex({
  drawingId,
  staleSheetIds,
  enabled,
  reindex
}: {
  drawingId: string | null;
  /** Stale sheets of the drawing, as the server last reported them. */
  staleSheetIds: string[];
  /** Off for released drawings and viewers. */
  enabled: boolean;
  /** Re-derive and store one sheet; check `isCancelled()` before writing. */
  reindex: (sheetId: string, isCancelled: () => boolean) => Promise<ReindexOutcome>;
}): { status: ReindexStatus; reindexNow: (sheetIds?: string[]) => void } {
  const [status, setStatus] = useState<ReindexStatus>(IDLE);
  const reindexRef = useRef(reindex);
  const staleRef = useRef(staleSheetIds);
  const runRef = useRef<Run | null>(null);
  const staleKey = staleSheetIds.join(",");

  useEffect(() => {
    reindexRef.current = reindex;
  }, [reindex]);

  const pump = useCallback(async (run: Run) => {
    if (run.running) return;
    run.running = true;
    const pending = () => [...new Set([...staleRef.current, ...run.forced])].filter((id) => !run.attempted.has(id));
    try {
      while (!run.cancelled) {
        const next = pending()[0];
        if (!next) break;
        run.attempted.add(next);
        run.forced.delete(next);
        run.failed.delete(next);
        setStatus({ running: true, current: next, remaining: pending().length + 1, failed: [...run.failed] });
        try {
          await reindexRef.current(next, () => run.cancelled);
        } catch {
          if (!run.cancelled) run.failed.add(next);
        }
      }
    } finally {
      run.running = false;
      if (!run.cancelled) setStatus({ ...IDLE, failed: [...run.failed] });
    }
  }, []);

  useEffect(() => {
    staleRef.current = staleSheetIds;
    const current = runRef.current;
    if (!enabled || !drawingId) {
      if (current) current.cancelled = true;
      runRef.current = null;
      setStatus(IDLE);
      return;
    }
    let run = current;
    if (!run || run.drawingId !== drawingId || run.cancelled) {
      if (run) run.cancelled = true;
      run = { drawingId, cancelled: false, running: false, attempted: new Set(), failed: new Set(), forced: new Set() };
      runRef.current = run;
      setStatus(IDLE);
    }
    // A running pump picks up newly stale sheets from `staleRef` on its next turn.
    void pump(run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawingId, enabled, staleKey, pump]);

  // Abandon the run when the page goes away.
  useEffect(
    () => () => {
      if (runRef.current) runRef.current.cancelled = true;
    },
    []
  );

  const reindexNow = useCallback(
    (sheetIds?: string[]) => {
      const run = runRef.current;
      if (!run) return;
      for (const id of sheetIds ?? staleRef.current) {
        run.attempted.delete(id);
        run.failed.delete(id);
        run.forced.add(id);
      }
      void pump(run);
    },
    [pump]
  );

  return { status, reindexNow };
}
