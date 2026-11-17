import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReindexResult } from "../types";

const apiMock = vi.hoisted(() => ({ getEngineStatus: vi.fn(), reindexProject: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: apiMock };
});

import { ReindexProjectButton, reindexSummary } from "./ReindexProjectButton";

const done: ReindexResult = { drawings: 1, stale: 2, indexed: 2, skipped: 0, failed: 0, errors: [], stale_sheets: [] };

describe("ReindexProjectButton", () => {
  beforeEach(() => {
    apiMock.getEngineStatus.mockReset();
    apiMock.reindexProject.mockReset();
  });
  afterEach(cleanup);

  it("re-indexes the project on the server and reports the result", async () => {
    apiMock.getEngineStatus.mockResolvedValue({ enabled: true, available: true });
    apiMock.reindexProject.mockResolvedValue(done);
    const notify = vi.fn();
    const onDone = vi.fn();
    render(<ReindexProjectButton projectId="p1" canWrite notify={notify} onDone={onDone} />);
    fireEvent.click(await screen.findByRole("button", { name: "Re-index project" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(done));
    expect(apiMock.reindexProject).toHaveBeenCalledWith("p1");
    expect(notify).toHaveBeenCalledWith("Re-indexed 2 of 2 stale sheets.", false);
  });

  it("is hidden when the server has no engine, for viewers, and when the status cannot be read", async () => {
    apiMock.getEngineStatus.mockResolvedValue({ enabled: false, available: false });
    const first = render(<ReindexProjectButton projectId="p1" canWrite notify={vi.fn()} />);
    await waitFor(() => expect(apiMock.getEngineStatus).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button")).toBeNull();
    first.unmount();

    apiMock.getEngineStatus.mockResolvedValue({ enabled: true, available: true });
    const viewer = render(<ReindexProjectButton projectId="p1" canWrite={false} notify={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
    // A viewer does not even ask.
    expect(apiMock.getEngineStatus).toHaveBeenCalledTimes(1);
    viewer.unmount();

    apiMock.getEngineStatus.mockRejectedValue(new Error("Not Found"));
    render(<ReindexProjectButton projectId="p1" canWrite notify={vi.fn()} />);
    await waitFor(() => expect(apiMock.getEngineStatus).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reports a refused run as an error", async () => {
    apiMock.getEngineStatus.mockResolvedValue({ enabled: true, available: true });
    apiMock.reindexProject.mockRejectedValue(new Error("Server-side re-indexing is not configured"));
    const notify = vi.fn();
    render(<ReindexProjectButton projectId="p1" canWrite notify={notify} />);
    fireEvent.click(await screen.findByRole("button", { name: "Re-index project" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Server-side re-indexing is not configured", true));
  });
});

describe("reindexSummary", () => {
  it("names skipped and failed sheets", () => {
    expect(reindexSummary({ ...done, stale: 0, indexed: 0 })).toEqual({ message: "Nothing to re-index: every sheet index is up to date.", isError: false });
    const failed = reindexSummary({
      ...done,
      stale: 3,
      indexed: 1,
      skipped: 1,
      failed: 1,
      errors: [{ sheet_id: "s", sheet_no: 2, drawing_id: "d", drawing_number: "PID-0007", message: "Engine timed out after 60 s" }]
    });
    expect(failed).toEqual({
      message: "Re-indexed 1 of 3 stale sheets; 1 changed meanwhile and left for their own save; 1 failed (PID-0007 sheet 2: Engine timed out after 60 s).",
      isError: true
    });
  });
});
