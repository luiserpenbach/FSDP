import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { SearchHit } from "../types";
import { CommandPalette, isPaletteShortcut } from "./CommandPalette";

function hit(patch: Partial<SearchHit>): SearchHit {
  return {
    kind: "tag",
    id: "row-1",
    title: "HV-1042",
    subtitle: "Ball valve · DWG-0001 sheet 1",
    status: "draft",
    project_id: "p1",
    project_name: "Booster",
    system_id: null,
    drawing_id: "d1",
    sheet_id: "s1",
    item_id: "sym-1",
    ...patch
  };
}

const HITS = [hit({}), hit({ kind: "part", id: "part-1", title: "VLV-1042-A", subtitle: "Cryo ball valve", project_id: null, project_name: null, drawing_id: null, sheet_id: null, item_id: null })];

async function type(text: string) {
  fireEvent.change(screen.getByLabelText("Search everything"), { target: { value: text } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders nothing while closed", () => {
    render(<CommandPalette open={false} projectId="p1" onClose={() => {}} onOpenHit={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("searches after a pause and opens the chosen hit with the keyboard", async () => {
    const search = vi.spyOn(api, "search").mockResolvedValue({ query: "1042", hits: HITS });
    const onOpenHit = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open projectId="p1" onClose={onClose} onOpenHit={onOpenHit} />);

    await type("1");
    expect(search).not.toHaveBeenCalled();

    await type("1042");
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).toBe("1042");
    expect(search.mock.calls[0][1]?.projectId).toBe("p1");
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false"]);

    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(onOpenHit).toHaveBeenCalledWith(HITS[1]);
    expect(onClose).toHaveBeenCalled();
  });

  it("wraps around the list and opens a hit on click", async () => {
    vi.spyOn(api, "search").mockResolvedValue({ query: "1042", hits: HITS });
    const onOpenHit = vi.fn();
    render(<CommandPalette open projectId="p1" onClose={() => {}} onOpenHit={onOpenHit} />);
    await type("1042");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getAllByRole("option")[0]);
    expect(onOpenHit).toHaveBeenCalledWith(HITS[0]);
  });

  it("only sends the last query of a burst of typing", async () => {
    const search = vi.spyOn(api, "search").mockResolvedValue({ query: "", hits: [] });
    render(<CommandPalette open projectId="p1" onClose={() => {}} onOpenHit={() => {}} />);
    const input = screen.getByLabelText("Search everything");
    fireEvent.change(input, { target: { value: "HV" } });
    fireEvent.change(input, { target: { value: "HV-1" } });
    await type("HV-10");
    expect(search.mock.calls.map((call) => call[0])).toEqual(["HV-10"]);
    expect(screen.getByRole("status").textContent).toContain('Nothing matches "HV-10"');
  });

  it("reports a failed search and closes on Escape", async () => {
    vi.spyOn(api, "search").mockRejectedValue(new Error("offline"));
    const onClose = vi.fn();
    render(<CommandPalette open projectId="" onClose={onClose} onOpenHit={() => {}} />);
    await type("valve");
    expect(screen.getByRole("status").textContent).toContain("Search failed");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("marks hits from other projects and released drawings", async () => {
    vi.spyOn(api, "search").mockResolvedValue({ query: "hv", hits: [hit({ project_id: "p2", project_name: "Ship", status: "released" })] });
    render(<CommandPalette open projectId="p1" onClose={() => {}} onOpenHit={() => {}} />);
    await type("hv");
    expect(screen.getByText("Ship").className).toContain("elsewhere");
    expect(screen.getByText("released")).toBeTruthy();
  });
});

describe("isPaletteShortcut", () => {
  it("matches Ctrl+K and Cmd+K only", () => {
    expect(isPaletteShortcut(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }))).toBe(true);
    expect(isPaletteShortcut(new KeyboardEvent("keydown", { key: "K", metaKey: true }))).toBe(true);
    expect(isPaletteShortcut(new KeyboardEvent("keydown", { key: "k" }))).toBe(false);
    expect(isPaletteShortcut(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});
