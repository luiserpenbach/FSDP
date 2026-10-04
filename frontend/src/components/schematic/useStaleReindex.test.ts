import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useStaleReindex, type ReindexOutcome } from "./useStaleReindex";

type Props = { drawingId: string | null; staleSheetIds: string[]; enabled: boolean };

function deferred() {
  let resolve!: (value: ReindexOutcome) => void;
  const promise = new Promise<ReindexOutcome>((done) => (resolve = done));
  return { promise, resolve };
}

describe("useStaleReindex", () => {
  it("re-indexes stale sheets one at a time and cancels when the drawing changes", async () => {
    const calls: Array<{ sheetId: string; isCancelled: () => boolean; done: ReturnType<typeof deferred> }> = [];
    const reindex = vi.fn((sheetId: string, isCancelled: () => boolean) => {
      const done = deferred();
      calls.push({ sheetId, isCancelled, done });
      return done.promise;
    });
    const { result, rerender } = renderHook((props: Props) => useStaleReindex({ ...props, reindex }), {
      initialProps: { drawingId: "dw1", staleSheetIds: ["a", "b"], enabled: true }
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].sheetId).toBe("a");
    expect(result.current.status).toMatchObject({ running: true, current: "a", remaining: 2 });

    // Sequential: "b" waits until "a" is done.
    await act(async () => calls[0].done.resolve("indexed"));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].sheetId).toBe("b");

    // Switching drawings cancels the run in flight; the new drawing starts its own.
    rerender({ drawingId: "dw2", staleSheetIds: ["c"], enabled: true });
    expect(calls[1].isCancelled()).toBe(true);
    await waitFor(() => expect(calls.map((call) => call.sheetId)).toEqual(["a", "b", "c"]));
    expect(calls[2].isCancelled()).toBe(false);
    await act(async () => calls[1].done.resolve("skipped"));
    await act(async () => calls[2].done.resolve("indexed"));
    await waitFor(() => expect(result.current.status.running).toBe(false));
    expect(reindex).toHaveBeenCalledTimes(3);
  });

  it("does nothing while disabled, tries each sheet once, and retries on request", async () => {
    const reindex = vi.fn(async (sheetId: string): Promise<ReindexOutcome> => {
      if (sheetId === "bad") throw new Error("boom");
      return "skipped";
    });
    const { result, rerender } = renderHook((props: Props) => useStaleReindex({ ...props, reindex }), {
      initialProps: { drawingId: "dw1", staleSheetIds: ["bad", "open"], enabled: false }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reindex).not.toHaveBeenCalled();

    rerender({ drawingId: "dw1", staleSheetIds: ["bad", "open"], enabled: true });
    await waitFor(() => expect(result.current.status.failed).toEqual(["bad"]));
    expect(reindex).toHaveBeenCalledTimes(2);
    // Still listed as stale, but not retried on every render.
    rerender({ drawingId: "dw1", staleSheetIds: ["bad", "open"], enabled: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reindex).toHaveBeenCalledTimes(2);

    act(() => result.current.reindexNow(["open"]));
    await waitFor(() => expect(reindex).toHaveBeenCalledTimes(3));
    expect(reindex.mock.calls[2][0]).toBe("open");
  });
});
